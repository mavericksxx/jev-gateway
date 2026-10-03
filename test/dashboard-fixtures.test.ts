import { expect, test } from "bun:test";
import type { RequestsResponse, StatsResponse } from "../src/dashboard/types";
import { ALL_TIERS, TIERS } from "../src/routing/tiers";

const dir = new URL("../fixtures/dashboard/", import.meta.url);
const stats = (await Bun.file(
	new URL("stats.json", dir),
).json()) as StatsResponse;
const requests = (await Bun.file(
	new URL("requests.json", dir),
).json()) as RequestsResponse;

test("stats has every StatsResponse key", () => {
	for (const k of [
		"generatedAt",
		"baseline",
		"totals",
		"jevLatencyMs",
		"tierMix",
		"reasons",
		"bucketMs",
		"timeline",
	]) {
		expect(stats).toHaveProperty(k);
	}
	for (const k of [
		"requests",
		"routedRequests",
		"errors",
		"actualCostUsd",
		"baselineCostUsd",
		"savedUsd",
		"savedPct",
		"jevSpentUsd",
		"jevBudgetUsd",
		"netSavedUsd",
	]) {
		expect(stats.totals).toHaveProperty(k);
	}
	expect(stats.jevLatencyMs).toHaveProperty("p50");
	expect(stats.jevLatencyMs).toHaveProperty("p95");
	expect(stats.baseline.model).toBe(TIERS[stats.baseline.tier].model);
});

test("tierMix has 7 tiers in TIERS order", () => {
	expect(stats.tierMix.map((t) => t.tier)).toEqual(ALL_TIERS);
	expect(stats.tierMix).toHaveLength(7);
	for (const m of stats.tierMix) expect(m.model).toBe(TIERS[m.tier].model);
});

test("reasons has exactly the 4 keys", () => {
	expect(Object.keys(stats.reasons).sort()).toEqual([
		"fallback",
		"jev",
		"low-confidence",
		"sticky",
	]);
});

test("timeline buckets are contiguous at bucketMs", () => {
	expect(stats.timeline.length).toBeGreaterThan(1);
	for (let i = 1; i < stats.timeline.length; i++) {
		expect(
			(stats.timeline[i]?.bucketStart ?? 0) -
				(stats.timeline[i - 1]?.bucketStart ?? 0),
		).toBe(stats.bucketMs);
	}
});

test("totals are internally consistent", () => {
	const t = stats.totals;
	expect(t.savedUsd).toBeCloseTo(t.baselineCostUsd - t.actualCostUsd, 6);
	expect(t.netSavedUsd).toBeCloseTo(t.savedUsd - t.jevSpentUsd, 6);
	expect(t.savedPct).toBeCloseTo(t.savedUsd / t.baselineCostUsd, 6);
	expect(t.requests).toBe(requests.length);
});

test("requests are newest-first with all fields", () => {
	for (let i = 1; i < requests.length; i++) {
		expect(requests[i]?.startedAt ?? 0).toBeLessThanOrEqual(
			requests[i - 1]?.startedAt ?? 0,
		);
	}
	for (const r of requests) {
		for (const k of [
			"id",
			"startedAt",
			"latencyMs",
			"endpoint",
			"requestedModel",
			"upstreamModel",
			"stream",
			"status",
			"usage",
			"error",
			"costUsd",
			"baselineCostUsd",
		]) {
			expect(r).toHaveProperty(k);
		}
		if (r.route?.probabilities) {
			const sum = Object.values(r.route.probabilities).reduce(
				(a, b) => a + b,
				0,
			);
			expect(sum).toBeCloseTo(1, 2);
		}
	}
	expect(requests.some((r) => r.route)).toBe(true);
	expect(requests.some((r) => !r.route)).toBe(true);
});

test("index.html has no network references and no innerHTML", async () => {
	const html = await Bun.file(
		new URL("../src/dashboard/index.html", import.meta.url),
	).text();
	// the SVG namespace URI is an identifier, not a fetched resource
	const stripped = html.replace("http://www.w3.org/2000/svg", "");
	expect(stripped).not.toMatch(/https?:\/\//);
	expect(html).not.toContain("innerHTML");
});
