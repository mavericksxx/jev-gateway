import { expect, test } from "bun:test";
import { costUsd, recordCostUsd } from "../src/pricing";
import type { RequestRecord } from "../src/types";

const usage = {
	input_tokens: 1_000_000,
	output_tokens: 500_000,
	cache_read_input_tokens: 2_000_000,
	cache_creation_input_tokens: 400_000,
};

const cases: [string, number][] = [
	// 1*1 + 0.5*5 + 2*0.10 + 0.4*1.25
	["claude-haiku-4-5", 1 + 2.5 + 0.2 + 0.5],
	// 1*2 + 0.5*10 + 2*0.20 + 0.4*2.5
	["claude-sonnet-5-5", 2 + 5 + 0.4 + 1],
	// 1*4 + 0.5*20 + 2*0.20 + 0.4*5
	["claude-opus-5-5", 4 + 10 + 0.4 + 2],
	// 1*10 + 0.5*50 + 2*0.25 + 0.4*12.5
	["claude-fable-5-1", 10 + 25 + 0.5 + 5],
];

for (const [model, expected] of cases) {
	test(`costUsd ${model}`, () => {
		expect(costUsd(model, usage)).toBeCloseTo(expected, 10);
	});
}

test("unknown model returns null", () => {
	expect(costUsd("claude-nope", usage)).toBeNull();
});

test("zero usage costs 0", () => {
	const zero = {
		input_tokens: 0,
		output_tokens: 0,
		cache_creation_input_tokens: 0,
		cache_read_input_tokens: 0,
	};
	expect(costUsd("claude-haiku-4-5", zero)).toBe(0);
});

const rec = (over: Partial<RequestRecord>): RequestRecord => ({
	id: "x",
	startedAt: 0,
	latencyMs: 0,
	endpoint: "messages",
	requestedModel: "auto",
	upstreamModel: "claude-haiku-4-5",
	stream: false,
	status: 200,
	usage: null,
	error: null,
	...over,
});

test("recordCostUsd: usage only, waste only, both, neither", () => {
	const base = costUsd("claude-haiku-4-5", usage) ?? 0;
	const cascade = {
		firstTier: "haiku",
		escalationTier: "opus-medium",
		accepted: false,
		passProbability: 0.1,
		jevLatencyMs: 1,
		jevCostUsd: null,
		wastedUsage: null,
		wastedCostUsd: 0.5,
		error: null,
	} as const;
	expect(recordCostUsd(rec({ usage }))).toBeCloseTo(base, 10);
	expect(recordCostUsd(rec({ cascade }))).toBe(0.5);
	expect(recordCostUsd(rec({ usage, cascade }))).toBeCloseTo(base + 0.5, 10);
	expect(recordCostUsd(rec({}))).toBeNull();
	expect(
		recordCostUsd(rec({ usage, upstreamModel: "claude-nope", cascade })),
	).toBe(0.5);
});

test("recordCostUsd: cache hit costs 0", () => {
	expect(
		recordCostUsd(
			rec({
				usage,
				cache: {
					outcome: "hit",
					candidates: 1,
					bestSimilarity: 0.9,
					matchProbability: 0.95,
					sourceRequestId: "r",
					jevLatencyMs: 1,
					jevCostUsd: null,
					lookupMs: 1,
					stored: false,
					error: null,
				},
			}),
		),
	).toBe(0);
});
