import { TypeSafeClient, type Usage } from "@typesafe-ai/sdk";
import { createMockFetch, type MockAnswers } from "./mock-fetch";

/** Jev list price: $0.042 per 1M input tokens; output tokens are free. */
const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

export type JevMode = "live" | "mock";

export interface JevClientOptions {
	mode: JevMode;
	/** Live mode only; falls back to TYPESAFE_API_KEY. */
	apiKey?: string;
	/** Mock mode only: fixed answers by question name. */
	mockAnswers?: MockAnswers;
	timeoutMs?: number;
}

export function createJevClient(opts: JevClientOptions): TypeSafeClient {
	if (opts.mode === "mock") {
		return new TypeSafeClient({
			apiKey: "mock",
			fetch: createMockFetch(opts.mockAnswers),
			retry: { maxRetries: 0 },
		});
	}
	return new TypeSafeClient({
		apiKey: opts.apiKey,
		timeout: opts.timeoutMs,
	});
}

export function jevCostUsd(usage: Usage): number {
	return usage.input_tokens * USD_PER_INPUT_TOKEN;
}
