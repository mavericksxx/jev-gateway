import { describe, expect, test } from "bun:test";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { createJevClient } from "../src/jev/client";
import { createRouter, type JevBudget } from "../src/routing/router";
import { buildRouterState } from "../src/routing/state";
import type { Tier } from "../src/routing/tiers";

const body = (text = "hi", system = "sys") => ({
	system,
	max_tokens: 10,
	messages: [{ role: "user", content: text }],
});

const budget = (usd = 1) => {
	const b = { left: usd } as JevBudget & { left: number };
	b.remainingUsd = () => b.left;
	b.charge = (x) => {
		b.left -= x;
	};
	return b;
};

const mockJev = (tier: Tier) =>
	createJevClient({ mode: "mock", mockAnswers: { tier } });

/** A client answering with a hand-written choice; records request bodies. */
const fakeJev = (
	choice: Tier,
	confidence: number,
	extra: { delayMs?: number; fail?: boolean } = {},
) => {
	const seen: Record<string, unknown>[] = [];
	const client = new TypeSafeClient({
		apiKey: "x",
		retry: { maxRetries: 0 },
		fetch: async (_i, init) => {
			seen.push(JSON.parse(String(init?.body)));
			if (extra.delayMs) await Bun.sleep(extra.delayMs);
			if (extra.fail) return new Response("nope", { status: 500 });
			return Response.json({
				model: "jev",
				answers: {
					tier: {
						type: "choice",
						choice,
						confidence,
						probabilities: { [choice]: confidence },
					},
				},
				usage: { input_tokens: 1000, output_tokens: 0 },
			});
		},
	});
	return { client, seen };
};

const make = (jev: TypeSafeClient, b = budget(), over = {}) =>
	createRouter({
		jev,
		budget: b,
		defaultTier: "opus-medium",
		minConfidence: 0.5,
		timeoutMs: 500,
		...over,
	});

describe("router", () => {
	test("uses Jev's pick, records probabilities, charges budget", async () => {
		const b = budget();
		const d = await make(mockJev("sonnet-low"), b).route(body());
		expect(d).toMatchObject({
			tier: "sonnet-low",
			reason: "jev",
			confidence: 1,
			error: null,
		});
		expect(d.probabilities?.["sonnet-low"]).toBe(1);
		expect(d.jevCostUsd).toBeGreaterThan(0);
		expect(b.left).toBeCloseTo(1 - (d.jevCostUsd ?? 0));
	});

	test("low confidence falls back to default", async () => {
		const d = await make(fakeJev("haiku", 0.2).client).route(body());
		expect(d).toMatchObject({
			tier: "opus-medium",
			reason: "low-confidence",
			confidence: 0.2,
		});
		expect(d.probabilities).toEqual({ haiku: 0.2 });
	});

	test("sticky keeps higher tier and allows escalation", async () => {
		let pick: Tier = "opus-high";
		const jev = new TypeSafeClient({
			apiKey: "x",
			fetch: async () =>
				Response.json({
					model: "j",
					answers: {
						tier: {
							type: "choice",
							choice: pick,
							confidence: 1,
							probabilities: { [pick]: 1 },
						},
					},
					usage: { input_tokens: 1, output_tokens: 0 },
				}),
		});
		const r = make(jev);
		expect((await r.route(body())).tier).toBe("opus-high");
		pick = "haiku";
		const d = await r.route(body());
		expect(d).toMatchObject({ tier: "opus-high", reason: "sticky" });
		pick = "fable-high";
		expect(await r.route(body())).toMatchObject({
			tier: "fable-high",
			reason: "jev",
		});
	});

	test("different conversations are independent", async () => {
		let pick: Tier = "opus-high";
		const jev = new TypeSafeClient({
			apiKey: "x",
			fetch: async () =>
				Response.json({
					model: "j",
					answers: {
						tier: {
							type: "choice",
							choice: pick,
							confidence: 1,
							probabilities: {},
						},
					},
					usage: { input_tokens: 1, output_tokens: 0 },
				}),
		});
		const r = make(jev);
		await r.route(body("a", "s1"));
		pick = "haiku";
		expect((await r.route(body("b", "s2"))).tier).toBe("haiku");
	});

	test("budget exhausted skips Jev", async () => {
		const f = fakeJev("haiku", 1);
		const d = await make(f.client, budget(0)).route(body());
		expect(d).toMatchObject({
			tier: "opus-medium",
			reason: "fallback",
			error: "jev budget exhausted",
			jevCostUsd: null,
		});
		expect(f.seen).toHaveLength(0);
	});

	test("Jev error falls back", async () => {
		const d = await make(fakeJev("haiku", 1, { fail: true }).client).route(
			body(),
		);
		expect(d).toMatchObject({ tier: "opus-medium", reason: "fallback" });
		expect(d.error).toBeTruthy();
	});

	test("timeout falls back", async () => {
		const d = await make(
			fakeJev("haiku", 1, { delayMs: 300 }).client,
			budget(),
			{ timeoutMs: 20 },
		).route(body());
		expect(d).toMatchObject({ tier: "opus-medium", reason: "fallback" });
		expect(d.error).toBeTruthy();
	});

	test("haiku is not offered for huge inputs", async () => {
		const f = fakeJev("sonnet-low", 1);
		const r = make(f.client);
		await r.route(body("x".repeat(800_000)));
		await r.route(body("small", "other"));
		const offered = (i: number) =>
			Object.keys(
				(f.seen[i] as { questions: { tier: { criteria: object } } }).questions
					.tier.criteria,
			);
		expect(offered(0)).not.toContain("haiku");
		expect(offered(1)).toContain("haiku");
	});

	test("caller client is used and not charged", async () => {
		const own = fakeJev("haiku", 1);
		const theirs = fakeJev("sonnet-high", 1);
		const b = budget();
		const d = await make(own.client, b).route(body(), { jev: theirs.client });
		expect(d).toMatchObject({
			tier: "sonnet-high",
			reason: "jev",
			jevCostUsd: null,
		});
		expect(own.seen).toHaveLength(0);
		expect(b.left).toBe(1);
	});

	test("caller client is used even when budget is exhausted", async () => {
		const theirs = fakeJev("sonnet-high", 1);
		const d = await make(fakeJev("haiku", 1).client, budget(0)).route(body(), {
			jev: theirs.client,
		});
		expect(d.tier).toBe("sonnet-high");
	});
});

