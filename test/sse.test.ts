import { expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { messageToSseEvents } from "../src/upstream/sse";

const message = {
	id: "msg_1",
	type: "message",
	role: "assistant",
	model: "claude-haiku-4-5",
	content: [
		{ type: "thinking", thinking: "hmm", signature: "sig" },
		{ type: "text", text: "Hello there", citations: null },
		{ type: "tool_use", id: "tu_1", name: "calc", input: { a: 1, b: [2] } },
	],
	stop_reason: "tool_use",
	stop_sequence: null,
	usage: {
		input_tokens: 10,
		output_tokens: 7,
		cache_creation_input_tokens: 2,
		cache_read_input_tokens: 3,
	},
} as unknown as Anthropic.Beta.Messages.BetaMessage;

test("SDK parses synthesized stream back into an equal message", async () => {
	const body = messageToSseEvents(message)
		.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`)
		.join("");
	const server = Bun.serve({
		port: 0,
		fetch: () =>
			new Response(body, { headers: { "content-type": "text/event-stream" } }),
	});
	try {
		const client = new Anthropic({
			apiKey: "k",
			baseURL: `http://localhost:${server.port}`,
			maxRetries: 0,
		});
		const final = await client.messages
			.stream({ model: "m", max_tokens: 10, messages: [] })
			.finalMessage();
		// The SDK adds its own parsed_output/stop_details fields.
		expect(final).toMatchObject(message as unknown as Anthropic.Message);
	} finally {
		server.stop(true);
	}
});

test("event order", () => {
	const types = messageToSseEvents(message).map((e) => e.type);
	expect(types[0]).toBe("message_start");
	expect(types.slice(-2)).toEqual(["message_delta", "message_stop"]);
});
