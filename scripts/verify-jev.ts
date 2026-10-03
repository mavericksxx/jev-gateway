// Phase 0: make a handful of real Jev calls to confirm the API shape, token
// accounting and latency. Saves one request/response pair as a test fixture.
// Cost: ~2k input tokens total, about $0.0001.
import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";
import { jevCostUsd } from "../src/jev/client";

let lastExchange:
	| { request: unknown; response: unknown; status: number }
	| undefined;

const client = new TypeSafeClient({
	retry: { maxRetries: 0 },
	fetch: async (input, init) => {
		const res = await fetch(input, init);
		const text = await res.clone().text();
		lastExchange = {
			request: JSON.parse(String(init?.body)),
			response: JSON.parse(text),
			status: res.status,
		};
		return res;
	},
});

const state = {
	system_prompt_excerpt: "You are a helpful coding assistant.",
	last_user_turn:
		"Refactor this 400-line React component into smaller hooks and explain the tradeoffs.",
	turn_count: 1,
	tool_names: [],
	estimated_input_tokens: 5200,
};

const tier = choice("Which Claude tier should handle this request?", {
	haiku: "Simple lookups, short rewrites, casual chat.",
	sonnet: "Everyday coding and writing of moderate difficulty.",
	opus: "Hard multi-step reasoning, large refactors, subtle bugs.",
});
const difficulty = score("How difficult is this request?", [
	"trivial",
	"easy",
	"moderate",
	"hard",
]);
const needsCode = noul("The answer will need to include code.");

async function timed<T>(fn: () => Promise<T>) {
	const start = performance.now();
	const result = await fn();
	return { result, ms: Math.round(performance.now() - start) };
}

const one = await timed(() =>
	client.systemOne({ state, questions: { needsCode } }),
);
const three = await timed(() =>
	client.systemOne({ state, questions: { tier, difficulty, needsCode } }),
);
const fixture = lastExchange;

const latencies = [one.ms, three.ms];
for (let i = 0; i < 3; i++) {
	const r = await timed(() =>
		client.systemOne({ state, questions: { tier, difficulty, needsCode } }),
	);
	latencies.push(r.ms);
}

await Bun.write(
	"fixtures/jev/verify.json",
	`${JSON.stringify(fixture, null, "\t")}\n`,
);

console.log({
	model: three.result.model,
	inputTokens1Question: one.result.usage.input_tokens,
	inputTokens3Questions: three.result.usage.input_tokens,
	outputTokens3Questions: three.result.usage.output_tokens,
	latenciesMs: latencies,
	answers: three.result.answers,
	approxCostUsd: (
		jevCostUsd(three.result.usage) * 4 +
		jevCostUsd(one.result.usage)
	).toFixed(6),
});
