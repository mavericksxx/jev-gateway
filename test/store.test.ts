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
