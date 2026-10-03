import { TIERS, type Tier } from "../routing/tiers";

export interface Translated {
	/** New request body for the target tier. The input is never mutated. */
	body: Record<string, unknown>;
	/** Beta flags to add to the upstream request (merged with the client's `anthropic-beta`). */
	addBetas: string[];
}

/**
 * Rewrite a client's Messages API body so it is valid for the target tier's model.
 * PLACEHOLDER: only swaps the model. The full translation lands in Phase 2.
 */
export function translateParams(
	body: Record<string, unknown>,
	tier: Tier,
): Translated {
	return { body: { ...body, model: TIERS[tier].model }, addBetas: [] };
}
