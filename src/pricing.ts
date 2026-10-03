import type { ClaudeUsage } from "./types";

/** USD per 1M tokens. */
export interface ModelPrice {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

// Anthropic list prices cached 2026-09-25; cacheWrite assumes the 5-minute cache write rate of 1.25x input — verify against the pricing page.
export const PRICES: Record<string, ModelPrice> = {
	"claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
	"claude-sonnet-5-5": {
		input: 2,
		output: 10,
		cacheRead: 0.2,
		cacheWrite: 2.5,
	},
	"claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
	"claude-fable-5-1": {
		input: 10,
		output: 50,
		cacheRead: 0.25,
		cacheWrite: 12.5,
	},
};

/** USD cost of one request; null if the model isn't in PRICES. */
export function costUsd(model: string, usage: ClaudeUsage): number | null {
	const p = Object.hasOwn(PRICES, model) ? PRICES[model] : undefined;
	if (!p) return null;
	return (
		(usage.input_tokens * p.input +
			usage.output_tokens * p.output +
			usage.cache_read_input_tokens * p.cacheRead +
			usage.cache_creation_input_tokens * p.cacheWrite) /
		1_000_000
	);
}
