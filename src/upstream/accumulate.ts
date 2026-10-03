import type Anthropic from "@anthropic-ai/sdk";

type Message = Anthropic.Beta.Messages.BetaMessage;
type Ev = { type: string } & Record<string, unknown>;

/** Rebuilds a complete message from Messages API stream events (as the server forwards them). Returns null if the stream didn't complete (no message_stop) or contains non-text content blocks. */
export function accumulateMessage(events: Ev[]): Message | null {
	let msg: Message | null = null;
	let done = false;
	for (const ev of events) {
		if (ev.type === "message_start") {
			const m = ev.message as Message;
			msg = { ...m, content: [], usage: { ...m.usage } };
		} else if (!msg) {
		} else if (ev.type === "content_block_start") {
			const block = ev.content_block as { type: string };
			if (block.type !== "text") return null;
			msg.content[ev.index as number] = block as never;
		} else if (ev.type === "content_block_delta") {
			const block = msg.content[ev.index as number];
			const delta = ev.delta as { type: string; text?: string };
			if (block?.type !== "text" || delta.type !== "text_delta") return null;
			block.text += delta.text ?? "";
		} else if (ev.type === "message_delta") {
			const d = ev.delta as Pick<Message, "stop_reason" | "stop_sequence">;
			msg.stop_reason = d.stop_reason;
			msg.stop_sequence = d.stop_sequence;
			Object.assign(msg.usage, ev.usage);
		} else if (ev.type === "message_stop") {
			done = true;
		}
	}
	return done && msg?.content.every(Boolean) ? msg : null;
}
