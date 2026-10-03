import { costUsd } from "../pricing";
import { ALL_TIERS, TIERS, type Tier } from "../routing/tiers";
import type { StoredRequest } from "../store/db";
import type { RequestsResponse, StatsResponse } from "./types";

export interface StatsOptions {
	baselineTier: Tier;
	jevBudgetUsd: number;
	/** For generatedAt; default Date.now(). */
	now?: number;
}

/** Per-row baseline cost: routed + usage → costUsd(baseline model, usage); not routed → row.costUsd; usage null → null. */
export function baselineCostUsd(
	row: StoredRequest,
	baselineTier: Tier,
): number | null {
	if (!row.usage) return null;
	if (!row.route) return row.costUsd;
	return costUsd(TIERS[baselineTier].model, row.usage);
}

function nearestRank(sorted: number[], p: number): number | null {
	if (sorted.length === 0) return null;
	const i = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
	return Math.round(sorted[i] ?? 0);
}

const HOUR = 3_600_000;

export function computeStats(
	allRows: StoredRequest[],
	opts: StatsOptions,
): StatsResponse {
	const rows = allRows.filter((r) => r.endpoint === "messages");
	const { baselineTier } = opts;
	let routedRequests = 0;
	let errors = 0;
	let actual = 0;
	let baseline = 0;
	let jevSpent = 0;
	const latencies: number[] = [];
	const mix = new Map<Tier, { requests: number; costUsd: number }>(
		ALL_TIERS.map((t) => [t, { requests: 0, costUsd: 0 }]),
	);
	const reasons = { jev: 0, "low-confidence": 0, sticky: 0, fallback: 0 };
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;

	for (const r of rows) {
		const cost = r.costUsd ?? 0;
		const base = baselineCostUsd(r, baselineTier) ?? 0;
		actual += cost;
		baseline += base;
		if (r.status >= 400) errors++;
		min = Math.min(min, r.startedAt);
		max = Math.max(max, r.startedAt);
		if (!r.route) continue;
		routedRequests++;
		jevSpent += r.route.jevCostUsd ?? 0;
		if (r.route.jevLatencyMs !== null) latencies.push(r.route.jevLatencyMs);
		reasons[r.route.reason]++;
		const m = mix.get(r.route.tier);
		if (m) {
			m.requests++;
			m.costUsd += cost;
		}
	}
	latencies.sort((a, b) => a - b);

	const span = rows.length ? max - min : 0;
	const bucketMs =
		span <= 2 * HOUR ? 60_000 : span <= 48 * HOUR ? HOUR : 86_400_000;
	const timeline: StatsResponse["timeline"] = [];
	if (rows.length) {
		const first = Math.floor(min / bucketMs) * bucketMs;
		const last = Math.floor(max / bucketMs) * bucketMs;
		for (let t = first; t <= last; t += bucketMs) {
			timeline.push({
				bucketStart: t,
				requests: 0,
				actualCostUsd: 0,
				baselineCostUsd: 0,
			});
		}
		for (const r of rows) {
			const b =
				timeline[
					(Math.floor(r.startedAt / bucketMs) * bucketMs - first) / bucketMs
				];
			if (!b) continue;
			b.requests++;
			b.actualCostUsd += r.costUsd ?? 0;
			b.baselineCostUsd += baselineCostUsd(r, baselineTier) ?? 0;
		}
	}

	const saved = baseline - actual;
	return {
		generatedAt: opts.now ?? Date.now(),
		baseline: { tier: baselineTier, model: TIERS[baselineTier].model },
		totals: {
			requests: rows.length,
			routedRequests,
			errors,
			actualCostUsd: actual,
			baselineCostUsd: baseline,
			savedUsd: saved,
			savedPct: baseline === 0 ? null : saved / baseline,
			jevSpentUsd: jevSpent,
			jevBudgetUsd: opts.jevBudgetUsd,
			netSavedUsd: saved - jevSpent,
		},
		jevLatencyMs: {
			p50: nearestRank(latencies, 50),
			p95: nearestRank(latencies, 95),
		},
		tierMix: ALL_TIERS.map((tier) => ({
			tier,
			model: TIERS[tier].model,
			requests: mix.get(tier)?.requests ?? 0,
			costUsd: mix.get(tier)?.costUsd ?? 0,
		})),
		reasons,
		bucketMs,
		timeline,
	};
}

export function withBaseline(
	rows: StoredRequest[],
	baselineTier: Tier,
): RequestsResponse {
	return rows.map((r) => ({
		...r,
		baselineCostUsd: baselineCostUsd(r, baselineTier),
	}));
}
