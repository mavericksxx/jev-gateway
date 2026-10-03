import { expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeCall, ClaudeResult, RunClaude } from "../eval/lib/claude";
import { JUDGE_SINGLE_SYSTEM, JUDGE_VERSION } from "../eval/lib/judge";
import { type Deps, runAll } from "../eval/lib/runner";
import { median, type Row, summarizeVariant } from "../eval/summarize";
import type { RouteDecision } from "../src/types";

const usage = {
	input_tokens: 10,
	output_tokens: 20,
	cache_read_input_tokens: 0,
	cache_creation_input_tokens: 0,
};
const route = (tier: string): RouteDecision =>
	({
		tier,
		reason: "jev",
		confidence: 0.9,
		probabilities: null,
		jevLatencyMs: 5,
		jevCostUsd: 0.001,
		error: null,
	}) as RouteDecision;

function setup(
	tier: string,
	pass: number | null,
	answerFor?: (c: ClaudeCall) => string,
) {
	const calls: ClaudeCall[] = [];
	const runClaude: RunClaude = async (c) => {
		calls.push(c);
		const isJudge = c.model === "claude-fable-5-1";
		const text = isJudge
			? c.system === JUDGE_SINGLE_SYSTEM
				? '{"acceptable":true,"reason":"single"}'
				: '{"verdict":"A","acceptable":{"A":true,"B":true},"reason":"ok"}'
			: (answerFor?.(c) ?? `ans-${c.model}-${c.effort ?? "none"}`);
		return {
			text,
			model: c.model,
			usage,
			costUsd: c.model.includes("haiku") ? 0.01 : 0.1,
			durationMs: 1000,
			stopReason: "end_turn",
			raw: {},
		} satisfies ClaudeResult;
	};
	let cascades = 0;
	const outDir = mkdtempSync(join(tmpdir(), "eval-test-"));
	const deps: Deps = {
		runClaude,
		route: async () => route(tier),
		cascade: async () => {
			cascades++;
			return {
				passProbability: pass,
				jevCostUsd: 0.002,
				jevLatencyMs: 3,
				error: null,
			};
		},
		outDir,
		timeoutMs: 1000,
	};
	return { calls, deps, outDir, cascades: () => cascades };
}
// biome-ignore lint/suspicious/noExplicitAny: test rows are loosely typed
type AnyRow = Record<string, any>;
const Q = [{ id: 81, category: "writing", prompt: "hello" }];
const rows = (dir: string, v: string): AnyRow[] =>
	readFileSync(join(dir, v, "results.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));

test("opus-medium route reuses baseline answer; ties without judge; rows complete", async () => {
	const s = setup("opus-medium", 0.9);
	await runAll(Q, s.deps, 1);
	const opus = s.calls.filter((c) => c.model === "claude-opus-5-5");
	expect(opus.map((c) => c.effort).sort()).toEqual(["low", "medium"]);
	const v2 = rows(s.outDir, "v2")[0] as AnyRow;
	expect(v2.meta.reused).toBe(true);
	expect(v2.meta.judge_version).toBe(JUDGE_VERSION);
	// identical to baseline: no judge call, acceptability copied from the baseline answer
	expect(v2.judge_usage).toBeNull();
	expect(v2.grade).toEqual({ acceptable: 1, win: 0.5, both_bad: 0 });
	for (const k of [
		"prompt_id",
		"prompt",
		"tags",
		"model",
		"usage",
		"cost_usd",
		"latency_s",
		"status",
		"stop_reason",
		"grade",
		"explanation",
		"judge_model",
		"judge_usage",
		"judge_cost_usd",
		"meta",
	]) {
		expect(k in v2).toBe(true);
	}
	expect(existsSync(join(s.outDir, "v2", "traces", "81_rep0.json"))).toBe(true);
	expect(rows(s.outDir, "baseline")[0]?.grade).toEqual({
		acceptable: 1,
		win: 0.5,
		both_bad: 0,
	});
	expect(s.calls.filter((c) => c.system === JUDGE_SINGLE_SYSTEM)).toHaveLength(
		0,
	);
});

test("baseline acceptability is the mean across judged comparisons", async () => {
	const s = setup("opus-low", 0.3);
	const orig = s.deps.runClaude;
	let n = 0;
	s.deps.runClaude = async (c) => {
		const r = await orig(c);
		if (c.model !== "claude-fable-5-1") return r;
		// alternate the baseline's verdict per judged comparison (v1, v2, v3 all differ from baseline)
		const baseOk = n++ % 2 === 0;
		const isA =
			c.prompt.indexOf("ans-claude-opus-5-5-medium") <
			c.prompt.indexOf("<answer_b>");
		const acc = isA ? { A: baseOk, B: true } : { A: true, B: baseOk };
		return {
			...r,
			text: JSON.stringify({ verdict: "tie", acceptable: acc, reason: "r" }),
		};
	};
	await runAll(Q, s.deps, 1);
	expect(n).toBe(3);
	const b = rows(s.outDir, "baseline")[0] as AnyRow;
	expect(b.grade.acceptable).toBeCloseTo(2 / 3);
	expect(b.explanation).toContain("2/3");
	for (const v of ["v1", "v2", "v3"]) {
		expect(rows(s.outDir, v)[0]?.grade.acceptable).toBe(1);
	}
	expect(s.calls.filter((c) => c.system === JUDGE_SINGLE_SYSTEM)).toHaveLength(
		0,
	);
});

test("single-answer acceptability call only when nothing was judged", async () => {
	// every setup produces the baseline text: no comparison is judged
	const s = setup("opus-medium", 0.9, () => "same");
	await runAll(Q, s.deps, 1);
	const single = s.calls.filter((c) => c.system === JUDGE_SINGLE_SYSTEM);
	expect(single).toHaveLength(1);
	expect(single[0]?.prompt).toContain("same");
	expect(s.calls.filter((c) => c.model === "claude-fable-5-1")).toHaveLength(1);
	for (const v of ["baseline", "v1", "v2", "v3"]) {
		const r = rows(s.outDir, v)[0] as AnyRow;
		expect(r.grade).toEqual({ acceptable: 1, win: 0.5, both_bad: 0 });
	}
	expect(rows(s.outDir, "baseline")[0]?.judge_model).toBe("claude-fable-5-1");
	expect(rows(s.outDir, "baseline")[0]?.explanation).toContain("single");
});

test("judge-version bump re-grades old rows without new answer calls or duplicates", async () => {
	const s = setup("opus-low", 0.3);
	await runAll(Q, s.deps, 1);
	const answerCalls = () =>
		s.calls.filter((c) => c.model !== "claude-fable-5-1").length;
	const nAns = answerCalls();
	const nCascade = s.cascades();
	// simulate rows written by an older judge version
	for (const v of ["baseline", "v1", "v2", "v3"]) {
		const p = join(s.outDir, v, "results.jsonl");
		const old = rows(s.outDir, v).map((r) => ({
			...r,
			grade: { win: 0, both_bad: 0 },
			meta: { ...r.meta, judge_version: JUDGE_VERSION - 1 },
		}));
		writeFileSync(p, old.map((r) => `${JSON.stringify(r)}\n`).join(""));
	}
	// drop the cached judgments (not the cascade decision) so the re-grade actually calls the judge
	for (const f of readdirSync(join(s.outDir, "_judgments"))) {
		if (f.includes("__j")) rmSync(join(s.outDir, "_judgments", f));
	}
	const nJudge = s.calls.filter((c) => c.model === "claude-fable-5-1").length;
	await runAll(Q, s.deps, 1);
	expect(answerCalls()).toBe(nAns);
	expect(s.cascades()).toBe(nCascade);
	expect(s.calls.filter((c) => c.model === "claude-fable-5-1").length).toBe(
		nJudge + 3,
	);
	for (const v of ["baseline", "v1", "v2", "v3"]) {
		const rs = rows(s.outDir, v);
		expect(rs).toHaveLength(1);
		expect(rs[0]?.meta.judge_version).toBe(JUDGE_VERSION);
		expect(rs[0]?.grade.acceptable).toBeDefined();
	}
});

test("_state.json lists acceptable, then win, then both_bad", async () => {
	const s = setup("opus-low", 0.9);
	await runAll(Q, s.deps, 1);
	const st = JSON.parse(readFileSync(join(s.outDir, "_state.json"), "utf8"));
	expect(st.metrics.map((m: { id: string }) => m.id)).toEqual([
		"acceptable",
		"win",
		"both_bad",
	]);
	for (const m of st.metrics) expect(m.label.length).toBeLessThanOrEqual(14);
});

test("v3 accepts Haiku answer: cost is Haiku only", async () => {
	const s = setup("opus-medium", 0.8);
	await runAll(Q, s.deps, 1);
	const v3 = rows(s.outDir, "v3")[0] as AnyRow;
	expect(v3.model).toBe("claude-haiku-4-5");
	expect(v3.cost_usd).toBeCloseTo(0.01);
	expect(v3.meta.cascade.outcome).toBe("accepted");
	expect(v3.meta.jev_cost_usd).toBeCloseTo(0.003);
});

test("v3 escalates: cost is Haiku + routed answer (reused)", async () => {
	const s = setup("opus-low", 0.3);
	await runAll(Q, s.deps, 1);
	const v3 = rows(s.outDir, "v3")[0] as AnyRow;
	expect(v3.model).toBe("claude-opus-5-5");
	expect(v3.cost_usd).toBeCloseTo(0.11);
	expect(v3.meta.cascade.outcome).toBe("escalated");
	// opus-low answer generated once, shared by v1, v2, v3
	expect(
		s.calls.filter((c) => c.model === "claude-opus-5-5" && c.effort === "low")
			.length,
	).toBe(1);
});

test("haiku route: v3 equals v2 and no cascade call", async () => {
	const s = setup("haiku", 0.9);
	await runAll(Q, s.deps, 1);
	expect(s.cascades()).toBe(0);
	expect(rows(s.outDir, "v3")[0]?.cost_usd).toBe(
		rows(s.outDir, "v2")[0]?.cost_usd,
	);
});

test("resume skips existing rows and makes no new calls", async () => {
	const s = setup("opus-low", 0.9);
	await runAll(Q, s.deps, 1);
	const n = s.calls.length;
	await runAll(Q, s.deps, 1);
	expect(s.calls.length).toBe(n);
	expect(rows(s.outDir, "v1").length).toBe(1);
});

test("malformed judge output goes to errors.jsonl with no row", async () => {
	const s = setup("opus-low", 0.9);
	const orig = s.deps.runClaude;
	s.deps.runClaude = async (c) => {
		const r = await orig(c);
		return c.model === "claude-fable-5-1" ? { ...r, text: "not json" } : r;
	};
	await runAll(Q, s.deps, 1);
	expect(existsSync(join(s.outDir, "v1", "results.jsonl"))).toBe(false);
	expect(readFileSync(join(s.outDir, "v1", "errors.jsonl"), "utf8")).toContain(
		"judge_parse",
	);
});

test("summarize math", () => {
	const mk = (
		win: number,
		bb: number,
		cost: number,
		lat: number,
		extra = {},
		acceptable = 1,
	): Row => ({
		grade: { acceptable, win, both_bad: bb },
		cost_usd: cost,
		judge_cost_usd: 0.5,
		latency_s: lat,
		status: "ok",
		meta: { jev_cost_usd: 0.001, ...extra },
	});
	const s = summarizeVariant([
		mk(1, 0, 1, 1, {
			route: { tier: "haiku" },
			cascade: { outcome: "accepted" },
		}),
		mk(0, 0, 2, 3, {
			route: { tier: "opus-low" },
			cascade: { outcome: "escalated" },
		}),
		mk(0.5, 0, 3, 2, {
			route: { tier: "opus-low" },
			cascade: { outcome: "routed-haiku" },
		}),
		mk(0.5, 1, 4, 10, {}, 0),
	]);
	expect(s.graded).toBe(4);
	expect(s.acceptable_rate).toBe(0.75);
	expect(s.acceptable_count).toBe(3);
	expect(s.cost_per_acceptable_usd).toBeCloseTo(10 / 3);
	// sd = sqrt((3*0.0625 + 0.5625)/3) = 0.5
	expect(s.acceptable_ci95[1] - s.acceptable_rate).toBeCloseTo(
		(1.96 * 0.5) / 2,
	);
	expect(
		summarizeVariant([mk(1, 0, 1, 1, {}, 0)]).cost_per_acceptable_usd,
	).toBeNull();
	expect(s.mean_win).toBeCloseTo(0.5);
	expect([s.wins, s.ties, s.losses, s.both_bad]).toEqual([1, 1, 1, 1]);
	expect(s.answer_cost_usd).toBe(10);
	expect(s.answer_cost_per_question_usd).toBe(2.5);
	expect(s.judge_cost_usd).toBe(2);
	expect(s.median_latency_s).toBe(2.5);
	// sd = sqrt(0.25*... ) = sqrt(((.5)^2+(.5)^2+0+0)/3)
	expect(s.ci95[1] - s.mean_win).toBeCloseTo((1.96 * Math.sqrt(0.5 / 3)) / 2);
	expect(s.tier_mix).toEqual({ haiku: 1, "opus-low": 2 });
	expect(s.cascade_accept_rate).toBe(0.5);
	expect(median([3, 1, 2])).toBe(2);
});
