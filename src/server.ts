import Anthropic from "@anthropic-ai/sdk";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { type Context, Hono } from "hono";
import type { SemanticCache } from "./cache/cache";
import { isStorable } from "./cache/cache";
import type { CascadeJudge } from "./cascade/judge";
import type { RequestsResponse, StatsResponse } from "./dashboard/types";
import { costUsd } from "./pricing";
import type { Router } from "./routing/router";
import { TIERS, type Tier } from "./routing/tiers";
import type { ToolTrimmer } from "./tools/trim";
import type {
	CascadeAttempt,
	ClaudeUsage,
	RequestRecord,
	RouteDecision,
} from "./types";
import { accumulateMessage } from "./upstream/accumulate";
import { messageToSseEvents } from "./upstream/sse";
import { translateParams } from "./upstream/translate";

export interface AppOptions {
	/** Upstream API root, e.g. "https://api.anthropic.com". */
	upstreamBaseURL: string;
	/** Called once per proxied request after the response has finished. */
	onRecord: (record: RequestRecord) => void;
	/** Enables `model: "auto"` routing. */
	router?: Router;
	/** Builds a Jev client for a caller-supplied `x-jev-key`. Required for BYO keys; tests inject a mock. */
	makeJevClient?: (apiKey: string) => TypeSafeClient;
	/** Cheap-first retry for routed requests; see the x-gateway-cascade header. */
	cascade?: {
		judge: CascadeJudge;
		firstTier: Tier;
		minPass: number;
		defaultOn: boolean;
	};
	/** Drops unlikely tool definitions from requests with many tools; see x-gateway-trim-tools. */
	toolTrim?: { trimmer: ToolTrimmer; defaultOn: boolean };
	/** Semantic answer cache for simple single-turn requests; see x-gateway-cache. */
	cache?: { cache: SemanticCache; defaultOn: boolean };
	/** Serves the savings dashboard and its JSON API (no API key needed). */
	dashboard?: {
		stats: () => StatsResponse;
		requests: (limit: number) => RequestsResponse;
		/** Path of the dashboard HTML file to serve at GET /dashboard. */
		htmlPath: string;
	};
}

type ErrorBody = { type: "error"; error: { type: string; message: string } };

const errorBody = (type: string, message: string): ErrorBody => ({
	type: "error",
	error: { type, message },
});

