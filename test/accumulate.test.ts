import { expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { accumulateMessage } from "../src/upstream/accumulate";
import { messageToSseEvents } from "../src/upstream/sse";

const usage = {
	input_tokens: 10,
	output_tokens: 5,
	cache_creation_input_tokens: 0,
	cache_read_input_tokens: 3,
};
const message = {
	id: "msg_1",
	type: "message",
	role: "assistant",
	model: "claude-haiku-4-5",
	content: [
		{ type: "text", text: "Hello" },
		{ type: "text", text: "World" },
	],
	stop_reason: "end_turn",
	stop_sequence: null,
	usage,
} as unknown as Anthropic.Beta.Messages.BetaMessage;
const events = (m: Anthropic.Beta.Messages.BetaMessage) =>
	messageToSseEvents(m).map((e) => e.data as { type: string });

test("rebuilds the original message", () => {
	expect(accumulateMessage(events(message))).toEqual(message);
});

test("incomplete stream returns null", () => {
	expect(accumulateMessage(events(message).slice(0, -1))).toBeNull();
	expect(accumulateMessage([])).toBeNull();
});

test("tool_use block returns null", () => {
	const m = {
		...message,
		stop_reason: "tool_use",
		content: [{ type: "tool_use", id: "t1", name: "f", input: { a: 1 } }],
	} as unknown as Anthropic.Beta.Messages.BetaMessage;
	expect(accumulateMessage(events(m))).toBeNull();
});
