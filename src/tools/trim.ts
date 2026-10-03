import { noul, type TypeSafeClient } from "@typesafe-ai/sdk";
import { jevCostUsd } from "../jev/client";
import { conversationId, type JevBudget } from "../routing/router";
import { buildRouterState } from "../routing/state";
import type { ToolTrim } from "../types";

export interface ToolTrimmerOptions {
	jev: TypeSafeClient;
	budget: JevBudget;
	timeoutMs: number;
	/** Trim only when body.tools has at least this many entries. */
	minTools: number;
	/** Keep scored tools with probability >= this. */
	minProbability: number;
	/** Always keep at least this many highest-scored tools. */
	keepTop: number;
	/** Tool names always kept. */
	pinned: string[];
}

export interface TrimResult {
	/** Body to forward (a new object when tools changed; never mutate the input). */
	body: Record<string, unknown>;
	/** null when trimming did not apply (too few tools, defer_loading in use, no tools). */
	record: ToolTrim | null;
}

export interface ToolTrimmer {
	/** Never throws. */
	trim(
		body: Record<string, unknown>,
		opts?: { jev?: TypeSafeClient },
	): Promise<TrimResult>;
}

const MAX_CONVERSATIONS = 10_000;
const CHUNK = 50;

type Tool = Record<string, unknown>;

const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const isCustom = (t: Tool) => t.type === undefined || t.type === "custom";

const usedToolNames = (body: Record<string, unknown>): Set<string> => {
	const names = new Set<string>();
	const messages = Array.isArray(body.messages) ? body.messages : [];
	for (const m of messages) {
		if (!isObj(m) || !Array.isArray(m.content)) continue;
		for (const b of m.content) {
			if (isObj(b) && b.type === "tool_use" && typeof b.name === "string") {
				names.add(b.name);
			}
		}
	}
	return names;
};

export function createToolTrimmer(opts: ToolTrimmerOptions): ToolTrimmer {
	const seen = new Map<string, Set<string>>();

	const run = async (
		body: Record<string, unknown>,
		caller: TypeSafeClient | undefined,
	): Promise<TrimResult> => {
		const tools = body.tools;
		if (!Array.isArray(tools) || tools.length < opts.minTools) {
			return { body, record: null };
		}
		const defs = tools.filter(isObj);
		if (defs.length !== tools.length || defs.some((t) => t.defer_loading)) {
			return { body, record: null };
		}
		const scoredIdx = defs.flatMap((t, i) =>
			isCustom(t) && typeof t.name === "string" ? [i] : [],
		);
		if (scoredIdx.length === 0) return { body, record: null };

		const offered = defs.length;
		const record: ToolTrim = {
			offered,
			kept: offered,
			removed: [],
			estimatedTokensSaved: 0,
			scores: null,
			jevLatencyMs: null,
			jevCostUsd: null,
			error: null,
		};
		if (!caller && opts.budget.remainingUsd() <= 0) {
			record.error = "jev budget exhausted";
			return { body, record };
		}

		const { tool_names: _, ...state } = buildRouterState(body);
		const questions = scoredIdx.map((i, k) => {
			const t = defs[i] as Tool;
			const desc =
				typeof t.description === "string" ? t.description.slice(0, 300) : "";
			return [
				`t${k}`,
				noul(
					`Tool "${t.name}": ${desc}. This tool may be needed to handle the latest turn of the conversation.`,
				),
			] as const;
		});
		const chunks: (typeof questions)[] = [];
		for (let i = 0; i < questions.length; i += CHUNK) {
			chunks.push(questions.slice(i, i + CHUNK));
		}

		const jev = caller ?? opts.jev;
		const start = Date.now();
		let spent = 0;
		const results = await Promise.allSettled(
			chunks.map(async (chunk) => {
				const r = await jev.systemOne(
					{ state: { ...state }, questions: Object.fromEntries(chunk) },
					{ timeout: opts.timeoutMs, retry: { maxRetries: 0 } },
				);
				spent += jevCostUsd(r.usage);
				return r;
			}),
		);
		record.jevLatencyMs = Date.now() - start;
		if (!caller && spent > 0) {
			record.jevCostUsd = spent;
			opts.budget.charge(spent);
		}
		const failed = results.find((r) => r.status === "rejected");
		if (failed) {
			const reason = (failed as PromiseRejectedResult).reason;
			record.error = reason instanceof Error ? reason.message : String(reason);
			return { body, record };
		}

		const answers: Record<string, { noul?: number } | undefined> = {};
		for (const r of results) {
			if (r.status === "fulfilled") Object.assign(answers, r.value.answers);
		}
		const scores: Record<string, number> = {};
		const byName = new Map<string, number>();
		scoredIdx.forEach((i, k) => {
			const name = (defs[i] as Tool).name as string;
			const p = answers[`t${k}`]?.noul ?? 0.5;
			scores[name] = p;
			byName.set(name, p);
		});

		const id = conversationId(body);
		const always = new Set<string>([
			...opts.pinned,
			...usedToolNames(body),
			...(seen.get(id) ?? []),
		]);
		const tc = body.tool_choice;
		if (isObj(tc) && tc.type === "tool" && typeof tc.name === "string") {
			always.add(tc.name);
		}
		const top = new Set(
			[...byName.entries()]
				.sort((a, b) => b[1] - a[1])
				.slice(0, opts.keepTop)
				.map(([n]) => n),
		);
		const keep = (t: Tool) => {
			if (!isCustom(t) || typeof t.name !== "string") return true;
			return (
				always.has(t.name) ||
				top.has(t.name) ||
				(byName.get(t.name) ?? 0) >= opts.minProbability
			);
		};
		const kept = defs.filter(keep);
		const removed = defs.filter((t) => !keep(t));

		seen.delete(id);
		seen.set(
			id,
			new Set([
				...(seen.get(id) ?? []),
				...always,
				...kept.map((t) => t.name as string).filter(Boolean),
			]),
		);
		if (seen.size > MAX_CONVERSATIONS) {
			const oldest = seen.keys().next().value;
			if (oldest !== undefined) seen.delete(oldest);
		}

		record.scores = scores;
		if (removed.length === 0) return { body, record };

		const outTools = [...kept];
		const rc = removed.find(
			(t) => t.cache_control !== undefined,
		)?.cache_control;
		const last = outTools.at(-1);
		if (rc !== undefined && last && last.cache_control === undefined) {
			outTools[outTools.length - 1] = { ...last, cache_control: rc };
		}
		record.kept = kept.length;
		record.removed = removed.map((t) => String(t.name));
		record.estimatedTokensSaved = Math.ceil(JSON.stringify(removed).length / 4);
		return { body: { ...body, tools: outTools }, record };
	};

	return {
		async trim(body, ro) {
			try {
				return await run(body, ro?.jev);
			} catch (err) {
				const n = Array.isArray(body.tools) ? body.tools.length : 0;
				return {
					body,
					record: {
						offered: n,
						kept: n,
						removed: [],
						estimatedTokensSaved: 0,
						scores: null,
						jevLatencyMs: null,
						jevCostUsd: null,
						error: err instanceof Error ? err.message : String(err),
					},
				};
			}
		},
	};
}
