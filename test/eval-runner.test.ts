import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeCall, ClaudeResult, RunClaude } from "../eval/lib/claude";
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
			? '{"verdict":"A","reason":"ok"}'
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
	expect(v2.grade).toEqual({ win: 0.5, both_bad: 0 });
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
		win: 0.5,
		both_bad: 0,
	});
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
	): Row => ({
		grade: { win, both_bad: bb },
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
		mk(0.5, 1, 4, 10),
	]);
	expect(s.graded).toBe(4);
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
