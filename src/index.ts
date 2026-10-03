import { computeStats, withBaseline } from "./dashboard/stats";
import { createJevClient } from "./jev/client";
import { costUsd } from "./pricing";
import { createRouter } from "./routing/router";
import { ALL_TIERS, type Tier } from "./routing/tiers";
import { createApp } from "./server";
import { createStore } from "./store/db";

const port = Number(process.env.PORT ?? 8787);
const upstreamBaseURL =
	process.env.UPSTREAM_BASE_URL ?? "https://api.anthropic.com";
const store = createStore(process.env.GATEWAY_DB ?? "jev-gateway.db");

const jevMode = process.env.JEV_MODE === "live" ? "live" : "mock";
const budgetLimit = Number(process.env.JEV_BUDGET_USD ?? 1);
const timeoutMs = Number(process.env.JEV_TIMEOUT_MS ?? 800);
const defaultTier = process.env.ROUTER_DEFAULT_TIER ?? "opus-medium";
if (!ALL_TIERS.includes(defaultTier as Tier)) {
	throw new Error(
		`ROUTER_DEFAULT_TIER "${defaultTier}" is not one of ${ALL_TIERS.join(", ")}`,
	);
}
const baselineTier = process.env.BASELINE_TIER ?? "opus-medium";
if (!ALL_TIERS.includes(baselineTier as Tier)) {
	throw new Error(
		`BASELINE_TIER "${baselineTier}" is not one of ${ALL_TIERS.join(", ")}`,
	);
}
let spent = store.jevSpentUsd();
const router = createRouter({
	jev: createJevClient({
		mode: jevMode,
		apiKey: process.env.TYPESAFE_API_KEY,
		timeoutMs,
	}),
	budget: {
		remainingUsd: () => budgetLimit - spent,
		charge: (usd) => {
			spent += usd;
		},
	},
	defaultTier: defaultTier as Tier,
	minConfidence: Number(process.env.ROUTER_MIN_CONFIDENCE ?? 0.5),
	timeoutMs,
});

const app = createApp({
	upstreamBaseURL,
	router,
	makeJevClient: (key) =>
		createJevClient({ mode: "live", apiKey: key, timeoutMs }),
	dashboard: {
		stats: () =>
			computeStats(store.recent(1_000_000), {
				baselineTier: baselineTier as Tier,
				jevBudgetUsd: budgetLimit,
			}),
		requests: (n) => withBaseline(store.recent(n), baselineTier as Tier),
		htmlPath: new URL("./dashboard/index.html", import.meta.url).pathname,
	},
	onRecord: (record) =>
		store.insert(
			record,
			record.usage ? costUsd(record.upstreamModel, record.usage) : null,
		),
});

// idleTimeout 0: streamed responses can sit quiet for longer than Bun's 10s default.
// Localhost only by default: the dashboard and request log need no API key.
const hostname = process.env.HOST ?? "127.0.0.1";
Bun.serve({ port, hostname, fetch: app.fetch, idleTimeout: 0 });
console.log(
	`jev-gateway listening on http://localhost:${port} → ${upstreamBaseURL}`,
);
console.log(
	`jev mode=${jevMode} budget remaining=$${(budgetLimit - spent).toFixed(4)} default tier=${defaultTier}`,
);
console.log(`dashboard: http://localhost:${port}/dashboard`);
