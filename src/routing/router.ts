import { createHash } from "node:crypto";
import { choice, type TypeSafeClient } from "@typesafe-ai/sdk";
import { jevCostUsd } from "../jev/client";
import type { RouteDecision } from "../types";
import { buildRouterState } from "./state";
import { ALL_TIERS, TIERS, type Tier } from "./tiers";

export interface JevBudget {
	/** USD left; <= 0 means don't call Jev. */
	remainingUsd(): number;
	charge(usd: number): void;
}

export interface RouterOptions {
	/** Gateway's own client (live or mock). */
	jev: TypeSafeClient;
	budget: JevBudget;
	defaultTier: Tier;
	/** Jev confidence below this → defaultTier, reason "low-confidence". */
	minConfidence: number;
	/** Per Jev call. */
	timeoutMs: number;
	/** Tiers offered to Jev; default ALL_TIERS. */
	tiers?: Tier[];
}

export interface RouteOptions {
	/** Caller-supplied Jev client (BYO key): used instead of opts.jev and NOT charged to the budget. */
	jev?: TypeSafeClient;
}

export interface Router {
	readonly defaultTier: Tier;
	/** Never throws. */
	route(
		body: Record<string, unknown>,
		opts?: RouteOptions,
	): Promise<RouteDecision>;
}

const MAX_STICKY = 10_000;
const HAIKU_MAX_TOKENS = 180_000;

/** sha256 hex of JSON.stringify([body.system ?? null, firstMessage ?? null]). */
export function conversationId(body: Record<string, unknown>): string {
	const first = Array.isArray(body.messages) ? body.messages[0] : undefined;
	return createHash("sha256")
		.update(JSON.stringify([body.system ?? null, first ?? null]))
		.digest("hex");
}

export function createRouter(opts: RouterOptions): Router {
	const sticky = new Map<string, Tier>();

	const decide = async (
		body: Record<string, unknown>,
		caller: TypeSafeClient | undefined,
	): Promise<RouteDecision> => {
		const d: RouteDecision = {
			tier: opts.defaultTier,
			reason: "fallback",
			confidence: null,
			probabilities: null,
			jevLatencyMs: null,
			jevCostUsd: null,
			error: null,
		};
		if (!caller && opts.budget.remainingUsd() <= 0) {
			d.error = "jev budget exhausted";
			return d;
		}
		const state = buildRouterState(body);
		const offered = (opts.tiers ?? ALL_TIERS).filter(
			(t) =>
				!(t === "haiku" && state.estimated_input_tokens > HAIKU_MAX_TOKENS),
		);
		const start = Date.now();
		try {
			const result = await (caller ?? opts.jev).systemOne(
				{
					state: { ...state },
					questions: {
						tier: choice(
							"Pick the cheapest Claude tier that will handle this request well.",
							Object.fromEntries(offered.map((t) => [t, TIERS[t].description])),
						),
					},
				},
				{ timeout: opts.timeoutMs, retry: { maxRetries: 0 } },
			);
			d.jevLatencyMs = Date.now() - start;
			if (!caller) {
				d.jevCostUsd = jevCostUsd(result.usage);
				opts.budget.charge(d.jevCostUsd);
			}
			const a = result.answers.tier;
			d.confidence = a.confidence;
			d.probabilities = a.probabilities as RouteDecision["probabilities"];
			if (a.confidence < opts.minConfidence) {
				d.reason = "low-confidence";
			} else {
				d.tier = a.choice as Tier;
				d.reason = "jev";
			}
		} catch (err) {
			d.jevLatencyMs = Date.now() - start;
			d.error = err instanceof Error ? err.message : String(err);
		}
		return d;
	};

	return {
		defaultTier: opts.defaultTier,
		async route(body, ro) {
			let d: RouteDecision;
			try {
				d = await decide(body, ro?.jev);
			} catch (err) {
				d = {
					tier: opts.defaultTier,
					reason: "fallback",
					confidence: null,
					probabilities: null,
					jevLatencyMs: null,
					jevCostUsd: null,
					error: err instanceof Error ? err.message : String(err),
				};
			}
			try {
				const id = conversationId(body);
				const prev = sticky.get(id);
				if (prev && TIERS[prev].rank > TIERS[d.tier].rank) {
					d.tier = prev;
					d.reason = "sticky";
				}
				sticky.delete(id);
				sticky.set(id, d.tier);
				if (sticky.size > MAX_STICKY) {
					const oldest = sticky.keys().next().value;
					if (oldest !== undefined) sticky.delete(oldest);
				}
			} catch {}
			return d;
		},
	};
}
