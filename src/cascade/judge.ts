import type Anthropic from "@anthropic-ai/sdk";
import { noul, type TypeSafeClient } from "@typesafe-ai/sdk";
import { jevCostUsd } from "../jev/client";
import type { JevBudget } from "../routing/router";
import { buildRouterState } from "../routing/state";

export interface JudgeResult {
	passProbability: number | null;
	jevLatencyMs: number | null;
	/** Charged to the gateway budget; null when Jev wasn't called or a caller client was used. */
	jevCostUsd: number | null;
	error: string | null;
}

export interface CascadeJudge {
	/** Never throws. */
	judge(
		body: Record<string, unknown>,
		answer: Anthropic.Beta.Messages.BetaMessage,
		opts?: { jev?: TypeSafeClient },
	): Promise<JudgeResult>;
}

export interface CascadeJudgeOptions {
	jev: TypeSafeClient;
	budget: JevBudget;
	timeoutMs: number;
}

const MAX_RESPONSE = 6000;

const responseText = (msg: Anthropic.Beta.Messages.BetaMessage): string => {
	const text = msg.content
		.flatMap((b) => (b.type === "text" ? [b.text] : []))
		.join("\n");
	return text.length > MAX_RESPONSE
		? `${text.slice(0, 4500)} … ${text.slice(-1500)}`
		: text;
};

export function createCascadeJudge(opts: CascadeJudgeOptions): CascadeJudge {
	return {
		async judge(body, answer, ro) {
			const r: JudgeResult = {
				passProbability: null,
				jevLatencyMs: null,
				jevCostUsd: null,
				error: null,
			};
			const caller = ro?.jev;
			if (!caller && opts.budget.remainingUsd() <= 0) {
				r.error = "jev budget exhausted";
				return r;
			}
			const start = Date.now();
			try {
				const state = buildRouterState(body);
				const result = await (caller ?? opts.jev).systemOne(
					{
						state: {
							system_excerpt: state.system_excerpt,
							user_request: state.last_user_turn,
							response: responseText(answer),
							stop_reason: answer.stop_reason,
						},
						questions: {
							pass: noul(
								"The response fully and correctly answers the user's latest request, with nothing important missing or wrong.",
							),
						},
					},
					{ timeout: opts.timeoutMs, retry: { maxRetries: 0 } },
				);
				r.jevLatencyMs = Date.now() - start;
				if (!caller) {
					r.jevCostUsd = jevCostUsd(result.usage);
					opts.budget.charge(r.jevCostUsd);
				}
				r.passProbability = result.answers.pass.noul;
			} catch (err) {
				r.jevLatencyMs = Date.now() - start;
				r.error = err instanceof Error ? err.message : String(err);
			}
			return r;
		},
	};
}
