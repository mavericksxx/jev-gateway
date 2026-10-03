import { TIERS, type Tier } from "../routing/tiers";

export interface Translated {
	/** New request body for the target tier. The input is never mutated. */
	body: Record<string, unknown>;
	/** Beta flags to add to the upstream request (merged with the client's `anthropic-beta`). */
	addBetas: string[];
}

/** Rewrite a client's Messages API body so it is valid for the target tier's model. */
export function translateParams(
	body: Record<string, unknown>,
	tier: Tier,
): Translated {
	const { model, effort } = TIERS[tier];
	const out = structuredClone(body);
	const haiku = model === "claude-haiku-4-5";
	const fable = model === "claude-fable-5-1";
	const opus = model === "claude-opus-5-5";
	out.model = model;

	// Haiku 4.5 rejects max_tokens above 64000.
	if (haiku && typeof out.max_tokens === "number") {
		out.max_tokens = Math.min(out.max_tokens, 64000);
	}

	// Haiku rejects output_config.effort; other models take the tier's effort.
	if (effort) {
		out.output_config = {
			...(out.output_config as Record<string, unknown> | undefined),
			effort,
		};
	} else if (out.output_config && typeof out.output_config === "object") {
		const oc = out.output_config as Record<string, unknown>;
		delete oc.effort;
		if (Object.keys(oc).length === 0) delete out.output_config;
	}

	// Sonnet/Opus/Fable reject sampling parameters.
	if (!haiku) {
		delete out.temperature;
		delete out.top_p;
		delete out.top_k;
	}

	// Haiku needs a valid budget and has no adaptive; Sonnet rejects disabled;
	// Opus also rejects between_tools; Fable accepts only adaptive.
	const thinking = out.thinking as Record<string, unknown> | undefined;
	if (thinking && typeof thinking === "object") {
		const type = thinking.type;
		const budget = thinking.budget_tokens;
		const max = out.max_tokens;
		const adaptive =
			thinking.display === undefined
				? { type: "adaptive" }
				: { type: "adaptive", display: thinking.display };
		if (haiku) {
			const ok =
				type === "enabled" &&
				typeof budget === "number" &&
				budget >= 1024 &&
				typeof max === "number" &&
				budget < max;
			if (!ok && type !== "disabled") delete out.thinking;
		} else if (type === "adaptive") {
			// kept as-is
		} else if (type === "between_tools" && !opus && !fable) {
			// kept as-is (Sonnet only)
		} else if (type === "enabled" && !fable) {
			out.thinking = adaptive;
		} else {
			delete out.thinking;
		}
	}

	// Sonnet/Opus/Fable reject forced tool use alongside the translated thinking.
	const tc = out.tool_choice as Record<string, unknown> | undefined;
	if (!haiku && tc && (tc.type === "any" || tc.type === "tool")) {
		out.tool_choice =
			tc.disable_parallel_tool_use === undefined
				? { type: "auto" }
				: {
						type: "auto",
						disable_parallel_tool_use: tc.disable_parallel_tool_use,
					};
	}

	// Server-side refusal fallback exists only on Sonnet/Opus/Fable; Haiku rejects it.
	const addBetas: string[] = [];
	if (haiku) {
		delete out.fallbacks;
	} else if (!("fallbacks" in out)) {
		out.fallbacks = "default";
		addBetas.push("server-side-fallback-2026-07-01");
	}

	return { body: out, addBetas };
}
