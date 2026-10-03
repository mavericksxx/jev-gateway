import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VARIANTS } from "./lib/runner";

export interface Row {
	grade: { win?: number; both_bad?: number };
	cost_usd: number;
	judge_cost_usd: number;
	latency_s: number;
	status: string;
	meta: {
		jev_cost_usd?: number;
		route?: { tier: string };
		cascade?: { outcome: string };
	};
}

export interface VariantSummary {
	graded: number;
	mean_win: number;
	ci95: [number, number];
	wins: number;
	ties: number;
	losses: number;
	both_bad: number;
	answer_cost_usd: number;
	answer_cost_per_question_usd: number;
	judge_cost_usd: number;
	jev_cost_usd: number;
	median_latency_s: number;
	tier_mix?: Record<string, number>;
	cascade_accept_rate?: number | null;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function median(xs: number[]): number {
	if (!xs.length) return 0;
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2
		? (s[m] as number)
		: ((s[m - 1] as number) + (s[m] as number)) / 2;
}

export function summarizeVariant(rows: Row[]): VariantSummary {
	const graded = rows.filter((r) => r.grade.win !== undefined);
	const wins = graded.map((r) => r.grade.win as number);
	const n = wins.length;
	const mean = n ? sum(wins) / n : 0;
	const sd =
		n > 1 ? Math.sqrt(sum(wins.map((w) => (w - mean) ** 2)) / (n - 1)) : 0;
	const half = n ? (1.96 * sd) / Math.sqrt(n) : 0;
	const bothBad = graded.filter((r) => r.grade.both_bad === 1);
	const clean = graded.filter((r) => r.grade.both_bad !== 1);
	const tiers: Record<string, number> = {};
	for (const r of rows) {
		const t = r.meta.route?.tier;
		if (t) tiers[t] = (tiers[t] ?? 0) + 1;
	}
	const cas = rows.filter(
		(r) => r.meta.cascade && r.meta.cascade.outcome !== "routed-haiku",
	);
	const cost = sum(rows.map((r) => r.cost_usd));
	return {
		graded: n,
		mean_win: mean,
		ci95: [mean - half, mean + half],
		wins: clean.filter((r) => r.grade.win === 1).length,
		ties: clean.filter((r) => r.grade.win === 0.5).length,
		losses: clean.filter((r) => r.grade.win === 0).length,
		both_bad: bothBad.length,
		answer_cost_usd: cost,
		answer_cost_per_question_usd: rows.length ? cost / rows.length : 0,
		judge_cost_usd: sum(rows.map((r) => r.judge_cost_usd ?? 0)),
		jev_cost_usd: sum(rows.map((r) => r.meta.jev_cost_usd ?? 0)),
		median_latency_s: median(rows.map((r) => r.latency_s)),
		...(Object.keys(tiers).length ? { tier_mix: tiers } : {}),
		...(cas.length || rows.some((r) => r.meta.cascade)
			? {
					cascade_accept_rate: cas.length
						? cas.filter((r) => r.meta.cascade?.outcome === "accepted").length /
							cas.length
						: null,
				}
			: {}),
	};
}

export function renderMarkdown(s: Record<string, VariantSummary>): string {
	const f = (x: number, d = 4) => x.toFixed(d);
	const lines = [
		"| setup | n | mean win (95% CI) | W/T/L | both bad | answer $ | $/question | judge $ | Jev $ | median latency s |",
		"|---|---|---|---|---|---|---|---|---|---|",
	];
	for (const [v, x] of Object.entries(s)) {
		lines.push(
			`| ${v} | ${x.graded} | ${f(x.mean_win, 3)} (${f(x.ci95[0], 3)}, ${f(x.ci95[1], 3)}) | ${x.wins}/${x.ties}/${x.losses} | ${x.both_bad} | ${f(x.answer_cost_usd)} | ${f(x.answer_cost_per_question_usd)} | ${f(x.judge_cost_usd)} | ${f(x.jev_cost_usd, 6)} | ${f(x.median_latency_s, 1)} |`,
		);
	}
	for (const [v, x] of Object.entries(s)) {
		if (x.tier_mix)
			lines.push("", `${v} tier mix: ${JSON.stringify(x.tier_mix)}`);
		if (x.cascade_accept_rate !== undefined)
			lines.push(
				`${v} cascade accept rate: ${x.cascade_accept_rate === null ? "n/a" : f(x.cascade_accept_rate, 3)}`,
			);
	}
	return `${lines.join("\n")}\n`;
}

export function summarizeDir(dir: string): Record<string, VariantSummary> {
	const out: Record<string, VariantSummary> = {};
	for (const v of VARIANTS) {
		const p = join(dir, v, "results.jsonl");
		if (!existsSync(p)) continue;
		const rows = readFileSync(p, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as Row);
		out[v] = summarizeVariant(rows);
	}
	return out;
}

if (import.meta.main) {
	const dir = new URL("./runs/mt-bench", import.meta.url).pathname;
	const s = summarizeDir(dir);
	const md = renderMarkdown(s);
	writeFileSync(join(dir, "summary.json"), JSON.stringify(s, null, 2));
	writeFileSync(join(dir, "summary.md"), md);
	console.log(md);
}
