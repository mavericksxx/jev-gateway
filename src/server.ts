import Anthropic from "@anthropic-ai/sdk";
import { type Context, Hono } from "hono";
import type { ClaudeUsage, RequestRecord } from "./types";

export interface AppOptions {
	/** Upstream API root, e.g. "https://api.anthropic.com". */
	upstreamBaseURL: string;
	/** Called once per proxied request after the response has finished. */
	onRecord: (record: RequestRecord) => void;
}

type ErrorBody = { type: "error"; error: { type: string; message: string } };

const errorBody = (type: string, message: string): ErrorBody => ({
	type: "error",
	error: { type, message },
});

export function createApp(opts: AppOptions): Hono {
	const app = new Hono();
	app.get("/health", (c) => c.text("ok"));

	const handle = async (c: Context, endpoint: RequestRecord["endpoint"]) => {
		const startedAt = Date.now();
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>;
		const model = typeof body.model === "string" ? body.model : "";
		const stream = endpoint === "messages" && body.stream === true;
		const record: RequestRecord = {
			id: crypto.randomUUID(),
			startedAt,
			latencyMs: 0,
			endpoint,
			requestedModel: model,
			upstreamModel: model,
			stream,
			status: 200,
			usage: null,
			error: null,
		};
		const finish = () => {
			record.latencyMs = Date.now() - startedAt;
			try {
				opts.onRecord(record);
			} catch {}
		};
		const fail = (status: number, payload: ErrorBody) => {
			record.status = status;
			record.error = payload.error.message;
			finish();
			return c.json(payload, status as 400);
		};
		const toPayload = (err: unknown): [number, ErrorBody] => {
			if (err instanceof Anthropic.APIError && err.status) {
				const e = err.error as ErrorBody | undefined;
				return [
					err.status,
					e?.type === "error" && e.error
						? e
						: errorBody("api_error", err.message),
				];
			}
			const message = err instanceof Error ? err.message : String(err);
			return [502, errorBody("api_error", message)];
		};

		const apiKey = c.req.header("x-api-key") ?? null;
		const auth = c.req.header("authorization");
		const authToken = auth?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
		if (!apiKey && !authToken) {
			return fail(
				401,
				errorBody("authentication_error", "Missing x-api-key or Authorization"),
			);
		}
		const client = new Anthropic({
			apiKey,
			authToken,
			baseURL: opts.upstreamBaseURL,
			maxRetries: 0,
			// An explicit timeout stops the SDK from rejecting long non-streaming
			// requests itself; the client already chose not to stream.
			timeout: 60 * 60 * 1000,
		});
		const beta = c.req.header("anthropic-beta");
		const betas = beta ? beta.split(",").map((s) => s.trim()) : undefined;
		// Body is forwarded as-is, including fields the SDK types don't know.
		const params = { ...body, ...(betas ? { betas } : {}) } as never;

		try {
			if (endpoint === "count_tokens") {
				const res = await client.beta.messages.countTokens(params);
				finish();
				return c.json(res);
			}
			if (!stream) {
				const msg = await client.beta.messages.create(params);
				const u = (msg as Anthropic.Message).usage;
				record.usage = {
					input_tokens: u.input_tokens,
					output_tokens: u.output_tokens,
					cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
					cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
				};
				finish();
				return c.json(msg);
			}
			const controller = new AbortController();
			const upstream = await client.beta.messages.create(params, {
				signal: controller.signal,
			});
			const events = upstream as unknown as AsyncIterable<{
				type: string;
				message?: { usage?: Partial<ClaudeUsage> };
				usage?: Partial<ClaudeUsage>;
			}>;
			const usage: ClaudeUsage = {
				input_tokens: 0,
				output_tokens: 0,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
			};
			record.usage = usage;
			const enc = new TextEncoder();
			const send = (
				ctl: ReadableStreamDefaultController,
				type: string,
				d: unknown,
			) =>
				ctl.enqueue(
					enc.encode(`event: ${type}\ndata: ${JSON.stringify(d)}\n\n`),
				);
			const body$ = new ReadableStream({
				async start(ctl) {
					try {
						for await (const ev of events) {
							const u =
								ev.type === "message_start"
									? ev.message?.usage
									: ev.type === "message_delta"
										? ev.usage
										: undefined;
							if (u) {
								for (const k of Object.keys(usage) as (keyof ClaudeUsage)[]) {
									const v = u[k];
									if (typeof v === "number") usage[k] = v;
								}
							}
							send(ctl, ev.type, ev);
						}
					} catch (err) {
						if (!controller.signal.aborted) {
							const [status, payload] = toPayload(err);
							record.status = status;
							record.error = payload.error.message;
							send(ctl, "error", payload);
						}
					}
					finish();
					try {
						ctl.close();
					} catch {}
				},
				cancel() {
					controller.abort();
				},
			});
			return new Response(body$, {
				headers: {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
				},
			});
		} catch (err) {
			const [status, payload] = toPayload(err);
			return fail(status, payload);
		}
	};

	app.post("/v1/messages", (c) => handle(c, "messages"));
	app.post("/v1/messages/count_tokens", (c) => handle(c, "count_tokens"));
	return app;
}
