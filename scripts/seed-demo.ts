import { existsSync } from "node:fs";
import { costUsd } from "../src/pricing";
import { ALL_TIERS, TIERS, type Tier } from "../src/routing/tiers";
import { createStore } from "../src/store/db";
import type {
	CacheLookup,
	CascadeAttempt,
	RequestRecord,
	RouteDecision,
	ToolTrim,
} from "../src/types";

const path = process.argv[2] ?? "demo.db";
if (existsSync(path)) {
	console.error(
		`${path} already exists; refusing to seed into it. Pick a new path or delete the file.`,
	);
	process.exit(1);
}

function mulberry32(seed: number) {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const rand = mulberry32(20260925);
const between = (lo: number, hi: number) => lo + rand() * (hi - lo);
const int = (lo: number, hi: number) => Math.round(between(lo, hi));

// Separate stream so tool-trim data doesn't shift the other seeded values.
const trimRand = mulberry32(20261003);
const trimBetween = (lo: number, hi: number) => lo + trimRand() * (hi - lo);
const trimInt = (lo: number, hi: number) => Math.round(trimBetween(lo, hi));
// Separate stream so cache lookups don't shift the other seeded values.
const cacheRand = mulberry32(20261010);
const cacheBetween = (lo: number, hi: number) => lo + cacheRand() * (hi - lo);
const cacheInt = (lo: number, hi: number) => Math.round(cacheBetween(lo, hi));

const TOOL_NAMES = [
	"github_create_issue",
	"github_list_prs",
	"github_get_file",
	"github_create_pr",
	"slack_post_message",
	"slack_search",
	"slack_list_channels",
	"fs_read_file",
	"fs_write_file",
	"fs_list_dir",
	"fs_search",
	"sql_query",
	"sql_describe_table",
	"jira_create_ticket",
	"jira_search",
	"calendar_list_events",
	"calendar_create_event",
	"email_send",
	"email_search",
	"web_search",
	"web_fetch",
	"shell_exec",
	"docker_ps",
	"docker_logs",
	"k8s_get_pods",
	"k8s_apply",
	"s3_list_objects",
	"s3_get_object",
	"stripe_list_charges",
	"stripe_refund",
	"notion_search",
	"notion_create_page",
	"linear_create_issue",
	"linear_list_issues",
	"pagerduty_ack",
	"datadog_query",
	"sentry_list_issues",
	"figma_get_file",
	"gdrive_search",
	"gdrive_read",
	"zendesk_get_ticket",
	"hubspot_find_contact",
	"twilio_send_sms",
	"redis_get",
	"mongo_find",
	"terraform_plan",
	"npm_search",
	"pypi_search",
	"weather_lookup",
	"translate_text",
	"image_resize",
	"pdf_extract_text",
	"csv_parse",
	"json_validate",
	"regex_test",
	"http_request",
	"dns_lookup",
	"git_diff",
	"git_log",
	"git_commit",
];

function makeToolTrim(): ToolTrim {
	const offered = trimInt(15, 60);
	const names = [...TOOL_NAMES].sort(() => trimRand() - 0.5).slice(0, offered);
	const jevCostUsd = ((offered * 70 + 300) * 0.042) / 1e6;
	const jevLatencyMs = trimInt(250, 700);
	if (trimRand() < 0.05) {
		return {
			offered,
			kept: offered,
			removed: [],
			estimatedTokensSaved: 0,
			scores: null,
			jevLatencyMs: null,
			jevCostUsd: null,
			error: "timeout",
		};
	}
	const scores: Record<string, number> = {};
	for (const n of names) {
		scores[n] =
			trimRand() < 0.2 ? trimBetween(0.5, 0.98) : trimBetween(0.01, 0.35);
	}
	const top5 = new Set(
		Object.entries(scores)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 5)
			.map(([n]) => n),
	);
	const removed = names.filter((n) => (scores[n] ?? 1) < 0.2 && !top5.has(n));
	return {
		offered,
		kept: offered - removed.length,
		removed,
		estimatedTokensSaved: removed.reduce((a) => a + trimInt(120, 400), 0),
		scores,
		jevLatencyMs,
		jevCostUsd,
		error: null,
	};
}

