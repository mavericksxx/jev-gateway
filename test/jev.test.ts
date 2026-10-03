import { describe, expect, test } from "bun:test";
import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";
import { createJevClient, jevCostUsd } from "../src/jev/client";

const questions = {
	tier: choice("Which tier?", { haiku: null, sonnet: null, opus: null }),
	difficulty: score("How hard?", ["easy", "medium", "hard"]),
	needsCode: noul("Needs code."),
};

describe("mock Jev client", () => {
	test("returns schema-valid default answers", async () => {
		const jev = createJevClient({ mode: "mock" });
		const { answers, usage } = await jev.systemOne({ state: "hi", questions });

		expect(answers.tier.choice).toBe("haiku");
		expect(answers.tier.probabilities).toEqual({
			haiku: 1,
			sonnet: 0,
			opus: 0,
		});
		expect(answers.difficulty.score).toBe(0);
		expect(answers.difficulty.legend).toEqual({
			0: "easy",
			1: "medium",
			2: "hard",
		});
		expect(answers.needsCode.noul).toBe(0.5);
		expect(usage.input_tokens).toBeGreaterThan(0);
	});

	test("applies overrides", async () => {
		const jev = createJevClient({
			mode: "mock",
			mockAnswers: { tier: "opus", difficulty: 2, needsCode: 0.9 },
		});
		const { answers } = await jev.systemOne({ state: "hi", questions });

		expect(answers.tier.choice).toBe("opus");
		expect(answers.difficulty.score).toBe(2);
		expect(answers.needsCode.noul).toBe(0.9);
	});

	test("rejects an override that is not a valid label", async () => {
		const jev = createJevClient({ mode: "mock", mockAnswers: { tier: "gpt" } });
		// APIPromise overrides then(), which bun's `.rejects` doesn't follow; catch instead.
		const err = await jev.systemOne({ state: "hi", questions }).catch((e) => e);
		expect(err).toBeInstanceOf(Error);
		expect(String(err)).toContain('"gpt" is not one of');
	});
});

test("jevCostUsd prices input tokens only", () => {
	expect(
		jevCostUsd({ input_tokens: 1_000_000, output_tokens: 500 }),
	).toBeCloseTo(0.042);
});

describe("recorded live response (fixtures/jev/verify.json)", async () => {
	const fixture = await Bun.file("fixtures/jev/verify.json").json();
	const replay = new TypeSafeClient({
		apiKey: "replay",
		fetch: async () => Response.json(fixture.response),
	});

	test("parses through the SDK", async () => {
		const result = await replay.systemOne(fixture.request);
		expect(result.model).toBe("jev-1.13.0");
		expect(result.answers).toEqual(fixture.response.answers);
		expect(result.usage.input_tokens).toBeGreaterThan(0);
	});

	test("mock answers have the same fields as real ones", async () => {
		const mock = createJevClient({ mode: "mock" });
		const mocked = await mock.systemOne(fixture.request);
		const real = fixture.response.answers as Record<string, object>;
		for (const [name, answer] of Object.entries(mocked.answers)) {
			expect(Object.keys(answer).sort()).toEqual(
				Object.keys(real[name] ?? {}).sort(),
			);
		}
	});
});
