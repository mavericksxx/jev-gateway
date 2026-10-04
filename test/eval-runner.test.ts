import { expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
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
import {
	type Deps,
	runAll,
	seedFrom,
	tiersFingerprint,
} from "../eval/lib/runner";
import { loadQuestions } from "../eval/run";
import {
	median,
	type Row,
	renderCompare,
	summarizeVariant,
} from "../eval/summarize";
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
	// distinct answers per setup (opus-low, sonnet-low, accepted Haiku) so each is judged separately
	const s = setup("sonnet-low", 0.9);
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
		nJudge + 1, // v1, v2 and v3 share one answer, hence one judgment
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

const FABLE = "claude-fable-5-1";
const judgeCalls = (s: { calls: ClaudeCall[] }) =>
	s.calls.filter((c) => c.model === FABLE).length;

test("route cache: same tiers reuse, changed fingerprint re-routes", async () => {
	const s = setup("opus-low", 0.9);
	let routed = 0;
	s.deps.route = async () => {
		routed++;
		return route("opus-low");
	};
	await runAll(Q, s.deps, 1);
	expect(routed).toBe(1);
	const fp = tiersFingerprint();
	expect(existsSync(join(s.outDir, "_routes", `81__${fp}.json`))).toBe(true);
	expect(rows(s.outDir, "v2")[0]?.meta.tiers_fp).toBe(fp);
	// different offered tiers -> different fingerprint -> routed again, rows rewritten once
	s.deps.offeredTiers = ["haiku", "opus-low"];
	await runAll(Q, s.deps, 1);
	expect(routed).toBe(2);
	expect(rows(s.outDir, "v2")).toHaveLength(1);
	expect(rows(s.outDir, "v2")[0]?.meta.tiers_fp).toBe(
		tiersFingerprint(["haiku", "opus-low"]),
	);
	expect(rows(s.outDir, "v1")).toHaveLength(1);
	// same fingerprint again: skipped
	await runAll(Q, s.deps, 1);
	expect(routed).toBe(2);
	// route cache reused when only judgments are stale
	for (const v of ["v2", "v3"]) {
		const p = join(s.outDir, v, "results.jsonl");
		const old = rows(s.outDir, v).map((r) => ({
			...r,
			meta: { ...r.meta, tiers_fp: "old" },
		}));
		writeFileSync(p, old.map((r) => `${JSON.stringify(r)}\n`).join(""));
	}
	await runAll(Q, s.deps, 1);
	expect(routed).toBe(2);
	expect(rows(s.outDir, "v3")[0]?.meta.tiers_fp).toBe(
		tiersFingerprint(["haiku", "opus-low"]),
	);
});

test("judgment cache is content keyed: shared pair, new answer -> new call", async () => {
	const s = setup("opus-low", 0.3);
	await runAll(Q, s.deps, 1);
	// v1, v2, v3 all answered with the same opus-low text: one comparison judgment
	expect(judgeCalls(s)).toBe(1);
	// wipe rows and change the opus-low answer: new judgment
	for (const v of ["baseline", "v1", "v2", "v3"])
		rmSync(join(s.outDir, v, "results.jsonl"));
	rmSync(join(s.outDir, "_answers", "81__claude-opus-5-5__low.json"));
	const run = s.deps.runClaude;
	s.deps.runClaude = async (c) => {
		const r = await run(c);
		return c.effort === "low" ? { ...r, text: "changed" } : r;
	};
	await runAll(Q, s.deps, 1);
	expect(judgeCalls(s)).toBe(2);
});

test("cascade cache is keyed by the Haiku answer", async () => {
	const s = setup("opus-low", 0.3);
	await runAll(Q, s.deps, 1);
	expect(s.cascades()).toBe(1);
	rmSync(join(s.outDir, "v3", "results.jsonl"));
	await runAll(Q, s.deps, 1);
	expect(s.cascades()).toBe(1);
	rmSync(join(s.outDir, "v3", "results.jsonl"));
	rmSync(join(s.outDir, "_answers", "81__claude-haiku-4-5__none.json"));
	const run = s.deps.runClaude;
	s.deps.runClaude = async (c) => {
		const r = await run(c);
		return c.model.includes("haiku") ? { ...r, text: "new haiku" } : r;
	};
	await runAll(Q, s.deps, 1);
	expect(s.cascades()).toBe(2);
});

test("seedFrom copies answers and judgments, not rows or routes, without overwriting", async () => {
	const a = setup("opus-low", 0.3);
	await runAll(Q, a.deps, 1);
	const dst = mkdtempSync(join(tmpdir(), "eval-seed-"));
	const ans = readdirSync(join(a.outDir, "_answers"));
	const jud = readdirSync(join(a.outDir, "_judgments"));
	mkdirSync(join(dst, "_answers"), { recursive: true });
	writeFileSync(join(dst, "_answers", ans[0] as string), "keep");
	const r = seedFrom(a.outDir, dst);
	expect(r.copied).toBe(ans.length + jud.length - 1);
	expect(readFileSync(join(dst, "_answers", ans[0] as string), "utf8")).toBe(
		"keep",
	);
	expect(readdirSync(dst).sort()).toEqual(["_answers", "_judgments"]);
	// a fully seeded run makes only the routing call's worth of nothing: no answer or judge calls
	const b = setup("opus-low", 0.3);
	rmSync(b.outDir, { recursive: true });
	seedFrom(a.outDir, b.outDir);
	await runAll(Q, b.deps, 1);
	expect(b.calls).toHaveLength(0);
	expect(b.cascades()).toBe(0);
	expect(rows(b.outDir, "v3")).toHaveLength(1);
});

test("seedFrom migrates old-scheme judgments to content keys, skipping unknowns", async () => {
	const src = mkdtempSync(join(tmpdir(), "eval-old-"));
	const J = join(src, "_judgments");
	const A = join(src, "_answers");
	mkdirSync(J, { recursive: true });
	mkdirSync(A, { recursive: true });
	const ans = (f: string, text: string) =>
		writeFileSync(join(A, f), JSON.stringify({ text }));
	ans("81__claude-opus-5-5__medium.json", "ans-claude-opus-5-5-medium");
	ans("81__claude-haiku-4-5__none.json", "ans-claude-haiku-4-5-none");
	const pair = {
		win: 1,
		bothBad: 0,
		acceptable: 1,
		baselineAcceptable: 1,
		reason: "r",
		setupIsA: true,
		judge: null,
	};
	writeFileSync(
		join(J, `81__v1__j${JUDGE_VERSION}.json`),
		JSON.stringify({ ...pair, text: "low" }),
	);
	writeFileSync(
		join(J, `81__v3__j${JUDGE_VERSION - 1}.json`),
		JSON.stringify({ ...pair, text: "x" }),
	);
	writeFileSync(
		join(J, `81__baseline__j${JUDGE_VERSION}.json`),
		JSON.stringify({
			acceptable: 1,
			reason: "s",
			judge: null,
			text: "ans-claude-opus-5-5-medium",
		}),
	);
	writeFileSync(
		join(J, "81__cascade.json"),
		JSON.stringify({
			passProbability: 0.3,
			jevCostUsd: 0,
			jevLatencyMs: 0,
			error: null,
		}),
	);
	// no baseline answer on disk for question 82: cannot be keyed, skipped
	writeFileSync(
		join(J, `82__v1__j${JUDGE_VERSION}.json`),
		JSON.stringify({ ...pair, text: "low" }),
	);
	const before = readdirSync(J).sort();
	const dst = mkdtempSync(join(tmpdir(), "eval-new-"));
	const r = seedFrom(src, dst);
	expect(r.migrated).toBe(3);
	expect(r.skipped).toBe(1);
	expect(readdirSync(J).sort()).toEqual(before);
	// a re-run of question 81 now needs no judge and no cascade call
	const s = setup("opus-low", 0.3, (c) =>
		c.model.includes("haiku")
			? "ans-claude-haiku-4-5-none"
			: c.effort === "low"
				? "low"
				: "ans-claude-opus-5-5-medium",
	);
	rmSync(s.outDir, { recursive: true });
	seedFrom(src, s.outDir);
	await runAll(Q, s.deps, 1);
	expect(judgeCalls(s)).toBe(0);
	expect(s.cascades()).toBe(0);
	expect(rows(s.outDir, "v1")[0]?.grade.win).toBe(1);
});

test("loadQuestions: heldout is the 40 unselected ids in order across all categories", () => {
	const sel = JSON.parse(
		readFileSync(
			new URL("../eval/data/selection.json", import.meta.url),
			"utf8",
		),
	) as { ids: number[] };
	const h = loadQuestions({ heldout: true });
	expect(h).toHaveLength(40);
	const ids = h.map((q) => q.id);
	expect(ids).toEqual([...ids].sort((a, b) => a - b));
	expect(ids.some((i) => sel.ids.includes(i))).toBe(false);
	expect(new Set(h.map((q) => q.category)).size).toBe(8);
	expect(loadQuestions({ ids: [ids[0] as number] })[0]?.id).toBe(ids[0]);
	expect(() => loadQuestions({ heldout: true, pilot: true })).toThrow();
});

test("renderCompare shows both runs per setup and v2 tier mixes", () => {
	const mk = (rate: number, tier: string) => ({
		...summarizeVariant([
			{
				grade: { acceptable: rate, win: 0.5, both_bad: 0 },
				cost_usd: 2,
				judge_cost_usd: 0,
				latency_s: 1,
				status: "ok",
				meta: { route: { tier } },
			},
		]),
	});
	const out = renderCompare("A", { v1: mk(1, "x"), v2: mk(1, "haiku") }, "B", {
		v1: mk(0, "x"),
		v2: mk(1, "opus-low"),
	});
	expect(out).toContain("| v1 | A | 1 | 1.000");
	expect(out).toContain("| v1 | B | 1 | 0.000");
	expect(out).toContain('A v2 tier mix: {"haiku":1}');
	expect(out).toContain('B v2 tier mix: {"opus-low":1}');
	expect(out).toContain("n/a");
});
