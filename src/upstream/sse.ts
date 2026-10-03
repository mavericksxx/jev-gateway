import type Anthropic from "@anthropic-ai/sdk";

type Block = Anthropic.Beta.Messages.BetaContentBlock;

/** The Messages API streaming event sequence for an already-complete message. */
export function messageToSseEvents(
	msg: Anthropic.Beta.Messages.BetaMessage,
): Array<{ type: string; data: unknown }> {
	const events: Array<{ type: string; data: unknown }> = [];
	const push = (data: { type: string; [k: string]: unknown }) =>
		events.push({ type: data.type, data });
	push({
		type: "message_start",
		message: {
			...msg,
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { ...msg.usage, output_tokens: 1 },
		},
	});
	msg.content.forEach((block: Block, index) => {
		let start: unknown = block;
		const deltas: unknown[] = [];
		if (block.type === "text") {
			start = { ...block, text: "" };
			deltas.push({ type: "text_delta", text: block.text });
		} else if (block.type === "thinking") {
			start = { ...block, thinking: "", signature: "" };
			deltas.push(
				{ type: "thinking_delta", thinking: block.thinking },
				{ type: "signature_delta", signature: block.signature },
			);
		} else if (block.type === "tool_use") {
			start = { ...block, input: {} };
			deltas.push({
				type: "input_json_delta",
				partial_json: JSON.stringify(block.input),
			});
		}
		push({ type: "content_block_start", index, content_block: start });
		for (const delta of deltas) {
			push({ type: "content_block_delta", index, delta });
		}
		push({ type: "content_block_stop", index });
	});
	push({
		type: "message_delta",
		delta: { stop_reason: msg.stop_reason, stop_sequence: msg.stop_sequence },
		usage: { output_tokens: msg.usage.output_tokens },
	});
	push({ type: "message_stop" });
	return events;
}
