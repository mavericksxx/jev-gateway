import { costUsd, PRICES } from "../pricing";
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
	const base = row.route
		? costUsd(TIERS[baselineTier].model, row.usage)
		: row.costUsd;
	if (!row.toolTrim) return base;
	return (base ?? 0) + trimAddBack(row, baselineTier);
}

/** USD of the tool-definition tokens that trimming kept out of the request. */
function trimAddBack(row: StoredRequest, baselineTier: Tier): number {
	if (!row.toolTrim) return 0;
	const model = row.route ? TIERS[baselineTier].model : row.upstreamModel;
	const price = PRICES[model];
	if (!price) return 0;
	return (row.toolTrim.estimatedTokensSaved * price.input) / 1_000_000;
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
	const cascade = {
		attempted: 0,
		accepted: 0,
		escalated: 0,
		wastedUsd: 0,
		jevCostUsd: 0,
	};
	const reasons = { jev: 0, "low-confidence": 0, sticky: 0, fallback: 0 };
	const toolTrim = {
		requests: 0,
		trimmed: 0,
		toolsOffered: 0,
		toolsRemoved: 0,
		estimatedTokensSaved: 0,
		estimatedSavedUsd: 0,
		jevCostUsd: 0,
	};
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
		if (r.toolTrim) {
			toolTrim.requests++;
			if (r.toolTrim.removed.length > 0) toolTrim.trimmed++;
			toolTrim.toolsOffered += r.toolTrim.offered;
			toolTrim.toolsRemoved += r.toolTrim.removed.length;
			toolTrim.estimatedTokensSaved += r.toolTrim.estimatedTokensSaved;
			toolTrim.estimatedSavedUsd += r.usage ? trimAddBack(r, baselineTier) : 0;
			toolTrim.jevCostUsd += r.toolTrim.jevCostUsd ?? 0;
			jevSpent += r.toolTrim.jevCostUsd ?? 0;
		}
		if (r.cascade) {
			cascade.attempted++;
			if (r.cascade.accepted) cascade.accepted++;
			else cascade.escalated++;
			cascade.wastedUsd += r.cascade.wastedCostUsd;
			cascade.jevCostUsd += r.cascade.jevCostUsd ?? 0;
			jevSpent += r.cascade.jevCostUsd ?? 0;
		}
		if (!r.route) continue;
		routedRequests++;
		jevSpent += r.route.jevCostUsd ?? 0;
		if (r.route.jevLatencyMs !== null) latencies.push(r.route.jevLatencyMs);
		reasons[r.route.reason]++;
		const served = r.cascade?.accepted ? r.cascade.firstTier : r.route.tier;
		const m = mix.get(served);
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
		cascade,
		toolTrim,
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
