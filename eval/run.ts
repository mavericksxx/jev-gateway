import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createCascadeJudge } from "../src/cascade/judge";
import { createJevClient } from "../src/jev/client";
import { createRouter, type JevBudget } from "../src/routing/router";
import { runClaudeCli } from "./lib/claude";
import { judgeSelftest } from "./lib/judge";
import { type Deps, type Question, runAll, seedFrom } from "./lib/runner";

export const OUT_DIR = new URL("./runs/mt-bench", import.meta.url).pathname;

const arg = (name: string): string | undefined => {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string): boolean => process.argv.includes(name);

export function loadQuestions(
	mode: { pilot?: boolean; ids?: number[]; heldout?: boolean } = {},
): Question[] {
	if ([mode.pilot, mode.ids, mode.heldout].filter(Boolean).length > 1)
		throw new Error("--pilot, --ids and --heldout are mutually exclusive");
	const dir = new URL("./data/", import.meta.url).pathname;
	const sel = JSON.parse(readFileSync(`${dir}selection.json`, "utf8")) as {
		ids: number[];
		pilot: number[];
	};
	const byId = new Map<number, Question>();
	for (const line of readFileSync(`${dir}mt-bench-questions.jsonl`, "utf8")
		.split("\n")
		.filter(Boolean)) {
		const r = JSON.parse(line) as {
			question_id: number;
			category: string;
			turns: string[];
		};
		byId.set(r.question_id, {
			id: r.question_id,
			category: r.category,
			prompt: r.turns[0] as string,
		});
	}
	const selected = new Set(sel.ids);
	const ids = mode.pilot
		? sel.pilot
		: mode.ids
			? mode.ids
			: mode.heldout
				? [...byId.keys()]
						.filter((id) => !selected.has(id))
						.sort((a, b) => a - b)
				: sel.ids;
	return ids.map((id) => {
		const q = byId.get(id);
		if (!q) throw new Error(`unknown question id ${id}`);
		return q;
	});
}

async function main(): Promise<void> {
	const timeoutMs = Number(arg("--timeout-s") ?? 300) * 1000;
	if (flag("--judge-selftest")) {
		const res = await judgeSelftest(runClaudeCli, timeoutMs);
		for (const r of res)
			console.log(r.name, r.pass ? "PASS" : "FAIL", r.reason);
		process.exit(res.every((r) => r.pass) ? 0 : 1);
	}
	if (!process.env.TYPESAFE_API_KEY)
		throw new Error("TYPESAFE_API_KEY not set (.env)");
	let spent = 0;
	const budget: JevBudget = {
		remainingUsd: () => 0.1 - spent,
		charge: (usd) => {
			spent += usd;
		},
	};
	const jev = createJevClient({ mode: "live" });
	const router = createRouter({
		jev,
		budget,
		defaultTier: "opus-medium",
		minConfidence: 0.5,
		timeoutMs: 2000,
	});
	const cascadeJudge = createCascadeJudge({ jev, budget, timeoutMs: 2000 });
	const outDir = arg("--out") ? resolve(arg("--out") as string) : OUT_DIR;
	const deps: Deps = {
		runClaude: runClaudeCli,
		route: (body) => router.route(body),
		cascade: async (body, message) => {
			const r = await cascadeJudge.judge(
				body,
				message as unknown as Parameters<typeof cascadeJudge.judge>[1],
			);
			return {
				passProbability: r.passProbability,
				jevCostUsd: r.jevCostUsd,
				jevLatencyMs: r.jevLatencyMs,
				error: r.error,
			};
		},
		outDir,
		timeoutMs,
	};
	const ids = arg("--ids");
	const qs = loadQuestions({
		pilot: flag("--pilot"),
		heldout: flag("--heldout"),
		...(ids ? { ids: ids.split(",").map(Number) } : {}),
	});
	const seed = arg("--seed-from");
	if (seed) {
		const r = seedFrom(resolve(seed), outDir);
		console.log(
			`seeded from ${seed}: copied ${r.copied}, migrated ${r.migrated}, skipped ${r.skipped}`,
		);
	}
	await runAll(qs, deps, Number(arg("--concurrency") ?? 2));
	console.log(`done: ${qs.length} questions; Jev spend $${spent.toFixed(5)}`);
}

if (import.meta.main) await main();