export function createApp(opts: AppOptions): Hono {
	const app = new Hono();
	app.get("/health", (c) => c.text("ok"));
	const dash = opts.dashboard;
	if (dash) {
		app.get("/", (c) => c.redirect("/dashboard"));
		app.get("/dashboard", async (c) => {
			const file = Bun.file(dash.htmlPath);
			if (!(await file.exists())) return c.text("dashboard not found", 404);
			return c.body(await file.text(), 200, {
				"content-type": "text/html; charset=utf-8",
			});
		});
		app.get("/api/stats", (c) => c.json(dash.stats()));
		app.get("/api/requests", (c) => {
			const n = Number.parseInt(c.req.query("limit") ?? "", 10);
			const limit = Number.isNaN(n) ? 100 : Math.min(1000, Math.max(1, n));
			return c.json(dash.requests(limit));
		});
	}

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
		let routeHeaders: Record<string, string> = {};
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
			return c.json(payload, status as 400, routeHeaders);
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
		let outBody = body;
		let addBetas: string[] = [];
		let cascadeFirst: Tier | null = null;
		let escalationTier: Tier | null = null;
		let jevForJudge: TypeSafeClient | undefined;
		const tt = opts.toolTrim;
		const trimHdr = c.req.header("x-gateway-trim-tools");
		const doTrim =
			!!tt &&
			endpoint === "messages" &&
			(trimHdr === "on" || (trimHdr !== "off" && tt.defaultOn));
		const jevKey = c.req.header("x-jev-key");
		let callerJev: TypeSafeClient | undefined;
		const getCaller = () => {
			if (!callerJev && jevKey && opts.makeJevClient) {
				callerJev = opts.makeJevClient(jevKey);
			}
			return callerJev;
		};
		const jevOpts = () => {
			const jev = getCaller();
			return jev ? { jev } : undefined;
		};
		// Cached answers are scoped to the caller's credential so they never cross callers.
		const tenant = new Bun.CryptoHasher("sha256")
			.update(apiKey ?? authToken ?? "")
			.digest("hex");
		const cc$ = opts.cache;
		const cacheHdr = c.req.header("x-gateway-cache");
		const cacheP =
			cc$ &&
			endpoint === "messages" &&
			(cacheHdr === "on" || (cacheHdr !== "off" && cc$.defaultOn))
				? cc$.cache.lookup(body, { ...jevOpts(), tenant })
				: Promise.resolve(null);
		const trimP =
			doTrim && tt ? tt.trimmer.trim(body, jevOpts()) : Promise.resolve(null);
		const applyTrim = (t: Awaited<typeof trimP>) => {
			if (!t?.record) return;
			record.toolTrim = t.record;
			routeHeaders = {
				...routeHeaders,
				"x-gateway-tools": `${t.record.kept}/${t.record.offered}`,
			};
		};
		const toUsage = (u: Anthropic.Beta.Messages.BetaUsage): ClaudeUsage => ({
			input_tokens: u.input_tokens,
			output_tokens: u.output_tokens,
			cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
			cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
		});
		let cacheRes: Awaited<typeof cacheP> = null;
		if (opts.router && model === "auto") {
			const router = opts.router;
			const routeP = (async (): Promise<RouteDecision | null> => {
				if (endpoint !== "messages") return null;
				if (c.req.header("x-gateway-mode") === "off") {
					return {
						tier: router.defaultTier,
						reason: "fallback",
						confidence: null,
						probabilities: null,
						jevLatencyMs: null,
						jevCostUsd: null,
						error: "routing off",
					};
				}
				return router.route(body, jevOpts());
			})();
			const [decision, trimmed, cached] = await Promise.all([
				routeP,
				trimP,
				cacheP,
			]);
			cacheRes = cached;
			const tier = decision?.tier ?? router.defaultTier;
			({ body: outBody, addBetas } = translateParams(
				trimmed?.body ?? body,
				tier,
			));
			record.upstreamModel = TIERS[tier].model;
			if (decision) record.route = decision;
			const cc = opts.cascade;
			const hdr = c.req.header("x-gateway-cascade");
			const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
			if (
				cc &&
				decision &&
				(hdr === "on" || (hdr !== "off" && cc.defaultOn)) &&
				decision.reason !== "fallback" &&
				!hasTools &&
				TIERS[tier].rank > TIERS[cc.firstTier].rank
			) {
				cascadeFirst = cc.firstTier;
				escalationTier = tier;
				jevForJudge = getCaller();
			}
			routeHeaders = {
				...routeHeaders,
				"x-gateway-tier": tier,
				"x-gateway-model": TIERS[tier].model,
				"x-gateway-decision-id": record.id,
			};
			applyTrim(trimmed);
		} else {
			const [trimmed, cached] = await Promise.all([trimP, cacheP]);
			cacheRes = cached;
			if (trimmed) outBody = trimmed.body;
			applyTrim(trimmed);
		}
		const sseResponse = (msg: Anthropic.Beta.Messages.BetaMessage) =>
			new Response(
				messageToSseEvents(msg)
					.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`)
					.join(""),
				{
					headers: {
						...routeHeaders,
						"content-type": "text/event-stream",
						"cache-control": "no-cache",
					},
				},
			);
		if (cacheRes) {
			record.cache = cacheRes.lookup;
			routeHeaders = {
				...routeHeaders,
				"x-gateway-cache-result": cacheRes.hit ? "hit" : "miss",
			};
			const hit = cacheRes.hit;
			if (hit) {
				record.usage = toUsage(hit.usage);
				record.upstreamModel = hit.model;
				finish();
				return stream ? sseResponse(hit) : c.json(hit, 200, routeHeaders);
			}
		}
		const storeAnswer = (msg: Anthropic.Beta.Messages.BetaMessage | null) => {
			if (!record.cache || !opts.cache || !msg || !isStorable(msg)) return;
			record.cache.stored = true;
			void opts.cache.cache.store(body, msg, record.id, tenant);
		};
		const beta = c.req.header("anthropic-beta");
		const paramsFor = (b: Record<string, unknown>, extra: string[]) => {
			const betas = [
				...new Set([
					...(beta ? beta.split(",").map((s) => s.trim()) : []),
					...extra,
				]),
			];
			// Body is forwarded as-is, including fields the SDK types don't know.
			return { ...b, ...(betas.length ? { betas } : {}) } as never;
		};
		const params = paramsFor(outBody, addBetas);

		try {
			if (endpoint === "count_tokens") {
				const res = await client.beta.messages.countTokens(params);
				finish();
				return c.json(res, 200, routeHeaders);
			}
			if (cascadeFirst && escalationTier && opts.cascade) {
				const cc = opts.cascade;
				const firstModel = TIERS[cascadeFirst].model;
				const attempt: CascadeAttempt = {
					firstTier: cascadeFirst,
					escalationTier,
					accepted: false,
					passProbability: null,
					jevLatencyMs: null,
					jevCostUsd: null,
					wastedUsage: null,
					wastedCostUsd: 0,
					error: null,
				};
				record.cascade = attempt;
				let first: Anthropic.Beta.Messages.BetaMessage | null = null;
				try {
					const t = translateParams({ ...body, stream: false }, cascadeFirst);
					first = (await client.beta.messages.create(
						paramsFor(t.body, t.addBetas),
					)) as Anthropic.Beta.Messages.BetaMessage;
				} catch (err) {
					attempt.error = err instanceof Error ? err.message : String(err);
				}
				if (first) {
					const usage = toUsage(first.usage);
					attempt.wastedUsage = usage;
					attempt.wastedCostUsd = costUsd(firstModel, usage) ?? 0;
					if (
						first.stop_reason === "max_tokens" ||
						first.stop_reason === "refusal"
					) {
						attempt.error = `stop_reason ${first.stop_reason}`;
					} else {
						const j = await cc.judge.judge(body, first, {
							jev: jevForJudge,
						});
						attempt.passProbability = j.passProbability;
						attempt.jevLatencyMs = j.jevLatencyMs;
						attempt.jevCostUsd = j.jevCostUsd;
						attempt.error = j.error;
						if (j.passProbability !== null && j.passProbability >= cc.minPass) {
							attempt.accepted = true;
							attempt.wastedUsage = null;
							attempt.wastedCostUsd = 0;
							record.usage = usage;
							record.upstreamModel = firstModel;
							routeHeaders = {
								...routeHeaders,
								"x-gateway-tier": cascadeFirst,
								"x-gateway-model": firstModel,
								"x-gateway-cascade": "accepted",
							};
							storeAnswer(first);
							if (!stream) {
								finish();
								return c.json(first, 200, routeHeaders);
							}
							const enc = new TextEncoder();
							const sse = messageToSseEvents(first)
								.map(
									(e) =>
										`event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`,
								)
								.join("");
							finish();
							return new Response(enc.encode(sse), {
								headers: {
									...routeHeaders,
									"content-type": "text/event-stream",
									"cache-control": "no-cache",
								},
							});
						}
					}
				}
				routeHeaders = { ...routeHeaders, "x-gateway-cascade": "escalated" };
			}
			if (!stream) {
				const msg = await client.beta.messages.create(params);
				record.usage = toUsage(
					(msg as Anthropic.Beta.Messages.BetaMessage).usage,
				);
				storeAnswer(msg as Anthropic.Beta.Messages.BetaMessage);
				finish();
				return c.json(msg, 200, routeHeaders);
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
			const forwarded: Array<{ type: string } & Record<string, unknown>> = [];
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
							if (cacheRes) forwarded.push(ev);
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
						storeAnswer(accumulateMessage(forwarded));
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
					...routeHeaders,
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