const WEIGHTS: Array<[Tier, number]> = [
	["haiku", 0.3],
	["sonnet-low", 0.25],
	["sonnet-high", 0.15],
	["opus-low", 0.1],
	["opus-medium", 0.1],
	["opus-high", 0.08],
	["fable-high", 0.02],
];
function pickTier(): Tier {
	const x = rand();
	let acc = 0;
	for (const [tier, w] of WEIGHTS) {
		acc += w;
		if (x < acc) return tier;
	}
	return "haiku";
}

/** The chosen tier gets `confidence`; the rest share the remainder. */
function probabilities(
	chosen: Tier,
	confidence: number,
): Record<string, number> {
	const raw = ALL_TIERS.map((t) => (t === chosen ? 0 : between(0.05, 1)));
	const total = raw.reduce((a, b) => a + b, 0);
	return Object.fromEntries(
		ALL_TIERS.map((t, i) => [
			t,
			t === chosen ? confidence : ((raw[i] ?? 0) / total) * (1 - confidence),
		]),
	);
}

/** Router rule: minConfidence 0.5. Jev is mostly very sure (0.85-1.0). */
function confidenceFor(reason: RouteDecision["reason"]): number {
	if (reason === "low-confidence") return between(0.3, 0.49);
	return rand() < 0.8 ? between(0.85, 1) : between(0.6, 0.85);
}

const store = createStore(path);
const now = Date.now();
const SIX_HOURS = 6 * 3_600_000;
let count = 0;

const seededIds: string[] = [];

/** ~35% hits; misses are mostly stored, some with no candidates, some Jev-rejected. */
function makeCache(): CacheLookup {
	if (cacheRand() < 0.35) {
		return {
			outcome: "hit",
			candidates: cacheInt(1, 3),
			bestSimilarity: cacheBetween(0.85, 0.98),
			matchProbability: cacheBetween(0.86, 0.99),
			sourceRequestId:
				seededIds[Math.floor(cacheRand() * seededIds.length)] ?? null,
			jevLatencyMs: cacheInt(250, 650),
			jevCostUsd: cacheBetween(0.00003, 0.0001),
			lookupMs: cacheInt(250, 650),
			stored: false,
			error: null,
		};
	}
	const stored = cacheRand() < 0.85;
	if (cacheRand() < 0.5) {
		const some = cacheRand() < 0.4;
		return {
			outcome: "miss",
			candidates: some ? cacheInt(1, 3) : 0,
			bestSimilarity: some ? cacheBetween(0.4, 0.79) : null,
			matchProbability: null,
			sourceRequestId: null,
			jevLatencyMs: null,
			jevCostUsd: null,
			lookupMs: cacheInt(5, 40),
			stored,
			error: null,
		};
	}
	return {
		outcome: "miss",
		candidates: cacheInt(1, 3),
		bestSimilarity: cacheBetween(0.8, 0.95),
		matchProbability: cacheBetween(0.1, 0.84),
		sourceRequestId: null,
		jevLatencyMs: cacheInt(250, 650),
		jevCostUsd: cacheBetween(0.00003, 0.0001),
		lookupMs: cacheInt(250, 650),
		stored,
		error: null,
	};
}

function insert(
	r: Omit<RequestRecord, "id" | "startedAt">,
	costOverride?: number,
) {
	const startedAt = now - Math.floor(rand() * SIX_HOURS);
	const record = { ...r, id: crypto.randomUUID(), startedAt };
	store.insert(
		record,
		costOverride ??
			(record.usage
				? (costUsd(record.upstreamModel, record.usage) ?? 0) +
					(record.cascade?.wastedCostUsd ?? 0)
				: null),
	);
	if (record.endpoint === "messages" && record.usage) seededIds.push(record.id);
	count++;
}

