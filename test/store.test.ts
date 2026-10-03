import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store/db";
import type { CacheLookup, RequestRecord } from "../src/types";

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

const wastedUsage = {
	input_tokens: 100,
	output_tokens: 30,
	cache_creation_input_tokens: 0,
	cache_read_input_tokens: 5,
};
const cascadeBase = {
	firstTier: "haiku",
	escalationTier: "sonnet-low",
	jevLatencyMs: 300,
	jevCostUsd: 0.00003,
	error: null,
} as const;

test("cascade attempts round-trip (accepted and escalated)", () => {
	const store = createStore(":memory:");
	const accepted: RequestRecord = {
		...routed,
		id: "c1",
		startedAt: 4000,
		cascade: {
			...cascadeBase,
			accepted: true,
			passProbability: 0.9,
			wastedUsage: null,
			wastedCostUsd: 0,
		},
	};
	const escalated: RequestRecord = {
		...routed,
		id: "c2",
		startedAt: 5000,
		cascade: {
			...cascadeBase,
			accepted: false,
			passProbability: null,
			wastedUsage,
			wastedCostUsd: 0.0004,
			error: "stop_reason max_tokens",
		},
	};
	store.insert(accepted, 0.1);
	store.insert(escalated, 0.2);
	const plain = { ...routed, id: "p", startedAt: 6000 };
	store.insert(plain, 0.3);
	const rows = store.recent(10);
	expect(rows[0]).toEqual({ ...plain, costUsd: 0.3 });
	expect(rows[0]).not.toHaveProperty("cascade");
	expect(rows[1]).toEqual({ ...escalated, costUsd: 0.2 });
	expect(rows[2]).toEqual({ ...accepted, costUsd: 0.1 });
	store.close();
});

test("jevSpentUsd includes cascade judge cost", () => {
	const store = createStore(":memory:");
	store.insert(routed, null);
	store.insert(
		{
			...a,
			id: "c",
			cascade: {
				...cascadeBase,
				accepted: true,
				passProbability: 0.9,
				wastedUsage: null,
				wastedCostUsd: 0,
			},
		},
		null,
	);
	expect(store.jevSpentUsd()).toBeCloseTo(0.002 + 0.00003);
	store.close();
});

