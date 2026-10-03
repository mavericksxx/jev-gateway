import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store/db";
import type { RequestRecord } from "../src/types";

const a: RequestRecord = {
	id: "a",
	startedAt: 1000,
	latencyMs: 120,
	endpoint: "messages",
	requestedModel: "claude-haiku-4-5",
	upstreamModel: "claude-haiku-4-5",
	stream: true,
	status: 200,
	usage: {
		input_tokens: 10,
		output_tokens: 20,
		cache_creation_input_tokens: 3,
		cache_read_input_tokens: 4,
	},
	error: null,
};
const b: RequestRecord = {
	id: "b",
	startedAt: 2000,
	latencyMs: 50,
	endpoint: "count_tokens",
	requestedModel: "claude-opus-5-5",
	upstreamModel: "claude-opus-5-5",
	stream: false,
	status: 502,
	usage: null,
	error: "boom",
};

test("recent returns newest first and round-trips fields", () => {
	const store = createStore(":memory:");
	store.insert(a, 0.000123);
	store.insert(b, null);
	expect(store.recent(10)).toEqual([
		{ ...b, costUsd: null },
		{ ...a, costUsd: 0.000123 },
	]);
	expect(store.recent(1)).toEqual([{ ...b, costUsd: null }]);
	store.close();
});

test("file database persists across close and reopen", () => {
	const dir = mkdtempSync(join(tmpdir(), "jev-store-"));
	const path = join(dir, "test.db");
	try {
		const first = createStore(path);
		first.insert(a, 1.5);
		first.close();
		const second = createStore(path);
		expect(second.recent(10)).toEqual([{ ...a, costUsd: 1.5 }]);
		second.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

const routed: RequestRecord = {
	...a,
	id: "r",
	startedAt: 3000,
	route: {
		tier: "sonnet-low",
		reason: "jev",
		confidence: 0.9,
		probabilities: { "sonnet-low": 0.9, haiku: 0.1 },
		jevLatencyMs: 40,
		jevCostUsd: 0.002,
		error: null,
	},
};

test("route decision round-trips", () => {
	const store = createStore(":memory:");
	store.insert(routed, 0.1);
	expect(store.recent(1)).toEqual([{ ...routed, costUsd: 0.1 }]);
	store.close();
});

test("jevSpentUsd sums route costs", () => {
	const store = createStore(":memory:");
	expect(store.jevSpentUsd()).toBe(0);
	store.insert(a, null);
	store.insert(routed, null);
	store.insert({ ...routed, id: "r2" }, null);
	expect(store.jevSpentUsd()).toBeCloseTo(0.004);
	store.close();
});

test("opening a Phase 1 database adds route columns and keeps rows", () => {
	const dir = mkdtempSync(join(tmpdir(), "jev-store-"));
	const path = join(dir, "old.db");
	try {
		const old = new Database(path);
		old.run(`CREATE TABLE requests (
			id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, latency_ms INTEGER NOT NULL,
			endpoint TEXT NOT NULL, requested_model TEXT NOT NULL, upstream_model TEXT NOT NULL,
			stream INTEGER NOT NULL, status INTEGER NOT NULL, input_tokens INTEGER,
			output_tokens INTEGER, cache_creation_input_tokens INTEGER,
			cache_read_input_tokens INTEGER, error TEXT, cost_usd REAL
		)`);
		old.run(
			"INSERT INTO requests VALUES ('o',1,2,'messages','m','m',0,200,1,2,0,0,NULL,0.5)",
		);
		old.close();
		const store = createStore(path);
		store.insert(routed, null);
		const rows = store.recent(10);
		expect(rows).toHaveLength(2);
		expect(rows[1]).toMatchObject({ id: "o", costUsd: 0.5 });
		expect(rows[1]?.route).toBeUndefined();
		expect(rows[0]?.route?.tier).toBe("sonnet-low");
		store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