for (let i = 0; i < 300; i++) {
	const tier = pickTier();
	const rank = TIERS[tier].rank;
	const failed = rand() < 0.03;
	const routed = rand() >= 0.05;
	const explicit = routed ? null : "claude-opus-5-5";
	const usage = failed
		? null
		: {
				input_tokens: int(200 + rank * 1500, 2000 + rank * 3000),
				output_tokens: int(50 + rank * 100, 400 + rank * 600),
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: rand() < 0.4 ? int(500, 8000) : 0,
			};
	let route: RouteDecision | undefined;
	if (routed) {
		const p = rand();
		const reason: RouteDecision["reason"] =
			p < 0.85
				? "jev"
				: p < 0.92
					? "sticky"
					: p < 0.97
						? "low-confidence"
						: "fallback";
		const routedTier = reason === "low-confidence" ? "opus-medium" : tier;
		const base = {
			tier: routedTier,
			reason,
			jevLatencyMs: int(250, 600),
			jevCostUsd: between(0.000027, 0.00003),
		};
		if (reason === "fallback") {
			route = {
				...base,
				confidence: null,
				probabilities: null,
				jevLatencyMs: null,
				jevCostUsd: null,
				error: "Jev request timed out",
			};
		} else {
			const confidence = confidenceFor(reason);
			const probs = probabilities(tier, confidence);
			route = {
				...base,
				confidence,
				probabilities: probs,
				error: null,
			};
		}
	}
	let upstreamModel = route ? TIERS[route.tier].model : (explicit ?? "");
	let finalUsage = usage;
	let cascade: CascadeAttempt | undefined;
	if (
		route &&
		route.reason !== "fallback" && // the server never cascades after a router fallback
		!failed &&
		usage &&
		TIERS[route.tier].rank > 0 &&
		rand() < 0.25
	) {
		const small = {
			input_tokens: int(200, 2000),
			output_tokens: int(50, 400),
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 0,
		};
		const base = {
			firstTier: "haiku" as const,
			escalationTier: route.tier,
			jevLatencyMs: int(250, 600),
			jevCostUsd: 0.00003,
		};
		if (rand() < 0.6) {
			cascade = {
				...base,
				accepted: true,
				passProbability: between(0.7, 0.98),
				wastedUsage: null,
				wastedCostUsd: 0,
				error: null,
			};
			finalUsage = small;
			upstreamModel = TIERS.haiku.model;
		} else {
			const noProb = rand() < 0.15;
			cascade = {
				...base,
				accepted: false,
				passProbability: noProb ? null : between(0.1, 0.69),
				wastedUsage: small,
				wastedCostUsd: costUsd("claude-haiku-4-5", small) ?? 0,
				error: noProb ? "stop_reason max_tokens" : null,
			};
		}
	}
	const toolTrim = trimRand() < 0.15 ? makeToolTrim() : undefined;
	const cache =
		!toolTrim && !cascade && !failed && cacheRand() < 0.12
			? makeCache()
			: undefined;
	const hit = cache?.outcome === "hit";
	const latencyMs = int(400, 9000);
	insert(
		{
			latencyMs: hit ? cache.lookupMs + cacheInt(5, 30) : latencyMs,
			endpoint: "messages",
			requestedModel: routed ? "auto" : upstreamModel,
			upstreamModel,
			stream: rand() < 0.6,
			status: failed ? (rand() < 0.5 ? 429 : 500) : 200,
			usage: finalUsage,
			error: failed ? "upstream error" : null,
			...(route ? { route } : {}),
			...(cascade ? { cascade } : {}),
			...(toolTrim ? { toolTrim } : {}),
			...(cache ? { cache } : {}),
		},
		hit ? 0 : undefined,
	);
}
for (let i = 0; i < 10; i++) {
	insert({
		latencyMs: int(80, 300),
		endpoint: "count_tokens",
		requestedModel: "auto",
		upstreamModel: "claude-opus-5-5",
		stream: false,
		status: 200,
		usage: null,
		error: null,
	});
}
store.close();
console.log(`Seeded ${count} requests into ${path}`);
console.log(
	`View it: GATEWAY_DB=${path} bun run start, then open http://localhost:8787/dashboard`,
);
