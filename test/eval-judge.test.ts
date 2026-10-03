import { expect, test } from "bun:test";
import type { ClaudeCall, ClaudeResult, RunClaude } from "../eval/lib/claude";
import { ClaudeError, parseCliOutput } from "../eval/lib/claude";
import {
	JUDGE_SINGLE_SYSTEM,
	judgeAcceptable,
	judgeAnswer,
	judgeSelftest,
	mapVerdict,
	parseAcceptable,
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
	expect(j.acceptable).toBeNull();
	expect(j.baselineAcceptable).toBeNull();
	expect(j.judge).toBeNull();
});

test("parseVerdict requires boolean acceptable for A and B", () => {
	const ok = parseVerdict(
		'{"verdict":"tie","acceptable":{"A":true,"B":false},"reason":"r"}',
	);
	expect(ok).toEqual({
		verdict: "tie",
		acceptable: { A: true, B: false },
		reason: "r",
	});
	expect(() => parseVerdict('{"verdict":"A","reason":"r"}')).toThrow(
		/acceptable/,
	);
	expect(() =>
		parseVerdict('{"verdict":"A","acceptable":{"A":"yes","B":true}}'),
	).toThrow(/acceptable/);
	expect(() => parseVerdict('{"verdict":"A","acceptable":{"A":true}}')).toThrow(
		/acceptable/,
	);
	expect(() => parseVerdict('{"verdict":"A","acceptable":true}')).toThrow(
		/acceptable/,
	);
});

test("parseAcceptable requires a boolean", () => {
	expect(parseAcceptable('ok {"acceptable":false,"reason":"bad"}')).toEqual({
		acceptable: false,
		reason: "bad",
	});
	expect(() => parseAcceptable('{"acceptable":"true"}')).toThrow(/acceptable/);
	expect(() => parseAcceptable('{"reason":"x"}')).toThrow(/acceptable/);
});

test("acceptable maps to setup vs baseline in both A/B orders", async () => {
	// find one setup where the candidate is A and one where it is B
	const asA = ["v1", "v2", "v3"].find((v) => setupIsA(81, v)) as string;
	const asB = ["v1", "v2", "v3"].find((v) => !setupIsA(81, v)) as string;
	expect(asA).toBeDefined();
	expect(asB).toBeDefined();
	const rc: RunClaude = async () =>
		res('{"verdict":"tie","acceptable":{"A":true,"B":false},"reason":"r"}');
	const jA = await judgeAnswer(rc, {
		...base,
		setup: asA,
		baseline: "BASE",
		candidate: "CAND",
	});
	expect(jA.setupIsA).toBe(true);
	expect(jA.acceptable).toBe(1);
	expect(jA.baselineAcceptable).toBe(0);
	const jB = await judgeAnswer(rc, {
		...base,
		setup: asB,
		baseline: "BASE",
		candidate: "CAND",
	});
	expect(jB.setupIsA).toBe(false);
	expect(jB.acceptable).toBe(0);
	expect(jB.baselineAcceptable).toBe(1);
});

test("judgeAcceptable uses the single-answer system prompt", async () => {
	const calls: ClaudeCall[] = [];
	const rc: RunClaude = async (c) => {
		calls.push(c);
		return res('{"acceptable":true,"reason":"fine"}');
	};
	const j = await judgeAcceptable(rc, {
		question: "Q?",
		answer: "ANS",
		timeoutMs: 1,
	});
	expect(j.acceptable).toBe(1);
	expect(j.reason).toBe("fine");
	expect(calls[0]?.system).toBe(JUDGE_SINGLE_SYSTEM);
	expect(calls[0]?.prompt).toContain("<answer>\nANS\n</answer>");
});

test("selftest checks win and both acceptability verdicts per bad answer", async () => {
	const rc: RunClaude = async (c) => {
		const goodIsA = c.prompt.indexOf("Paris") < c.prompt.indexOf("<answer_b>");
		return res(
			JSON.stringify({
				verdict: goodIsA ? "A" : "B",
				acceptable: goodIsA ? { A: true, B: false } : { A: false, B: true },
				reason: "r",
			}),
		);
	};
	const out = await judgeSelftest(rc, 1);
	expect(out).toHaveLength(9);
	expect(out.every((r) => r.pass)).toBe(true);
	expect(out.map((r) => r.name)).toContain("empty: bad unacceptable");
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
		return res(
			'Sure: {"verdict":"A","acceptable":{"A":true,"B":true},"reason":"r"}',
		);
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
	expect(() =>
		parseVerdict('{"verdict":"C","acceptable":{"A":true,"B":true}}'),
	).toThrow();
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
