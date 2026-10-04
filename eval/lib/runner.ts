import { createHash } from "node:crypto";
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ALL_TIERS, TIERS, type Tier } from "../../src/routing/tiers";
import type { RouteDecision } from "../../src/types";
import { ClaudeError, type ClaudeResult, type RunClaude } from "./claude";
import {
	JUDGE_MODEL,
	JUDGE_VERSION,
	type Judgment,
	judgeAcceptable,
	judgeAnswer,
} from "./judge";

export const VARIANTS = ["baseline", "v1", "v2", "v3"] as const;
export type Variant = (typeof VARIANTS)[number];

export const DESCRIPTIONS: Record<Variant, string> = {
	baseline: "Always Opus 5.5 at medium effort (the reference).",
	v1: "Always Opus 5.5 at low effort.",
	v2: "Jev router picks the tier (model and effort) per question.",
	v3: "Jev router plus cheap-first: Haiku answer kept when Jev passes it (>= 0.7), else the routed tier's answer.",
};

export interface Question {
	id: number;
	category: string;
	prompt: string;
}

export interface CascadeOutcome {
	passProbability: number | null;
	jevCostUsd: number | null;
	jevLatencyMs: number | null;
	error: string | null;
}

export interface Deps {
	runClaude: RunClaude;
	route: (body: Record<string, unknown>) => Promise<RouteDecision>;
	cascade: (
		body: Record<string, unknown>,
		message: Record<string, unknown>,
	) => Promise<CascadeOutcome>;
	outDir: string;
	timeoutMs: number;
	/** Tiers offered to the router (default ALL_TIERS); part of the route-cache fingerprint. */
	offeredTiers?: Tier[];
}

export const sha = (s: string): string =>
	createHash("sha256").update(s).digest("hex").slice(0, 16);

/** Short fingerprint of the tier table and the tiers offered to the router. */
export const tiersFingerprint = (offered: Tier[] = ALL_TIERS): string =>
	sha(JSON.stringify({ tiers: TIERS, offered }));

const pairKey = (id: number, setup: string, base: string): string =>
	`${id}__${sha(JSON.stringify([setup, base]))}__j${JUDGE_VERSION}`;
const baseKey = (id: number, base: string): string =>
	`${id}__base-${sha(base)}__j${JUDGE_VERSION}`;
const cascadeKey = (id: number, haikuText: string): string =>
	`${id}__cascade__${sha(haikuText)}`;

export const ACCEPT_THRESHOLD = 0.7;
const SYSTEM = "You are a helpful assistant.";
const OPUS = "claude-opus-5-5";
const HAIKU = TIERS.haiku;

interface Cfg {
	model: string;
	effort?: "low" | "medium" | "high";
}

const cfgOf = (tier: Tier): Cfg => {
	const t = TIERS[tier];
	const e = t.effort;
	return {
		model: t.model,
		...(e === "low" || e === "medium" || e === "high" ? { effort: e } : {}),
	};
};

const readJson = <T>(p: string): T | null =>
	existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null;

interface RowLike {
	prompt_id: number;
	meta: { judge_version?: number; tiers_fp?: string };
}

const readRows = (variantDir: string): RowLike[] => {
	const p = join(variantDir, "results.jsonl");
	if (!existsSync(p)) return [];
	return readFileSync(p, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as RowLike);
};

/** Ids graded under the current judge version (and, for routed setups, the current tier fingerprint); others are redone and replaced. */
const doneIds = (variantDir: string, fp: string | null): Set<number> =>
	new Set(
		readRows(variantDir)
			.filter(
				(r) =>
					r.meta?.judge_version === JUDGE_VERSION &&
					(fp === null || r.meta?.tiers_fp === fp),
			)
			.map((r) => r.prompt_id),
	);

/** Append a row, replacing any earlier row for the same question (one row per question). */
const writeRow = (variantDir: string, row: RowLike): void => {
	const rows = readRows(variantDir).filter(
		(r) => r.prompt_id !== row.prompt_id,
	);
	rows.push(row);
	writeFileSync(
		join(variantDir, "results.jsonl"),
		rows.map((r) => `${JSON.stringify(r)}\n`).join(""),
	);
};

