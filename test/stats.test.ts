import { expect, test } from "bun:test";
import {
	baselineCostUsd,
	computeStats,
	withBaseline,
} from "../src/dashboard/stats";
import { costUsd } from "../src/pricing";
import { ALL_TIERS, TIERS, type Tier } from "../src/routing/tiers";
import type { StoredRequest } from "../src/store/db";
import type { RouteDecision } from "../src/types";

const usage = {
	input_tokens: 1000,
	output_tokens: 500,
	cache_creation_input_tokens: 0,
	cache_read_input_tokens: 0,
};
const route = (
	tier: Tier,
	over: Partial<RouteDecision> = {},
): RouteDecision => ({
	tier,
	reason: "jev",
	confidence: 0.9,
	probabilities: null,
	jevLatencyMs: 300,
	jevCostUsd: 0.00003,
	error: null,
	...over,
});
const row = (over: Partial<StoredRequest> = {}): StoredRequest => ({
	id: "x",
	startedAt: 0,
	latencyMs: 1,
	endpoint: "messages",
	requestedModel: "auto",
	upstreamModel: TIERS.haiku.model,
	stream: false,
	status: 200,
	usage,
	error: null,
	costUsd: costUsd(TIERS.haiku.model, usage),
	route: route("haiku"),
	...over,
});
const opts = { baselineTier: "opus-medium" as Tier, jevBudgetUsd: 1, now: 5 };
const opusCost = costUsd(TIERS["opus-medium"].model, usage) ?? 0;
const haikuCost = costUsd(TIERS.haiku.model, usage) ?? 0;

test("baseline rule", () => {
	expect(baselineCostUsd(row(), "opus-medium")).toBe(opusCost);
	expect(
		baselineCostUsd(row({ route: undefined, costUsd: 0.5 }), "opus-medium"),
	).toBe(0.5);
	expect(
		baselineCostUsd(row({ usage: null, costUsd: null }), "opus-medium"),
	).toBeNull();
});

test("totals", () => {
	const s = computeStats(
		[row(), row({ status: 429, usage: null, costUsd: null })],
		opts,
	);
	expect(s.generatedAt).toBe(5);
	expect(s.totals.requests).toBe(2);
	expect(s.totals.routedRequests).toBe(2);
	expect(s.totals.errors).toBe(1);
	expect(s.totals.actualCostUsd).toBeCloseTo(haikuCost);
	expect(s.totals.baselineCostUsd).toBeCloseTo(opusCost);
	expect(s.totals.savedUsd).toBeCloseTo(opusCost - haikuCost);
	expect(s.totals.savedPct).toBeCloseTo((opusCost - haikuCost) / opusCost);
	expect(s.totals.jevSpentUsd).toBeCloseTo(0.00006);
	expect(s.totals.netSavedUsd).toBeCloseTo(opusCost - haikuCost - 0.00006);
});

test("empty input", () => {
	const s = computeStats([], opts);
	expect(s.totals.savedPct).toBeNull();
	expect(s.timeline).toEqual([]);
	expect(s.bucketMs).toBe(60_000);
	expect(s.jevLatencyMs).toEqual({ p50: null, p95: null });
});

test("count_tokens rows are ignored", () => {
	const s = computeStats(
		[row({ endpoint: "count_tokens", usage: null, costUsd: null })],
		opts,
	);
	expect(s.totals.requests).toBe(0);
	expect(s.timeline).toEqual([]);
});

test("tierMix lists 7 tiers in order", () => {
	const s = computeStats(
		[
			row(),
			row(),
			row({ route: route("opus-high"), costUsd: 1 }),
			row({ route: undefined }),
		],
		opts,
	);
	expect(s.tierMix.map((t) => t.tier)).toEqual(ALL_TIERS);
	expect(s.tierMix.find((t) => t.tier === "haiku")?.requests).toBe(2);
	expect(s.tierMix.find((t) => t.tier === "opus-high")).toEqual({
		tier: "opus-high",
		model: TIERS["opus-high"].model,
		requests: 1,
		costUsd: 1,
	});
	expect(s.tierMix.find((t) => t.tier === "fable-high")?.requests).toBe(0);
});

test("reasons always has 4 keys", () => {
	expect(computeStats([], opts).reasons).toEqual({
		jev: 0,
		"low-confidence": 0,
		sticky: 0,
		fallback: 0,
	});
	const s = computeStats(
		[row(), row({ route: route("haiku", { reason: "sticky" }) })],
		opts,
	);
	expect(s.reasons).toEqual({
		jev: 1,
		"low-confidence": 0,
		sticky: 1,
		fallback: 0,
	});
});

test("jev latency percentiles use nearest rank", () => {
	const rows = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000].map((ms) =>
		row({ route: route("haiku", { jevLatencyMs: ms }) }),
	);
	rows.push(row({ route: route("haiku", { jevLatencyMs: null }) }));
	const s = computeStats(rows, opts);
	expect(s.jevLatencyMs).toEqual({ p50: 500, p95: 1000 });
	const none = computeStats(
		[row({ route: route("haiku", { jevLatencyMs: null }) })],
		opts,
	);
	expect(none.jevLatencyMs).toEqual({ p50: null, p95: null });
});

const H = 3_600_000;
const spanRows = (span: number) => [
	row({ startedAt: 0 }),
	row({ startedAt: span }),
];
test("bucketMs thresholds", () => {
	expect(computeStats(spanRows(0), opts).bucketMs).toBe(60_000);
	expect(computeStats(spanRows(2 * H), opts).bucketMs).toBe(60_000);
	expect(computeStats(spanRows(2 * H + 1), opts).bucketMs).toBe(H);
	expect(computeStats(spanRows(48 * H), opts).bucketMs).toBe(H);
	expect(computeStats(spanRows(48 * H + 1), opts).bucketMs).toBe(86_400_000);
});

test("timeline is contiguous with empty buckets", () => {
	const s = computeStats(
		[
			row({ startedAt: 60_000 }),
			row({ startedAt: 60_500 }),
			row({ startedAt: 240_000 }),
		],
		opts,
	);
	expect(s.timeline.map((b) => [b.bucketStart, b.requests])).toEqual([
		[60_000, 2],
		[120_000, 0],
		[180_000, 0],
		[240_000, 1],
	]);
	expect(s.timeline[0]?.actualCostUsd).toBeCloseTo(2 * haikuCost);
	expect(s.timeline[0]?.baselineCostUsd).toBeCloseTo(2 * opusCost);
});

test("withBaseline adds the field and keeps order", () => {
	const rows = [row({ id: "a" }), row({ id: "b", usage: null, costUsd: null })];
	const out = withBaseline(rows, "opus-medium");
	expect(out.map((r) => r.id)).toEqual(["a", "b"]);
	expect(out[0]?.baselineCostUsd).toBe(opusCost);
	expect(out[1]?.baselineCostUsd).toBeNull();
});
