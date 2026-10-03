/** Token usage as reported by the Anthropic Messages API. */
export interface ClaudeUsage {
	input_tokens: number;
	output_tokens: number;
	cache_creation_input_tokens: number;
	cache_read_input_tokens: number;
}

/** One proxied request, emitted by the server once the upstream response has fully finished. */
export interface RequestRecord {
	/** Gateway-generated id (crypto.randomUUID()). */
	id: string;
	/** Epoch ms when the gateway received the request. */
	startedAt: number;
	/** Ms from receipt until the last byte was sent to the client. */
	latencyMs: number;
	endpoint: "messages" | "count_tokens";
	/** `model` from the client's request body. */
	requestedModel: string;
	/** Model actually sent upstream (equals requestedModel until Phase 2). */
	upstreamModel: string;
	stream: boolean;
	/** Upstream HTTP status, or 502 if the upstream could not be reached. */
	status: number;
	/** Null for count_tokens and for failed requests. */
	usage: ClaudeUsage | null;
	/** Error message for non-2xx or network failures, else null. */
	error: string | null;
}
