import type { Tier } from "../routing/tiers";
import type { StoredRequest } from "../store/db";
import type { RouteDecision } from "../types";

/** GET /api/stats */
export interface StatsResponse {
	generatedAt: number;
	/** The "if everything had gone to this model" comparison point. */
	baseline: { tier: Tier; model: string };
	totals: {
		requests: number;
		routedRequests: number;
		/** Requests with status >= 400. */
		errors: number;
		/** Sum of what requests actually cost. */
		actualCostUsd: number;
		/**
		 * Estimate: routed requests re-priced at the baseline model with the same token
		 * counts; non-routed requests count at their actual cost (no savings claimed).
		 */
		baselineCostUsd: number;
		/** baselineCostUsd - actualCostUsd */
		savedUsd: number;
		/** savedUsd / baselineCostUsd; null when baselineCostUsd is 0. */
		savedPct: number | null;
		jevSpentUsd: number;
		jevBudgetUsd: number;
		/** savedUsd - jevSpentUsd */
		netSavedUsd: number;
	};
	/** Over requests where Jev was actually called (jevLatencyMs not null). Null when there are none. */
	jevLatencyMs: { p50: number | null; p95: number | null };
	/** Routed requests only. Always all 7 tiers in TIERS order, zeros included. */
	tierMix: Array<{
		tier: Tier;
		model: string;
		requests: number;
		costUsd: number;
	}>;
	/** Routed requests by decision reason; all four keys always present. */
	reasons: Record<RouteDecision["reason"], number>;
	/**
	 * Per-bucket (not cumulative) totals, oldest first, contiguous (empty buckets included).
	 * bucketMs: 60_000 if the data spans <= 2h, 3_600_000 if <= 2 days, else 86_400_000.
	 * Empty when there are no requests.
	 */
	bucketMs: number;
	timeline: Array<{
		bucketStart: number;
		requests: number;
		actualCostUsd: number;
		baselineCostUsd: number;
	}>;
}

/** GET /api/requests?limit=N (default 100, max 1000), newest first. */
export type RequestsResponse = Array<
	StoredRequest & {
		/** What this request would have cost at the baseline model (null if unpriceable). */
		baselineCostUsd: number | null;
	}
>;
