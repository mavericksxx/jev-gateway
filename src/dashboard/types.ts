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
		 * Trimmed requests add back toolTrim.estimatedTokensSaved as uncached input tokens,
		 * priced at the baseline model (routed) or the upstream model (non-routed).
		 * Cache hits cost 0; their baseline is the cached response's usage priced at the
		 * baseline model when requestedModel is "auto", else at the cached response's model.
		 */
		baselineCostUsd: number;
		/** baselineCostUsd - actualCostUsd */
		savedUsd: number;
		/** savedUsd / baselineCostUsd; null when baselineCostUsd is 0. */
		savedPct: number | null;
		/** Router + cascade-judge + tool-trim + cache Jev costs. */
		jevSpentUsd: number;
		jevBudgetUsd: number;
		/** savedUsd - jevSpentUsd */
		netSavedUsd: number;
	};
	/** Over requests where Jev was actually called (jevLatencyMs not null). Null when there are none. */
	jevLatencyMs: { p50: number | null; p95: number | null };
	/**
	 * Routed requests only, by the tier that served the response (the cascade's first tier
	 * when accepted, else route.tier); cache hits are excluded. Always all 7 tiers in TIERS
	 * order, zeros included.
	 */
	tierMix: Array<{
		tier: Tier;
		model: string;
		requests: number;
		costUsd: number;
	}>;
	/** Cheap-first attempts. wastedUsd = sum of rejected first attempts' cost (already inside actualCostUsd). */
	cascade: {
		attempted: number;
		accepted: number;
		escalated: number;
		wastedUsd: number;
		/** Jev cost of judging answers (already inside totals.jevSpentUsd). */
		jevCostUsd: number;
	};
	/** Over messages requests that carry a toolTrim record. */
	toolTrim: {
		/** Requests where trimming ran (including ones where Jev failed and nothing was trimmed). */
		requests: number;
		/** Requests where at least one tool was removed. */
		trimmed: number;
		toolsOffered: number;
		toolsRemoved: number;
		estimatedTokensSaved: number;
		/** Estimate, already inside totals.savedUsd: tokens saved priced as in baselineCostUsd. */
		estimatedSavedUsd: number;
		/** Already inside totals.jevSpentUsd. */
		jevCostUsd: number;
	};
	/** Over messages requests that carry a cache record. */
	cache: {
		lookups: number;
		hits: number;
		/** hits / lookups; null when there were no lookups. */
		hitRate: number | null;
		/** Estimate, already inside totals.savedUsd: Σ baseline cost of hits. */
		savedUsd: number;
		/** Already inside totals.jevSpentUsd. */
		jevCostUsd: number;
	};
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