export function writeState(outDir: string): void {
	for (const d of ["_answers", "_routes", "_judgments", ...VARIANTS]) {
		mkdirSync(join(outDir, d), { recursive: true });
	}
	for (const v of ["v1", "v2", "v3"] as const) {
		writeFileSync(join(outDir, v, "change.md"), `${DESCRIPTIONS[v]}\n`);
	}
	writeFileSync(
		join(outDir, "_state.json"),
		JSON.stringify(
			{
				schema: "hillclimb/v2",
				metrics: [
					{ id: "acceptable", label: "Acceptable", kind: "float", scale: 1 },
					{ id: "win", label: "Win vs Opus", kind: "float", scale: 1 },
					{ id: "both_bad", label: "Both bad", kind: "binary" },
				],
				perf_fields: [
					{ id: "cost_usd", label: "Cost", unit: "usd" },
					{ id: "in_tokens", label: "Input tokens" },
					{ id: "out_tokens", label: "Output tokens" },
					{ id: "latency_s", label: "Latency", unit: "s" },
				],
				variants: VARIANTS.map((id) => ({
					id,
					description: DESCRIPTIONS[id],
				})),
			},
			null,
			2,
		),
	);
}

const logError = (
	outDir: string,
	variant: string,
	id: number,
	stage: string,
	err: unknown,
): void => {
	const e = err instanceof ClaudeError ? err : null;
	appendFileSync(
		join(outDir, variant, "errors.jsonl"),
		`${JSON.stringify({
			prompt_id: id,
			stage,
			class: e?.failureClass ?? "judge_parse",
			message: err instanceof Error ? err.message : String(err),
			attempts: e?.attempts ?? null,
		})}\n`,
	);
};

