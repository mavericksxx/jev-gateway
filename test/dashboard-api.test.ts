import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeStats, withBaseline } from "../src/dashboard/stats";
import { costUsd } from "../src/pricing";
import { createApp } from "../src/server";
import { createStore } from "../src/store/db";
import type { RequestRecord } from "../src/types";

const dir = mkdtempSync(join(tmpdir(), "dash-"));
const htmlPath = join(dir, "index.html");
const store = createStore(":memory:");
const baselineTier = "opus-medium" as const;

const usage = {
	input_tokens: 1000,
	output_tokens: 500,
	cache_creation_input_tokens: 0,
	cache_read_input_tokens: 0,
};
const rec = (i: number, routed: boolean): RequestRecord => ({
	id: `r${i}`,
	startedAt: 1_000_000 + i * 1000,
	latencyMs: 10,
	endpoint: "messages",
	requestedModel: routed ? "auto" : "claude-opus-5-5",
	upstreamModel: routed ? "claude-haiku-4-5" : "claude-opus-5-5",
	stream: false,
	status: 200,
	usage,
	error: null,
	...(routed
		? {
				route: {
					tier: "haiku" as const,
					reason: "jev" as const,
					confidence: 0.9,
					probabilities: null,
					jevLatencyMs: 300,
					jevCostUsd: 0.00003,
					error: null,
				},
			}
		: {}),
});

const app = createApp({
	upstreamBaseURL: "http://unused",
	onRecord: () => {},
	dashboard: {
		stats: () =>
			computeStats(store.recent(1_000_000), { baselineTier, jevBudgetUsd: 1 }),
		requests: (n) => withBaseline(store.recent(n), baselineTier),
		htmlPath,
	},
});

beforeAll(() => {
	writeFileSync(htmlPath, "<h1>hi</h1>");
	for (let i = 0; i < 3; i++) {
		const r = rec(i, i < 2);
		store.insert(r, costUsd(r.upstreamModel, usage));
	}
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("GET /dashboard serves the html", async () => {
	const res = await app.request("/dashboard");
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
	expect(await res.text()).toBe("<h1>hi</h1>");
});

test("missing html file gives 404", async () => {
	const other = createApp({
		upstreamBaseURL: "http://unused",
		onRecord: () => {},
		dashboard: {
			stats: () => computeStats([], { baselineTier, jevBudgetUsd: 1 }),
			requests: () => [],
			htmlPath: join(dir, "nope.html"),
		},
	});
	expect((await other.request("/dashboard")).status).toBe(404);
});

test("GET / redirects to /dashboard", async () => {
	const res = await app.request("/");
	expect(res.status).toBe(302);
	expect(res.headers.get("location")).toBe("/dashboard");
});

test("/api/stats shape", async () => {
	// biome-ignore lint/suspicious/noExplicitAny: test JSON
	const s: any = await (await app.request("/api/stats")).json();
	expect(s.totals.requests).toBe(3);
	expect(s.totals.routedRequests).toBe(2);
	expect(s.tierMix).toHaveLength(7);
	expect(s.baseline.tier).toBe("opus-medium");
	expect(s.timeline.length).toBeGreaterThan(0);
});

test("/api/requests limit handling", async () => {
	const get = async (q: string) =>
		(await (await app.request(`/api/requests${q}`)).json()) as Array<{
			id: string;
		}>;
	expect(await get("")).toHaveLength(3);
	expect(await get("?limit=2")).toHaveLength(2);
	expect(await get("?limit=0")).toHaveLength(1);
	expect(await get("?limit=-5")).toHaveLength(1);
	expect(await get("?limit=abc")).toHaveLength(3);
	expect(await get("?limit=99999")).toHaveLength(3);
	const first = (await get("?limit=1"))[0];
	expect(first?.id).toBe("r2");
	expect(first).toBeDefined();
	expect(first).toHaveProperty("baselineCostUsd");
});

test("seed-demo seeds once and refuses a second run", () => {
	const d = mkdtempSync(join(tmpdir(), "seed-"));
	const path = join(d, "demo.db");
	try {
		const run = () =>
			Bun.spawnSync(["bun", "run", "scripts/seed-demo.ts", path]);
		expect(run().exitCode).toBe(0);
		const s = createStore(path);
		const rows = s.recent(1_000_000);
		s.close();
		expect(rows.length).toBeGreaterThanOrEqual(300);
		const stats = computeStats(rows, { baselineTier, jevBudgetUsd: 1 });
		expect(stats.totals.savedUsd).toBeGreaterThan(0);
		expect(stats.tierMix).toHaveLength(7);
		expect(stats.timeline.length).toBeGreaterThan(0);
		expect(stats.cascade.attempted).toBeGreaterThan(0);
		expect(stats.toolTrim.trimmed).toBeGreaterThan(0);
		expect(stats.cache.hits).toBeGreaterThan(0);
		for (const r of rows.filter((x) => x.cache)) {
			expect(r.cascade).toBeUndefined();
			expect(r.toolTrim).toBeUndefined();
		}
		for (const r of rows) {
			if (r.route?.reason === "jev") {
				expect(r.route.confidence ?? 1).toBeGreaterThanOrEqual(0.5);
			}
		}
		const again = run();
		expect(again.exitCode).not.toBe(0);
		expect(again.stderr.toString()).toContain("already exists");
	} finally {
		rmSync(d, { recursive: true, force: true });
	}
});