describe("buildRouterState", () => {
	test("truncates long text", () => {
		const long = `${"a".repeat(3000)}${"b".repeat(2000)}`;
		const s = buildRouterState({
			system: "s".repeat(2000),
			messages: [{ role: "user", content: long }],
		});
		expect(s.system_excerpt).toHaveLength(1500);
		expect(s.last_user_turn).toBe(`${"a".repeat(3000)} … ${"b".repeat(1000)}`);
		expect(s.turn_count).toBe(1);
	});

	test("system blocks, tools, thinking, max_tokens", () => {
		const s = buildRouterState({
			system: [
				{ type: "text", text: "one" },
				{ type: "text", text: "two" },
			],
			tools: [{ name: "a" }, { name: "b" }],
			thinking: { type: "enabled" },
			max_tokens: 5,
			messages: [],
		});
		expect(s.system_excerpt).toBe("one\ntwo");
		expect(s.tool_names).toEqual(["a", "b"]);
		expect(s.requested_thinking).toBe("enabled");
		expect(s.max_tokens).toBe(5);
		expect(s.last_user_turn).toBe("");
	});

	test("image/document flags and tool_result detection", () => {
		const s = buildRouterState({
			messages: [
				{
					role: "user",
					content: [
						{ type: "image", source: {} },
						{ type: "document", source: {} },
					],
				},
				{ role: "assistant", content: "ok" },
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "1", content: "result text" },
					],
				},
			],
		});
		expect(s.has_images).toBe(true);
		expect(s.has_documents).toBe(true);
		expect(s.last_turn_is_tool_result).toBe(true);
		expect(s.last_user_turn).toBe("result text");
	});

	test("odd input does not throw", () => {
		for (const b of [
			{},
			{ messages: "x", system: 5, tools: [null, 3], thinking: "t" },
			{ messages: [null, 1, { role: "user", content: [null, 2] }] },
		]) {
			expect(() => buildRouterState(b as never)).not.toThrow();
		}
	});
});