/** Process one question across all four setups. Never throws. */
export async function runQuestion(q: Question, deps: Deps): Promise<void> {
	const { outDir, runClaude, timeoutMs } = deps;
	const fp = tiersFingerprint(deps.offeredTiers);
	const todo = VARIANTS.filter(
		(v) =>
			!doneIds(join(outDir, v), v === "v2" || v === "v3" ? fp : null).has(q.id),
	);
	if (todo.length === 0) return;
	const used = new Set<string>();

	const answer = async (
		cfg: Cfg,
	): Promise<{ r: ClaudeResult; reused: boolean }> => {
		const key = `${q.id}__${cfg.model}__${cfg.effort ?? "none"}`;
		const file = join(outDir, "_answers", `${key}.json`);
		const reused = used.has(key);
		used.add(key);
		const cached = readJson<ClaudeResult>(file);
		if (cached) return { r: cached, reused };
		const r = await runClaude({
			...cfg,
			system: SYSTEM,
			prompt: q.prompt,
			timeoutMs,
		});
		writeFileSync(file, JSON.stringify(r));
		return { r, reused };
	};

	const body = {
		model: "auto",
		max_tokens: 4096,
		messages: [{ role: "user", content: q.prompt }],
	};
	let route: RouteDecision | null = null;
	const getRoute = async (): Promise<RouteDecision> => {
		if (route) return route;
		const file = join(outDir, "_routes", `${q.id}__${fp}.json`);
		route = readJson<RouteDecision>(file);
		if (!route) {
			route = await deps.route(body);
			writeFileSync(file, JSON.stringify(route));
		}
		return route;
	};

	let base: ClaudeResult | null = null;
	const baseAnswer = async () => {
		const a = await answer({ model: OPUS, effort: "medium" });
		base = a.r;
		return a;
	};

	const jfileOf = (key: string) => join(outDir, "_judgments", `${key}.json`);
	/** Baseline's verdicts on its own answer from the comparisons judged in this pass. */
	const baseVerdicts: number[] = [];
	interface Pending {
		variant: Variant;
		row: Record<string, unknown> & { grade: Record<string, number> };
		/** Grade needs the baseline answer's acceptability (baseline row, or identical answers). */
		needsBase: boolean;
	}
	const pending: Pending[] = [];

	const emit = async (
		variant: Variant,
		tag: string,
		final: ClaudeResult,
		parts: { r: ClaudeResult; reused: boolean }[],
		extra: {
			latencyMs: number;
			jevCost: number;
			meta: Record<string, unknown>;
		},
	): Promise<void> => {
		let grade: Record<string, number> = { win: 0.5, both_bad: 0 };
		let explanation = "reference setup";
		let judgeModel: string | null = null;
		let judgeUsage: ClaudeResult["usage"] | null = null;
		let judgeCost = 0;
		const truncated = final.stopReason === "max_tokens";
		let needsBase = !truncated;
		if (truncated) {
			grade = {};
			explanation = "truncated; not judged";
		} else if (variant !== "baseline") {
			if (!base) throw new Error("baseline answer missing");
			let j: Awaited<ReturnType<typeof judgeAnswer>>;
			const baseText = (base as ClaudeResult).text;
			const jfile = jfileOf(pairKey(q.id, final.text, baseText));
			const cachedJ = readJson<Judgment>(jfile);
			if (cachedJ) {
				j = cachedJ;
			} else {
				try {
					j = await judgeAnswer(runClaude, {
						id: q.id,
						setup: sha(final.text),
						question: q.prompt,
						baseline: baseText,
						candidate: final.text,
						timeoutMs,
					});
				} catch (err) {
					logError(outDir, variant, q.id, "judge", err);
					return;
				}
				writeFileSync(jfile, JSON.stringify(j));
			}
			grade = { win: j.win, both_bad: j.bothBad };
			if (j.baselineAcceptable !== null)
				baseVerdicts.push(j.baselineAcceptable);
			if (j.acceptable !== null) {
				grade = { acceptable: j.acceptable, ...grade };
				needsBase = false;
			}
			explanation = j.reason;
			if (j.judge) {
				judgeModel = j.judge.model;
				judgeUsage = j.judge.usage;
				judgeCost = j.judge.costUsd;
			}
		}
		const usage = parts.reduce(
			(s, p) => ({
				input_tokens: s.input_tokens + p.r.usage.input_tokens,
				output_tokens: s.output_tokens + p.r.usage.output_tokens,
				cache_read_input_tokens:
					s.cache_read_input_tokens + p.r.usage.cache_read_input_tokens,
				cache_creation_input_tokens:
					s.cache_creation_input_tokens + p.r.usage.cache_creation_input_tokens,
			}),
			{
				input_tokens: 0,
				output_tokens: 0,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		);
		const latencyMs =
			parts.reduce((s, p) => s + p.r.durationMs, 0) + extra.latencyMs;
		const row = {
			prompt_id: q.id,
			prompt: q.prompt,
			tags: [q.category, tag],
			model: final.model,
			usage,
			cost_usd: parts.reduce((s, p) => s + p.r.costUsd, 0),
			latency_s: latencyMs / 1000,
			status: truncated ? "truncated" : "ok",
			stop_reason: final.stopReason,
			grade,
			explanation,
			judge_model: judgeModel ?? (variant === "baseline" ? null : JUDGE_MODEL),
			judge_usage: judgeUsage,
			judge_cost_usd: judgeCost,
			meta: {
				...extra.meta,
				jev_cost_usd: extra.jevCost,
				reused: parts.every((p) => p.reused),
				attempts: parts.reduce((s, p) => s + (p.r.attempts ?? 1), 0),
				judge_version: JUDGE_VERSION,
				...(variant === "v2" || variant === "v3" ? { tiers_fp: fp } : {}),
			},
		};
		mkdirSync(join(outDir, variant, "traces"), { recursive: true });
		writeFileSync(
			join(outDir, variant, "traces", `${q.id}_rep0.json`),
			JSON.stringify(
				[
					{ role: "system", content: SYSTEM },
					{ role: "user", content: q.prompt },
					{ role: "assistant", content: final.text },
				],
				null,
				2,
			),
		);
		pending.push({ variant, row, needsBase });
	};

	/** Baseline acceptability: mean over this question's judged comparisons, else one single-answer judge call. */
	const baselineAcceptability = async (): Promise<{
		acceptable: number;
		explanation: string;
		judge: ClaudeResult | null;
	} | null> => {
		const verdicts = baseVerdicts;
		if (verdicts.length) {
			const yes = verdicts.filter((x) => x === 1).length;
			return {
				acceptable: yes / verdicts.length,
				explanation: `reference setup; acceptable in ${yes}/${verdicts.length} judged comparisons`,
				judge: null,
			};
		}
		const text = (base as ClaudeResult).text;
		const file = jfileOf(baseKey(q.id, text));
		let c = readJson<{
			acceptable: number;
			reason: string;
			judge: ClaudeResult;
		}>(file);
		if (!c) {
			try {
				c = await judgeAcceptable(runClaude, {
					question: q.prompt,
					answer: text,
					timeoutMs,
				});
			} catch (err) {
				logError(outDir, "baseline", q.id, "judge", err);
				return null;
			}
			writeFileSync(file, JSON.stringify(c));
		}
		return {
			acceptable: c.acceptable,
			explanation: `reference setup; ${c.reason}`,
			judge: c.judge,
		};
	};

	/** Write pending rows: v1-v3 first, then the baseline row (its grade depends on their judgments). */
	const flush = async (): Promise<void> => {
		const b = pending.some((p) => p.needsBase)
			? await baselineAcceptability()
			: null;
		pending.sort(
			(x, y) =>
				Number(x.variant === "baseline") - Number(y.variant === "baseline"),
		);
		for (const p of pending) {
			if (p.needsBase) {
				if (!b) {
					logError(
						outDir,
						p.variant,
						q.id,
						"judge",
						new Error("baseline acceptability unavailable"),
					);
					continue;
				}
				p.row.grade = { acceptable: b.acceptable, ...p.row.grade };
				if (p.variant === "baseline") {
					p.row.explanation = b.explanation;
					if (b.judge) {
						p.row.judge_model = b.judge.model;
						p.row.judge_usage = b.judge.usage;
						p.row.judge_cost_usd = b.judge.costUsd;
					}
				}
			}
			writeRow(join(outDir, p.variant), p.row as unknown as RowLike);
		}
	};

	const attempt = async (variant: Variant, fn: () => Promise<void>) => {
		try {
			await fn();
		} catch (err) {
			logError(outDir, variant, q.id, "answer", err);
		}
	};

	const bAns = await baseAnswer().catch((err) => {
		logError(outDir, "baseline", q.id, "answer", err);
		return null;
	});
	if (!bAns) return;

	const run = async (): Promise<void> => {
		if (todo.includes("baseline")) {
			await attempt("baseline", () =>
				emit("baseline", "opus-medium", bAns.r, [bAns], {
					latencyMs: 0,
					jevCost: 0,
					meta: {},
				}),
			);
		}
		if (todo.includes("v1")) {
			await attempt("v1", async () => {
				const a = await answer({ model: OPUS, effort: "low" });
				await emit("v1", "opus-low", a.r, [a], {
					latencyMs: 0,
					jevCost: 0,
					meta: {},
				});
			});
		}
		if (!todo.includes("v2") && !todo.includes("v3")) return;

		let rd: RouteDecision;
		try {
			rd = await getRoute();
		} catch (err) {
			logError(outDir, "v2", q.id, "route", err);
			logError(outDir, "v3", q.id, "route", err);
			return;
		}
		const routeMeta = {
			route: { tier: rd.tier, reason: rd.reason, confidence: rd.confidence },
			route_error: rd.error,
		};
		const routeJev = rd.jevCostUsd ?? 0;
		const routeLat = rd.jevLatencyMs ?? 0;

		let v2: { r: ClaudeResult; reused: boolean } | null = null;
		const getV2 = async () => {
			v2 = v2 ?? (await answer(cfgOf(rd.tier)));
			return v2;
		};
		if (todo.includes("v2")) {
			await attempt("v2", async () => {
				const a = await getV2();
				await emit("v2", rd.tier, a.r, [a], {
					latencyMs: routeLat,
					jevCost: routeJev,
					meta: routeMeta,
				});
			});
		}
		if (todo.includes("v3")) {
			await attempt("v3", async () => {
				if (rd.tier === "haiku") {
					const a = await getV2();
					await emit("v3", rd.tier, a.r, [a], {
						latencyMs: routeLat,
						jevCost: routeJev,
						meta: { ...routeMeta, cascade: { outcome: "routed-haiku" } },
					});
					return;
				}
				const h = await answer({ model: HAIKU.model });
				const jfile = jfileOf(cascadeKey(q.id, h.r.text));
				let c = readJson<CascadeOutcome>(jfile);
				if (!c) {
					c = await deps.cascade(body, {
						id: `msg_eval_${q.id}`,
						type: "message",
						role: "assistant",
						model: h.r.model,
						content: [{ type: "text", text: h.r.text }],
						stop_reason: h.r.stopReason ?? "end_turn",
						stop_sequence: null,
						usage: h.r.usage,
					});
					writeFileSync(jfile, JSON.stringify(c));
				}
				const accepted =
					c.passProbability !== null && c.passProbability >= ACCEPT_THRESHOLD;
				const cascadeMeta = {
					outcome: accepted ? "accepted" : "escalated",
					pass_probability: c.passProbability,
					error: c.error,
				};
				const jev = routeJev + (c.jevCostUsd ?? 0);
				const lat = routeLat + (c.jevLatencyMs ?? 0);
				if (accepted) {
					await emit("v3", rd.tier, h.r, [h], {
						latencyMs: lat,
						jevCost: jev,
						meta: { ...routeMeta, cascade: cascadeMeta },
					});
				} else {
					const a = await getV2();
					await emit("v3", rd.tier, a.r, [h, a], {
						latencyMs: lat,
						jevCost: jev,
						meta: { ...routeMeta, cascade: cascadeMeta },
					});
				}
			});
		}
	};
	await run();
	await flush();
}

/** Run questions with bounded concurrency (one question's setups run sequentially so answers are reused). */
export async function runAll(
	questions: Question[],
	deps: Deps,
	concurrency: number,
): Promise<void> {
	writeState(deps.outDir);
	let next = 0;
	const worker = async () => {
		while (next < questions.length) {
			const q = questions[next++] as Question;
			await runQuestion(q, deps);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
}

const listDir = (d: string): string[] => (existsSync(d) ? readdirSync(d) : []);

/**
 * Seed a new run directory from an old one: copy `_answers/` and `_judgments/` (never overwriting),
 * and migrate current-version old-scheme judgments (`{id}__{variant}__j{N}.json`, `{id}__cascade.json`)
 * to the content-keyed names. Files whose answer text cannot be determined are skipped. Never writes to `src`.
 */
export function seedFrom(
	src: string,
	dst: string,
): { copied: number; migrated: number; skipped: number } {
	let copied = 0;
	let migrated = 0;
	let skipped = 0;
	for (const d of ["_answers", "_judgments"]) {
		mkdirSync(join(dst, d), { recursive: true });
		for (const f of listDir(join(src, d))) {
			const to = join(dst, d, f);
			if (existsSync(to)) continue;
			copyFileSync(join(src, d, f), to);
			copied++;
		}
	}
	const answerText = (
		id: string,
		model: string,
		effort: string,
	): string | null =>
		readJson<{ text?: string }>(
			join(src, "_answers", `${id}__${model}__${effort}.json`),
		)?.text ?? null;
	const put = (name: string, data: unknown): void => {
		const to = join(dst, "_judgments", name);
		if (existsSync(to)) return;
		writeFileSync(to, JSON.stringify(data));
		migrated++;
	};
	const oldJ = new RegExp(
		`^(\\d+)__(baseline|v1|v2|v3)__j${JUDGE_VERSION}\\.json$`,
	);
	for (const f of listDir(join(src, "_judgments"))) {
		const p = join(src, "_judgments", f);
		const m = oldJ.exec(f);
		if (m) {
			const id = Number(m[1]);
			const old = readJson<Record<string, unknown> & { text?: string }>(p);
			const { text, ...j } = old ?? {};
			const base = answerText(String(id), OPUS, "medium");
			if (!old || typeof text !== "string" || base === null) {
				skipped++;
				continue;
			}
			if (m[2] === "baseline") {
				// the single-answer file's text is the baseline answer it judged
				if (text !== base) {
					skipped++;
					continue;
				}
				put(`${baseKey(id, base)}.json`, j);
			} else {
				put(`${pairKey(id, text, base)}.json`, j);
			}
			continue;
		}
		const c = /^(\d+)__cascade\.json$/.exec(f);
		if (c) {
			const h = answerText(c[1] as string, HAIKU.model, "none");
			if (h === null) {
				skipped++;
				continue;
			}
			put(`${cascadeKey(Number(c[1]), h)}.json`, readJson(p));
		}
	}
	return { copied, migrated, skipped };
}
