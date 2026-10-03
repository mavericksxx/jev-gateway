import { existsSync } from "node:fs";
import { costUsd } from "../src/pricing";
import { ALL_TIERS, TIERS, type Tier } from "../src/routing/tiers";
import { createStore } from "../src/store/db";
import type {
	CascadeAttempt,
	RequestRecord,
	RouteDecision,
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

function insert(r: Omit<RequestRecord, "id" | "startedAt">) {
	const startedAt = now - Math.floor(rand() * SIX_HOURS);
	const record = { ...r, id: crypto.randomUUID(), startedAt };
	store.insert(
		record,
		record.usage
			? (costUsd(record.upstreamModel, record.usage) ?? 0) +
					(record.cascade?.wastedCostUsd ?? 0)
			: null,
	);
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
	insert({
		latencyMs: int(400, 9000),
		endpoint: "messages",
		requestedModel: routed ? "auto" : upstreamModel,
		upstreamModel,
		stream: rand() < 0.6,
		status: failed ? (rand() < 0.5 ? 429 : 500) : 200,
		usage: finalUsage,
		error: failed ? "upstream error" : null,
		...(route ? { route } : {}),
		...(cascade ? { cascade } : {}),
	});
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
