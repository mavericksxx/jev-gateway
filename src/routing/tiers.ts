export type Tier =
	| "haiku"
	| "sonnet-low"
	| "sonnet-high"
	| "opus-low"
	| "opus-medium"
	| "opus-high"
	| "fable-high";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface TierSpec {
	model: string;
	/** `output_config.effort` to send; null for models that don't accept effort (Haiku). */
	effort: Effort | null;
	/** Capability order. Sticky routing only ever moves a conversation to a higher rank. */
	rank: number;
	/** Shown to Jev as the choice criterion for this tier. */
	description: string;
}

export const TIERS: Record<Tier, TierSpec> = {
	haiku: {
		model: "claude-haiku-4-5",
		effort: null,
		rank: 0,
		description:
			"Trivial or short tasks: greetings, quick factual lookups, simple rewrites, formatting, classification, short summaries. No real reasoning or coding needed.",
	},
	"sonnet-low": {
		model: "claude-sonnet-5-5",
		effort: "low",
		rank: 1,
		description:
			"Routine tasks with light reasoning: straightforward questions, small code edits or explanations, standard writing, simple tool calls.",
	},
	"sonnet-high": {
		model: "claude-sonnet-5-5",
		effort: "high",
		rank: 2,
		description:
			"Moderate tasks: well-defined multi-step coding, debugging with clear errors, structured analysis, longer writing that needs care.",
	},
	"opus-low": {
		model: "claude-opus-5-5",
		effort: "low",
		rank: 3,
		description:
			"Tasks needing broad knowledge or nuanced judgment but little step-by-step reasoning: careful advice, reviewing medium-size code, synthesis across several sources.",
	},
	"opus-medium": {
		model: "claude-opus-5-5",
		effort: "medium",
		rank: 4,
		description:
			"Hard tasks: non-trivial design decisions, tricky bugs, multi-file refactors, math or logic that needs several careful steps.",
	},
	"opus-high": {
		model: "claude-opus-5-5",
		effort: "high",
		rank: 5,
		description:
			"Very hard tasks: complex system design, subtle concurrency or security bugs, long-horizon agentic work, research-level reasoning.",
	},
	"fable-high": {
		model: "claude-fable-5-1",
		effort: "high",
		rank: 6,
		description:
			"Only the hardest problems, where even a strong model is likely to fail: frontier-level research, very long autonomous tasks, problems previous attempts failed on.",
	},
};

export const ALL_TIERS = Object.keys(TIERS) as Tier[];
