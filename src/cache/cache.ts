import type Anthropic from "@anthropic-ai/sdk";
import { noul, type TypeSafeClient } from "@typesafe-ai/sdk";
import { jevCostUsd } from "../jev/client";
import type { JevBudget } from "../routing/router";
import { buildRouterState } from "../routing/state";
import type { CacheLookup } from "../types";
import type { Embedder } from "./embedder";
import type { CacheStore } from "./store";

type Message = Anthropic.Beta.Messages.BetaMessage;

export interface SemanticCacheOptions {
	embedder: Embedder;
	store: CacheStore;
	jev: TypeSafeClient;
	budget: JevBudget;
	timeoutMs: number;
	ttlMs: number;
	/** Cosine threshold for candidates (default 0.8). */
	minSimilarity: number;
	/** Jev probability needed for a hit (default 0.85). */
	minMatch: number;
	/** Candidates sent to Jev (default 3). */
	maxCandidates: number;
}

export interface SemanticCache {
	/** null when the body isn't cacheable. Never throws (errors → miss with error). */
	lookup(
		body: Record<string, unknown>,
		/** tenant: identifies the caller (e.g. a hash of its API key) so answers are never shared across callers. */
		opts?: { jev?: TypeSafeClient; tenant?: string },
	): Promise<{ hit: Message | null; lookup: CacheLookup } | null>;
	/** Embeds and stores a storable answer for a cacheable body. Never throws; resolves false if not stored. */
	store(
		body: Record<string, unknown>,
		message: Message,
		requestId: string,
		tenant?: string,
	): Promise<boolean>;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/** The user message text, or null unless it is a single text-only user turn. */
const questionOf = (body: Obj): string | null => {
	const m = body.messages;
	if (!Array.isArray(m) || m.length !== 1) return null;
	const msg = m[0];
	if (!isObj(msg) || msg.role !== "user") return null;
	if (typeof msg.content === "string") return msg.content;
	if (!Array.isArray(msg.content) || msg.content.length === 0) return null;
	const parts: string[] = [];
	for (const b of msg.content) {
		if (!isObj(b) || b.type !== "text" || typeof b.text !== "string") {
			return null;
		}
		parts.push(b.text);
	}
	return parts.join("\n");
};

/** Single user turn with text-only content; no non-empty tools; no tool_choice; temperature absent or 0. */
export function isCacheable(body: Obj): boolean {
	if (questionOf(body) === null) return false;
	if (Array.isArray(body.tools) && body.tools.length > 0) return false;
	if (body.tool_choice !== undefined && body.tool_choice !== null) return false;
	return body.temperature === undefined || body.temperature === 0;
}

/** sha256 hex of JSON.stringify([tenant, embedderId, model, system ?? null, output_config ?? null, stop_sequences ?? null, thinking ?? null]). */
export function cacheScope(body: Obj, tenant = "", embedderId = ""): string {
	return new Bun.CryptoHasher("sha256")
		.update(
			JSON.stringify([
				tenant,
				embedderId,
				body.model,
				body.system ?? null,
				body.output_config ?? null,
				body.stop_sequences ?? null,
				body.thinking ?? null,
			]),
		)
		.digest("hex");
}

/** end_turn and every content block is text. */
export function isStorable(message: Message): boolean {
	return (
		message.stop_reason === "end_turn" &&
		message.content.length > 0 &&
		message.content.every((b) => b.type === "text")
	);
}

const answerText = (m: Message) =>
	m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");

const dot = (a: Float32Array, b: Float32Array) => {
	let s = 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
	return s;
};

export function createSemanticCache(opts: SemanticCacheOptions): SemanticCache {
	return {
		async lookup(body, ro) {
			const question = isCacheable(body) ? questionOf(body) : null;
			if (question === null) return null;
			const start = Date.now();
			const lookup: CacheLookup = {
				outcome: "miss",
				candidates: 0,
				bestSimilarity: null,
				matchProbability: null,
				sourceRequestId: null,
				jevLatencyMs: null,
				jevCostUsd: null,
				lookupMs: 0,
				stored: false,
				error: null,
			};
			let hit: Message | null = null;
			try {
				const vec = await opts.embedder.embed(question);
				const scored = opts.store
					.inScope(
						cacheScope(body, ro?.tenant, opts.embedder.id),
						start,
						opts.ttlMs,
					)
					.map((entry) => ({ entry, sim: dot(vec, entry.embedding) }));
				if (scored.length > 0) {
					lookup.bestSimilarity = Math.max(...scored.map((s) => s.sim));
				}
				const cands = scored
					.filter((s) => s.sim >= opts.minSimilarity)
					.sort((a, b) => b.sim - a.sim)
					.slice(0, opts.maxCandidates);
				lookup.candidates = cands.length;
				const caller = ro?.jev;
				if (cands.length === 0) {
					// no Jev call
				} else if (!caller && opts.budget.remainingUsd() <= 0) {
					lookup.error = "jev budget exhausted";
				} else {
					const jevStart = Date.now();
					try {
						const state = buildRouterState(body);
						const result = await (caller ?? opts.jev).systemOne(
							{
								state: {
									new_question: question,
									system_excerpt: state.system_excerpt,
								},
								questions: Object.fromEntries(
									cands.map(({ entry }, i) => [
										`k${i}`,
										noul(
											`EARLIER QUESTION:\n${entry.question}\n\nCACHED ANSWER (excerpt):\n${answerText(entry.message).slice(0, 1500)}\n\nThis cached answer also correctly and fully answers the NEW QUESTION in the state, with nothing that needs to change.`,
										),
									]),
								),
							},
							{ timeout: opts.timeoutMs, retry: { maxRetries: 0 } },
						);
						lookup.jevLatencyMs = Date.now() - jevStart;
						if (!caller) {
							lookup.jevCostUsd = jevCostUsd(result.usage);
							opts.budget.charge(lookup.jevCostUsd);
						}
						let best = -1;
						let bestEntry = cands[0]?.entry;
						cands.forEach(({ entry }, i) => {
							const p = result.answers[`k${i}`]?.noul;
							if (typeof p === "number" && p > best) {
								best = p;
								bestEntry = entry;
							}
						});
						if (best >= 0 && bestEntry) {
							lookup.matchProbability = best;
							if (best >= opts.minMatch) {
								hit = {
									...bestEntry.message,
									id: `msg_cache_${crypto.randomUUID()}`,
								};
								lookup.outcome = "hit";
								lookup.sourceRequestId = bestEntry.requestId;
							}
						}
					} catch (err) {
						lookup.jevLatencyMs = Date.now() - jevStart;
						lookup.error = err instanceof Error ? err.message : String(err);
					}
				}
			} catch (err) {
				lookup.error = err instanceof Error ? err.message : String(err);
			}
			lookup.lookupMs = Date.now() - start;
			return { hit, lookup };
		},
		async store(body, message, requestId, tenant) {
			try {
				const question = isCacheable(body) ? questionOf(body) : null;
				if (question === null || !isStorable(message)) return false;
				opts.store.add({
					id: crypto.randomUUID(),
					scope: cacheScope(body, tenant, opts.embedder.id),
					question,
					embedding: await opts.embedder.embed(question),
					message,
					requestId,
					createdAt: Date.now(),
				});
				return true;
			} catch {
				return false;
			}
		},
	};
}
