import { expect, test } from "bun:test";
import type { ClaudeResult, RunClaude } from "../eval/lib/claude";
import { ClaudeError, parseCliOutput } from "../eval/lib/claude";
import {
	judgeAnswer,
	mapVerdict,
	parseVerdict,
	setupIsA,
} from "../eval/lib/judge";

const res = (text: string): ClaudeResult => ({
	text,
	model: "claude-fable-5-1",
	usage: {
		input_tokens: 1,
		output_tokens: 1,
		cache_read_input_tokens: 0,
		cache_creation_input_tokens: 0,
	},
	costUsd: 0.01,
	durationMs: 1,
	stopReason: "end_turn",
	raw: {},
});
const base = { id: 81, setup: "v1", question: "q", timeoutMs: 1 };

test("identical answers tie without a judge call", async () => {
	let calls = 0;
	const rc: RunClaude = async () => {
		calls++;
		return res("{}");
	};
	const j = await judgeAnswer(rc, { ...base, baseline: "x", candidate: "x" });
	expect(calls).toBe(0);
	expect(j.win).toBe(0.5);
	expect(j.judge).toBeNull();
});

test("A/B order is deterministic per (question, setup) and both orders occur", () => {
	expect(setupIsA(81, "v1")).toBe(setupIsA(81, "v1"));
	const seen = new Set<boolean>();
	for (let id = 81; id < 120; id++) seen.add(setupIsA(id, "v2"));
	expect(seen.size).toBe(2);
});

test("verdict mapping", () => {
	expect(mapVerdict("A", true)).toEqual({ win: 1, bothBad: 0 });
	expect(mapVerdict("A", false)).toEqual({ win: 0, bothBad: 0 });
	expect(mapVerdict("B", false)).toEqual({ win: 1, bothBad: 0 });
	expect(mapVerdict("tie", true)).toEqual({ win: 0.5, bothBad: 0 });
	expect(mapVerdict("both_bad", true)).toEqual({ win: 0.5, bothBad: 1 });
});

test("judge prompt hides which answer is the reference and maps verdict", async () => {
	let prompt = "";
	const rc: RunClaude = async (c) => {
		prompt = c.prompt;
		return res('Sure: {"verdict":"A","reason":"r"}');
	};
	const j = await judgeAnswer(rc, {
		...base,
		baseline: "BASE",
		candidate: "CAND",
	});
	expect(prompt).not.toMatch(/baseline|reference/i);
	expect(j.win).toBe(j.setupIsA ? 1 : 0);
});

test("malformed judge output throws", () => {
	expect(() => parseVerdict("no json")).toThrow();
	expect(() => parseVerdict('{"verdict":"C"}')).toThrow();
});

test("served-model mismatch throws", () => {
	const out = (m: string) =>
		JSON.stringify({
			result: "ok",
			is_error: false,
			modelUsage: { [m]: { inputTokens: 5, outputTokens: 5 } },
		});
	expect(
		parseCliOutput(out("claude-opus-5-5"), { model: "claude-opus-5-5" }).model,
	).toBe("claude-opus-5-5");
	expect(() =>
		parseCliOutput(out("claude-sonnet-5-5"), { model: "claude-opus-5-5" }),
	).toThrow(ClaudeError);
});
