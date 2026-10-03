import { expect, test } from "bun:test";
import { costUsd } from "../src/pricing";

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
