import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { createSemanticCache } from "../src/cache/cache";
import { createCacheStore } from "../src/cache/store";
import { createJevClient } from "../src/jev/client";
import { recordCostUsd } from "../src/pricing";
import { createRouter } from "../src/routing/router";
import { createApp } from "../src/server";
import type { RequestRecord } from "../src/types";
import { fakeEmbedder } from "./cache.test";
import { type FakeUpstream, startFakeUpstream } from "./fake-upstream";

let upstream: FakeUpstream;
let gateway: ReturnType<typeof Bun.serve>;
let records: RequestRecord[] = [];
let defaultOn = false;

const jev = createJevClient({
	mode: "mock",
	mockAnswers: { k0: 0.95, tier: "haiku" },
});
const budget = { remainingUsd: () => 1, charge: () => {} };

beforeAll(() => {
	upstream = startFakeUpstream();
	const cache = createSemanticCache({
		embedder: fakeEmbedder,
		store: createCacheStore(":memory:"),
		jev,
		budget,
		timeoutMs: 500,
		ttlMs: 3_600_000,
		minSimilarity: 0.8,
		minMatch: 0.85,
		maxCandidates: 3,
	});
	gateway = Bun.serve({
		port: 0,
		fetch: createApp({
			upstreamBaseURL: upstream.url,
			onRecord: (r) => records.push(r),
			router: createRouter({
				jev,
				budget,
				defaultTier: "opus-medium",
				minConfidence: 0.5,
				timeoutMs: 500,
			}),
			cache: {
				cache,
				get defaultOn() {
					return defaultOn;
				},
			},
		}).fetch,
	});
});
afterAll(() => {
	gateway.stop(true);
	upstream.stop();
});
beforeEach(() => {
	records = [];
	defaultOn = false;
	upstream.requests.length = 0;
});

const client = () =>
	new Anthropic({
		apiKey: "k1",
		baseURL: `http://localhost:${gateway.port}`,
		maxRetries: 0,
	});
const on = { headers: { "x-gateway-cache": "on" } };
// Each test uses its own system prompt so cached answers never leak between tests.
const ask = async (
	system: string,
	extra: Record<string, unknown> = {},
	options: { headers: Record<string, string> } | undefined = on,
	model = "claude-haiku-4-5",
) => {
	const { data, response } = await client()
		.messages.create(
			{
				model,
				max_tokens: 10,
				system,
				messages: [{ role: "user", content: "what is the capital of france" }],
				...extra,
			} as never,
			options,
		)
		.withResponse();
	await Bun.sleep(30);
	return {
		data: data as Anthropic.Message,
		response,
		rec: records.at(-1) as RequestRecord,
	};
};

test("miss stores, identical second request hits", async () => {
	const first = await ask("s1");
	expect(first.response.headers.get("x-gateway-cache-result")).toBe("miss");
	expect(first.rec.cache).toMatchObject({ outcome: "miss", stored: true });
	expect(upstream.requests).toHaveLength(1);

	const second = await ask("s1");
	expect(upstream.requests).toHaveLength(1);
	expect(second.response.headers.get("x-gateway-cache-result")).toBe("hit");
	expect(second.data.id).toStartWith("msg_cache_");
	expect(second.data.content[0]).toMatchObject({ text: "Hello" });
	expect(second.rec.cache).toMatchObject({
		outcome: "hit",
		sourceRequestId: first.rec.id,
		stored: false,
	});
	expect(second.rec.usage?.input_tokens).toBe(10);
	expect(second.rec.upstreamModel).toBe("claude-haiku-4-5");
	expect(recordCostUsd(second.rec)).toBe(0);
	expect(recordCostUsd(first.rec)).toBeGreaterThan(0);
});

test("streaming client gets a hit as SSE", async () => {
	await ask("s2");
	const stream = client().messages.stream(
		{
			model: "claude-haiku-4-5",
			max_tokens: 10,
			system: "s2",
			messages: [{ role: "user", content: "what is the capital of france" }],
		},
		on,
	);
	const final = await stream.finalMessage();
	await Bun.sleep(30);
	expect(upstream.requests).toHaveLength(1);
	expect(final.content[0]).toMatchObject({ text: "Hello" });
	expect(records.at(-1)?.cache?.outcome).toBe("hit");
});

test("streaming miss stores the accumulated answer", async () => {
	const s = client().messages.stream(
		{
			model: "claude-haiku-4-5",
			max_tokens: 10,
			system: "s3",
			messages: [{ role: "user", content: "what is the capital of france" }],
		},
		on,
	);
	await s.finalMessage();
	await Bun.sleep(30);
	expect(records.at(-1)?.cache).toMatchObject({
		outcome: "miss",
		stored: true,
	});
	const again = await ask("s3");
	expect(again.response.headers.get("x-gateway-cache-result")).toBe("hit");
	expect(upstream.requests).toHaveLength(1);
});

test("header off and default off skip the cache", async () => {
	const off = await ask("s4", {}, { headers: { "x-gateway-cache": "off" } });
	expect(off.rec.cache).toBeUndefined();
	expect(off.response.headers.get("x-gateway-cache-result")).toBeNull();
	const none = await ask("s4", {}, { headers: {} });
	expect(none.rec.cache).toBeUndefined();
	defaultOn = true;
	const dflt = await ask("s4", {}, { headers: {} });
	expect(dflt.rec.cache?.outcome).toBe("miss");
});

test("tools make a request uncacheable", async () => {
	const r = await ask("s5", {
		tools: [{ name: "f", input_schema: { type: "object" } }],
	});
	expect(r.rec.cache).toBeUndefined();
	expect(r.response.headers.get("x-gateway-cache-result")).toBeNull();
});

test("routed hit still records the route", async () => {
	const first = await ask("s6", {}, on, "auto");
	expect(first.rec.cache?.stored).toBe(true);
	const second = await ask("s6", {}, on, "auto");
	expect(upstream.requests).toHaveLength(1);
	expect(second.rec.cache?.outcome).toBe("hit");
	expect(second.rec.route).toBeDefined();
	expect(recordCostUsd(second.rec)).toBe(0);
});