test("opening a Phase 2 database adds cascade columns and keeps rows", () => {
	const dir = mkdtempSync(join(tmpdir(), "jev-store-"));
	const path = join(dir, "p2.db");
	try {
		const old = new Database(path);
		old.run(`CREATE TABLE requests (
			id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, latency_ms INTEGER NOT NULL,
			endpoint TEXT NOT NULL, requested_model TEXT NOT NULL, upstream_model TEXT NOT NULL,
			stream INTEGER NOT NULL, status INTEGER NOT NULL, input_tokens INTEGER,
			output_tokens INTEGER, cache_creation_input_tokens INTEGER,
			cache_read_input_tokens INTEGER, error TEXT, cost_usd REAL,
			route_tier TEXT, route_reason TEXT, route_confidence REAL, route_probabilities TEXT,
			jev_latency_ms INTEGER, jev_cost_usd REAL, route_error TEXT
		)`);
		old.run(
			"INSERT INTO requests (id, started_at, latency_ms, endpoint, requested_model, upstream_model, stream, status, cost_usd, jev_cost_usd) VALUES ('o',1,2,'messages','m','m',0,200,0.5,0.01)",
		);
		old.close();
		const store = createStore(path);
		const cascade = {
			...cascadeBase,
			accepted: true,
			passProbability: 0.8,
			wastedUsage: null,
			wastedCostUsd: 0,
		};
		store.insert({ ...a, id: "n", startedAt: 2, cascade }, null);
		const rows = store.recent(10);
		expect(rows).toHaveLength(2);
		expect(rows[1]).toMatchObject({ id: "o", costUsd: 0.5 });
		expect(rows[1]).not.toHaveProperty("cascade");
		expect(rows[0]?.cascade).toEqual(cascade);
		expect(store.jevSpentUsd()).toBeCloseTo(0.01003);
		store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("toolTrim round-trips; rows without it omit the key; Jev cost is summed", () => {
	const store = createStore(":memory:");
	const withScores = {
		offered: 3,
		kept: 2,
		removed: ["x"],
		estimatedTokensSaved: 250,
		scores: { x: 0.1, y: 0.9, z: 0.8 },
		jevLatencyMs: 400,
		jevCostUsd: 0.002,
		error: null,
	};
	const failed = {
		offered: 2,
		kept: 2,
		removed: [],
		estimatedTokensSaved: 0,
		scores: null,
		jevLatencyMs: null,
		jevCostUsd: null,
		error: "timeout",
	};
	store.insert({ ...a, id: "t1", startedAt: 1, toolTrim: withScores }, null);
	store.insert({ ...a, id: "t2", startedAt: 2, toolTrim: failed }, null);
	store.insert({ ...a, id: "t3", startedAt: 3 }, null);
	const rows = store.recent(10);
	expect(rows[0]).not.toHaveProperty("toolTrim");
	expect(rows[1]?.toolTrim).toEqual(failed);
	expect(rows[2]?.toolTrim).toEqual(withScores);
	expect(store.jevSpentUsd()).toBeCloseTo(0.002);
	store.close();
});

test("a pre-toolTrim database migrates without losing rows", () => {
	const dir = mkdtempSync(join(tmpdir(), "jev-store-"));
	const path = join(dir, "old.db");
	try {
		const old = new Database(path);
		old.run(`CREATE TABLE requests (
			id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, latency_ms INTEGER NOT NULL,
			endpoint TEXT NOT NULL, requested_model TEXT NOT NULL, upstream_model TEXT NOT NULL,
			stream INTEGER NOT NULL, status INTEGER NOT NULL, input_tokens INTEGER,
			output_tokens INTEGER, cache_creation_input_tokens INTEGER,
			cache_read_input_tokens INTEGER, error TEXT, cost_usd REAL,
			route_tier TEXT, route_reason TEXT, route_confidence REAL, route_probabilities TEXT,
			jev_latency_ms INTEGER, jev_cost_usd REAL, route_error TEXT,
			cascade_first_tier TEXT, cascade_escalation_tier TEXT, cascade_accepted INTEGER,
			cascade_pass_probability REAL, cascade_jev_latency_ms INTEGER, cascade_jev_cost_usd REAL,
			cascade_wasted_usage TEXT, cascade_wasted_cost_usd REAL, cascade_error TEXT
		)`);
		old.run(
			"INSERT INTO requests (id, started_at, latency_ms, endpoint, requested_model, upstream_model, stream, status, cost_usd) VALUES ('o',1,2,'messages','m','m',0,200,0.5)",
		);
		old.close();
		const store = createStore(path);
		store.insert({ ...a, id: "n", startedAt: 2 }, null);
		const rows = store.recent(10);
		expect(rows).toHaveLength(2);
		expect(rows[1]).toMatchObject({ id: "o", costUsd: 0.5 });
		expect(rows[1]).not.toHaveProperty("toolTrim");
		store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

const hitLookup: CacheLookup = {
	outcome: "hit",
	candidates: 2,
	bestSimilarity: 0.93,
	matchProbability: 0.96,
	sourceRequestId: "src",
	jevLatencyMs: 300,
	jevCostUsd: 0.0001,
	lookupMs: 310,
	stored: false,
	error: null,
};
const missLookup: CacheLookup = {
	outcome: "miss",
	candidates: 0,
	bestSimilarity: null,
	matchProbability: null,
	sourceRequestId: null,
	jevLatencyMs: null,
	jevCostUsd: null,
	lookupMs: 12,
	stored: true,
	error: "embed failed",
};

test("cache lookups round-trip and the key is omitted otherwise", () => {
	const store = createStore(":memory:");
	store.insert({ ...a, id: "h", startedAt: 1, cache: hitLookup }, 0);
	store.insert({ ...a, id: "m", startedAt: 2, cache: missLookup }, null);
	store.insert({ ...a, id: "n", startedAt: 3 }, null);
	const rows = store.recent(10);
	expect(rows[0]).not.toHaveProperty("cache");
	expect(rows[1]?.cache).toEqual(missLookup);
	expect(rows[2]?.cache).toEqual(hitLookup);
	expect(rows[2]?.costUsd).toBe(0);
	store.close();
});

test("jevSpentUsd includes cache lookup cost", () => {
	const store = createStore(":memory:");
	store.insert(routed, null);
	store.insert({ ...a, id: "h", cache: hitLookup }, 0);
	store.insert({ ...a, id: "m", cache: missLookup }, null);
	expect(store.jevSpentUsd()).toBeCloseTo(0.0021);
	store.close();
});

test("a pre-cache database migrates without losing rows", () => {
	const dir = mkdtempSync(join(tmpdir(), "jev-store-"));
	const path = join(dir, "old.db");
	try {
		const old = new Database(path);
		old.run(`CREATE TABLE requests (
			id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, latency_ms INTEGER NOT NULL,
			endpoint TEXT NOT NULL, requested_model TEXT NOT NULL, upstream_model TEXT NOT NULL,
			stream INTEGER NOT NULL, status INTEGER NOT NULL, input_tokens INTEGER,
			output_tokens INTEGER, cache_creation_input_tokens INTEGER,
			cache_read_input_tokens INTEGER, error TEXT, cost_usd REAL,
			tooltrim_offered INTEGER, tooltrim_jev_cost_usd REAL
		)`);
		old.run(
			"INSERT INTO requests (id, started_at, latency_ms, endpoint, requested_model, upstream_model, stream, status, cost_usd) VALUES ('o',1,2,'messages','m','m',0,200,0.5)",
		);
		old.close();
		const store = createStore(path);
		store.insert({ ...a, id: "n", startedAt: 2, cache: hitLookup }, 0);
		const rows = store.recent(10);
		expect(rows).toHaveLength(2);
		expect(rows[1]).toMatchObject({ id: "o", costUsd: 0.5 });
		expect(rows[1]).not.toHaveProperty("cache");
		expect(rows[0]?.cache).toEqual(hitLookup);
		store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
