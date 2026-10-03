import { expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import {
	cacheScope,
	createSemanticCache,
	isCacheable,
	isStorable,
} from "../src/cache/cache";
import { createCacheStore } from "../src/cache/store";
import { createMockFetch } from "../src/jev/mock-fetch";
import { fakeEmbedder } from "./fake-embedder";

type Msg = Anthropic.Beta.Messages.BetaMessage;

const msg = (text = "Paris", stop = "end_turn"): Msg =>
	({
		id: "msg_1",
		type: "message",
		role: "assistant",
		model: "claude-haiku-4-5",
		content: [{ type: "text", text }],
		stop_reason: stop,
		stop_sequence: null,
		usage: {
			input_tokens: 1,
			output_tokens: 1,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 0,
		},
	}) as unknown as Msg;

const body = (q: string, extra: Record<string, unknown> = {}) => ({
	model: "claude-haiku-4-5",
	max_tokens: 10,
	messages: [{ role: "user", content: q }],
	...extra,
});

test("isCacheable", () => {
	expect(isCacheable(body("hi"))).toBe(true);
	expect(
		isCacheable(
			body("x", {
				messages: [{ role: "user", content: [{ type: "text", text: "a" }] }],
			}),
		),
	).toBe(true);
	expect(isCacheable(body("hi", { temperature: 0 }))).toBe(true);
	expect(isCacheable(body("hi", { tools: [] }))).toBe(true);
	expect(
		isCacheable(
			body("x", {
				messages: [
					{ role: "user", content: "a" },
					{ role: "assistant", content: "b" },
					{ role: "user", content: "c" },
				],
			}),
		),
	).toBe(false);
	expect(isCacheable(body("hi", { tools: [{ name: "f" }] }))).toBe(false);
	expect(isCacheable(body("hi", { tool_choice: { type: "auto" } }))).toBe(
		false,
	);
	expect(isCacheable(body("hi", { temperature: 0.7 }))).toBe(false);
	expect(
		isCacheable(
			body("x", {
				messages: [
					{
						role: "user",
						content: [{ type: "image", source: { type: "url", url: "u" } }],
					},
				],
			}),
		),
	).toBe(false);
});

test("cacheScope differs by system, model, output_config", () => {
	const a = cacheScope(body("q"));
	expect(cacheScope(body("other question"))).toBe(a);
	expect(cacheScope(body("q", { system: "s" }))).not.toBe(a);
	expect(cacheScope({ ...body("q"), model: "m2" })).not.toBe(a);
	expect(cacheScope(body("q", { output_config: { effort: "low" } }))).not.toBe(
		a,
	);
});

test("isStorable", () => {
	expect(isStorable(msg())).toBe(true);
	expect(isStorable(msg("x", "max_tokens"))).toBe(false);
	const tool = { ...msg(), content: [{ type: "tool_use" }] } as unknown as Msg;
	expect(isStorable(tool)).toBe(false);
});

test("store round-trip, TTL and prune", () => {
	const store = createCacheStore(":memory:");
	const embedding = Float32Array.from([0.25, -0.5, 0.75]);
	const e = (id: string, createdAt: number) => ({
		id,
		scope: "s",
		question: "q",
		embedding,
		message: msg(),
		requestId: `r-${id}`,
		createdAt,
	});
	store.add(e("old", 1000));
	store.add(e("new", 5000));
	store.add({ ...e("other", 5000), scope: "t" });
	const got = store.inScope("s", 6000, 10_000);
	expect(got.map((x) => x.id)).toEqual(["new", "old"]);
	expect(got[0]?.embedding).toEqual(embedding);
	expect(got[0]?.message).toEqual(msg());
	expect(store.inScope("s", 6000, 2000).map((x) => x.id)).toEqual(["new"]);
	expect(store.prune(6000, 2000)).toBe(1);
	expect(store.inScope("s", 6000, 10_000).map((x) => x.id)).toEqual(["new"]);
	store.close();
});

const setup = (answers: Record<string, number> = { k0: 0.95 }, spent = 0) => {
	const store = createCacheStore(":memory:");
	let charged = 0;
	let calls = 0;
	const budget = {
		remainingUsd: () => 1 - spent - charged,
		charge: (x: number) => {
			charged += x;
		},
	};
	const countingJev = (a: Record<string, number>) =>
		new TypeSafeClient({
			apiKey: "x",
			retry: { maxRetries: 0 },
			fetch: async (i, init) => {
				calls++;
				return createMockFetch(a)(i, init);
			},
		});
	const cache = createSemanticCache({
		embedder: fakeEmbedder,
		store,
		jev: countingJev(answers),
		budget,
		timeoutMs: 500,
		ttlMs: 3_600_000,
		minSimilarity: 0.8,
		minMatch: 0.85,
		maxCandidates: 3,
	});
	return {
		cache,
		countingJev,
		calls: () => calls,
		charged: () => charged,
	};
};

const Q = "what is the capital of france";

test("lookup: empty scope and dissimilar questions skip Jev", async () => {
	const t = setup();
	const r = await t.cache.lookup(body(Q));
	expect(r?.hit).toBeNull();
	expect(r?.lookup).toMatchObject({ outcome: "miss", bestSimilarity: null });
	expect(await t.cache.store(body(Q), msg(), "r1")).toBe(true);
	const far = await t.cache.lookup(body("zebra quantum bicycle"));
	expect(far?.lookup.candidates).toBe(0);
	expect(far?.lookup.bestSimilarity).not.toBeNull();
	expect(t.calls()).toBe(0);
	expect(
		await t.cache.lookup(body("hi", { tools: [{ name: "f" }] })),
	).toBeNull();
});

test("lookup: hit, miss on low probability, error, scope", async () => {
	const t = setup();
	await t.cache.store(body(Q), msg(), "r1");
	const hit = await t.cache.lookup(body(Q));
	expect(hit?.lookup).toMatchObject({
		outcome: "hit",
		candidates: 1,
		matchProbability: 0.95,
		sourceRequestId: "r1",
		stored: false,
		error: null,
	});
	expect(hit?.hit?.id).toStartWith("msg_cache_");
	expect(hit?.hit?.content).toEqual(msg().content);
	expect(hit?.lookup.jevCostUsd).toBeGreaterThan(0);
	expect(t.charged()).toBeGreaterThan(0);

	const low = setup({ k0: 0.5 });
	await low.cache.store(body(Q), msg(), "r1");
	const m = await low.cache.lookup(body(Q));
	expect(m?.hit).toBeNull();
	expect(m?.lookup).toMatchObject({ outcome: "miss", matchProbability: 0.5 });

	const scoped = await t.cache.lookup(body(Q, { system: "other" }));
	expect(scoped?.lookup.candidates).toBe(0);
	expect(scoped?.hit).toBeNull();
});

test("lookup: Jev error, budget exhausted, caller client", async () => {
	const t = setup();
	await t.cache.store(body(Q), msg(), "r1");
	const failing = new TypeSafeClient({
		apiKey: "x",
		retry: { maxRetries: 0 },
		fetch: async () => new Response("boom", { status: 500 }),
	});
	const err = await t.cache.lookup(body(Q), { jev: failing });
	expect(err?.hit).toBeNull();
	expect(err?.lookup.error).toBeTruthy();

	const broke = setup({ k0: 0.95 }, 2);
	await broke.cache.store(body(Q), msg(), "r1");
	const b = await broke.cache.lookup(body(Q));
	expect(b?.hit).toBeNull();
	expect(b?.lookup.error).toBe("jev budget exhausted");
	expect(broke.calls()).toBe(0);

	const before = t.charged();
	const caller = await t.cache.lookup(body(Q), {
		jev: t.countingJev({ k0: 0.9 }),
	});
	expect(caller?.hit).not.toBeNull();
	expect(caller?.lookup.jevCostUsd).toBeNull();
	expect(t.charged()).toBe(before);
});
