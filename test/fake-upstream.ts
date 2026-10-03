export interface FakeUpstream {
	url: string;
	requests: Array<{
		path: string;
		headers: Record<string, string>;
		body: unknown;
	}>;
	stop(): void;
}

const usage = {
	input_tokens: 10,
	output_tokens: 5,
	cache_creation_input_tokens: 0,
	cache_read_input_tokens: 3,
};

export function startFakeUpstream(): FakeUpstream {
	const requests: FakeUpstream["requests"] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const u = new URL(req.url);
			const body = (await req.json().catch(() => null)) as {
				model?: string;
				stream?: boolean;
			} | null;
			requests.push({
				path: u.pathname + u.search,
				headers: Object.fromEntries(
					[...req.headers].map(([k, v]) => [k.toLowerCase(), v]),
				),
				body,
			});
			if (u.pathname === "/v1/messages/count_tokens") {
				return Response.json({ input_tokens: 42 });
			}
			if (u.pathname !== "/v1/messages") {
				return new Response("not found", { status: 404 });
			}
			const model = body?.model ?? "";
			if (model === "error-model") {
				return Response.json(
					{
						type: "error",
						error: { type: "invalid_request_error", message: "bad model" },
					},
					{ status: 400 },
				);
			}
			const message = {
				id: "msg_fake",
				type: "message",
				role: "assistant",
				model,
				content: [{ type: "text", text: "Hello" }],
				stop_reason: "end_turn",
				stop_sequence: null,
				usage,
			};
			if (!body?.stream) return Response.json(message);
			const events: Array<[string, unknown]> = [
				[
					"message_start",
					{
						type: "message_start",
						message: {
							...message,
							content: [],
							stop_reason: null,
							usage: { ...usage, output_tokens: 1 },
						},
					},
				],
				[
					"content_block_start",
					{
						type: "content_block_start",
						index: 0,
						content_block: { type: "text", text: "" },
					},
				],
				[
					"content_block_delta",
					{
						type: "content_block_delta",
						index: 0,
						delta: { type: "text_delta", text: "Hello" },
					},
				],
				["content_block_stop", { type: "content_block_stop", index: 0 }],
				[
					"message_delta",
					{
						type: "message_delta",
						delta: { stop_reason: "end_turn", stop_sequence: null },
						usage: { output_tokens: 5 },
					},
				],
				["message_stop", { type: "message_stop" }],
			];
			return new Response(
				events
					.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`)
					.join(""),
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	return {
		url: `http://localhost:${server.port}`,
		requests,
		stop: () => server.stop(true),
	};
}
