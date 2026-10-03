import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { createCascadeJudge } from "../src/cascade/judge";
import { createJevClient } from "../src/jev/client";
import { createMockFetch } from "../src/jev/mock-fetch";
import { createRouter } from "../src/routing/router";
import { createApp } from "../src/server";
import type { RequestRecord } from "../src/types";
import { type FakeUpstream, startFakeUpstream } from "./fake-upstream";

let upstream: FakeUpstream;
let gateway: ReturnType<typeof Bun.serve>;
let records: RequestRecord[] = [];
let spent = 0;
let judgeCalls = 0;
// Per-test knobs.
let routerTier = "opus-medium";
let pass: number | "error" = 0.9;
let defaultOn = false;
let callerPass = 0.9;
let routerJev: TypeSafeClient;

const budget = {
	remainingUsd: () => 1 - spent,
	charge: (x: number) => {
		spent += x;
	},
};
const mockJev = () =>
	new TypeSafeClient({
		apiKey: "x",
		retry: { maxRetries: 0 },
		fetch: async (i, init) => {
			const body = JSON.parse(String(init?.body));
			if ("pass" in body.questions) {
				judgeCalls++;
				if (pass === "error") return new Response("boom", { status: 500 });
				return createMockFetch({ pass })(i, init);
			}
			return createMockFetch({ tier: routerTier })(i, init);
		},
	});

const client = () =>
	new Anthropic({
		apiKey: "k1",
		baseURL: `http://localhost:${gateway.port}`,
		maxRetries: 0,
	});
const msgs = [{ role: "user" as const, content: "hi" }];
const on: { headers: Record<string, string> } = {
	headers: { "x-gateway-cascade": "on" },
};
const models = () =>
	upstream.requests.map((r) => (r.body as { model: string }).model);

beforeAll(() => {
	upstream = startFakeUpstream();
	const jev = mockJev();
	const router = createRouter({
		jev,
		budget,
		defaultTier: "opus-medium",
		minConfidence: 0.5,
		timeoutMs: 500,
	});
	gateway = Bun.serve({
		port: 0,
		fetch: createApp({
			upstreamBaseURL: upstream.url,
			onRecord: (r) => records.push(r),
			router,
			cascade: {
				judge: createCascadeJudge({ jev, budget, timeoutMs: 500 }),
				firstTier: "haiku",
				minPass: 0.7,
				get defaultOn() {
					return defaultOn;
				},
			},
			makeJevClient: () => {
				routerJev = createJevClient({
					mode: "mock",
					mockAnswers: { tier: routerTier, pass: callerPass },
				});
				return routerJev;
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
	spent = 0;
	judgeCalls = 0;
	routerTier = "opus-medium";
	pass = 0.9;
	defaultOn = false;
	callerPass = 0.9;
	upstream.requests.length = 0;
});

const run = async (
	extra: Record<string, unknown> = {},
	options = on,
	system?: string,
) => {
	const { data, response } = await client()
		.messages.create(
			{ model: "auto", max_tokens: 10, messages: msgs, system, ...extra },
			options,
		)
		.withResponse();
	await Bun.sleep(10);
	return { data, response, rec: records[0] as RequestRecord };
};

test("accepted, non-streaming", async () => {
	const { data, response, rec } = await run();
	expect(data.content[0]).toMatchObject({ text: "Hello" });
	expect(models()).toEqual(["claude-haiku-4-5"]);
	expect(rec.cascade).toMatchObject({
		firstTier: "haiku",
		escalationTier: "opus-medium",
		accepted: true,
		passProbability: 0.9,
		wastedUsage: null,
		wastedCostUsd: 0,
	});
	expect(rec.cascade?.jevCostUsd).toBeGreaterThan(0);
	expect(rec.upstreamModel).toBe("claude-haiku-4-5");
	expect(rec.usage?.input_tokens).toBe(10);
	expect(response.headers.get("x-gateway-tier")).toBe("haiku");
	expect(response.headers.get("x-gateway-model")).toBe("claude-haiku-4-5");
	expect(response.headers.get("x-gateway-cascade")).toBe("accepted");
});

test("accepted, streaming client gets one non-streaming upstream call", async () => {
	const msg = await client()
		.messages.stream({ model: "auto", max_tokens: 10, messages: msgs }, on)
		.finalMessage();
	await Bun.sleep(10);
	expect(msg.content[0]).toMatchObject({ text: "Hello" });
	expect(upstream.requests.length).toBe(1);
	expect(
		(upstream.requests[0]?.body as { stream?: boolean } | undefined)?.stream,
	).toBe(false);
	expect(records[0]?.cascade?.accepted).toBe(true);
	expect(records[0]?.stream).toBe(true);
	expect(records[0]?.upstreamModel).toBe("claude-haiku-4-5");
});

test("rejected escalates to the routed tier", async () => {
	pass = 0.3;
	const { response, rec } = await run();
	expect(models()).toEqual(["claude-haiku-4-5", "claude-opus-5-5"]);
	expect(rec.cascade).toMatchObject({ accepted: false, passProbability: 0.3 });
	expect(rec.cascade?.wastedUsage?.input_tokens).toBe(10);
	expect(rec.cascade?.wastedCostUsd).toBeGreaterThan(0);
	expect(rec.upstreamModel).toBe("claude-opus-5-5");
	expect(rec.usage?.input_tokens).toBe(10);
	expect(response.headers.get("x-gateway-tier")).toBe("opus-medium");
	expect(response.headers.get("x-gateway-model")).toBe("claude-opus-5-5");
	expect(response.headers.get("x-gateway-cascade")).toBe("escalated");
});

test("rejected, streaming client", async () => {
	pass = 0.3;
	const msg = await client()
		.messages.stream({ model: "auto", max_tokens: 10, messages: msgs }, on)
		.finalMessage();
	await Bun.sleep(10);
	expect(msg.content[0]).toMatchObject({ text: "Hello" });
	expect(models()).toEqual(["claude-haiku-4-5", "claude-opus-5-5"]);
	expect(
		(upstream.requests[1]?.body as { stream?: boolean } | undefined)?.stream,
	).toBe(true);
	expect(records[0]?.cascade?.accepted).toBe(false);
});

test("max_tokens stop escalates without asking Jev", async () => {
	const { rec } = await run({ max_tokens: 1 });
	expect(judgeCalls).toBe(0);
	expect(models().length).toBe(2);
	expect(rec.cascade).toMatchObject({
		accepted: false,
		passProbability: null,
		error: "stop_reason max_tokens",
	});
	expect(rec.cascade?.wastedCostUsd).toBeGreaterThan(0);
});

test("first-attempt upstream error escalates", async () => {
	const { data, rec } = await run({}, on, "fail-haiku");
	expect(data.content[0]).toMatchObject({ text: "Hello" });
	expect(models()).toEqual(["claude-haiku-4-5", "claude-opus-5-5"]);
	expect(rec.cascade).toMatchObject({
		accepted: false,
		wastedUsage: null,
		wastedCostUsd: 0,
	});
	expect(rec.cascade?.error).toContain("haiku down");
});

test("judge error escalates", async () => {
	pass = "error";
	const { rec } = await run();
	expect(models().length).toBe(2);
	expect(rec.cascade?.accepted).toBe(false);
	expect(rec.cascade?.passProbability).toBeNull();
	expect(rec.cascade?.error).toBeTruthy();
	expect(rec.cascade?.wastedCostUsd).toBeGreaterThan(0);
});

test("not eligible: header off, default off, tools, haiku pick, fallback", async () => {
	const notRun = (rec: RequestRecord | undefined, n: number) => {
		expect(rec?.cascade).toBeUndefined();
		expect(models().length).toBe(n);
		expect(judgeCalls).toBe(0);
	};
	defaultOn = true;
	await run({}, { headers: { "x-gateway-cascade": "off" } });
	notRun(records[0], 1);

	defaultOn = false;
	records = [];
	upstream.requests.length = 0;
	await run({}, { headers: {} });
	notRun(records[0], 1);

	records = [];
	upstream.requests.length = 0;
	await run({
		tools: [{ name: "t", description: "d", input_schema: { type: "object" } }],
	});
	notRun(records[0], 1);

	records = [];
	upstream.requests.length = 0;
	routerTier = "haiku";
	// Fresh conversation: sticky routing would otherwise keep the earlier opus tier.
	await run({ messages: [{ role: "user", content: "another conversation" }] });
	notRun(records[0], 1);

	records = [];
	upstream.requests.length = 0;
	routerTier = "opus-medium";
	await run({}, { headers: { ...on.headers, "x-gateway-mode": "off" } });
	notRun(records[0], 1);
});

test("defaultOn enables cascade without a header", async () => {
	defaultOn = true;
	const { rec } = await run({}, { headers: {} });
	expect(rec.cascade?.accepted).toBe(true);
});

test("judge cost is charged to the budget", async () => {
	await run();
	// router call + judge call both charged
	expect(spent).toBeCloseTo(
		(records[0]?.route?.jevCostUsd ?? 0) +
			(records[0]?.cascade?.jevCostUsd ?? 0),
		12,
	);
	expect(records[0]?.cascade?.jevCostUsd).toBeGreaterThan(0);
});

test("x-jev-key uses the caller client and records null Jev cost", async () => {
	const { rec } = await run(
		{},
		{ headers: { ...on.headers, "x-jev-key": "s" } },
	);
	expect(rec.cascade?.accepted).toBe(true);
	expect(rec.cascade?.jevCostUsd).toBeNull();
	expect(spent).toBe(0);
	expect(judgeCalls).toBe(0);
});

// --- judge unit tests ---

const answer = (text: string) =>
	({
		content: [{ type: "text", text }],
		stop_reason: "end_turn",
	}) as never;

const capture = () => {
	const calls: Array<{ state: Record<string, unknown>; questions: unknown }> =
		[];
	const jev = new TypeSafeClient({
		apiKey: "x",
		retry: { maxRetries: 0 },
		fetch: (i, init) => {
			calls.push(JSON.parse(String(init?.body)));
			return createMockFetch({ pass: 0.8 })(i, init);
		},
	});
	return { calls, jev };
};

test("judge builds state and truncates long responses", async () => {
	const { calls, jev } = capture();
	const b = { remainingUsd: () => 1, charge: () => {} };
	const judge = createCascadeJudge({ jev, budget: b, timeoutMs: 500 });
	const long = `${"a".repeat(4500)}${"m".repeat(500)}${"z".repeat(1500)}`;
	const r = await judge.judge(
		{ system: "sys", messages: [{ role: "user", content: "question" }] },
		answer(long),
	);
	expect(r.passProbability).toBe(0.8);
	const st = calls[0]?.state as Record<string, string>;
	expect(st.system_excerpt).toBe("sys");
	expect(st.user_request).toBe("question");
	expect(st.stop_reason).toBe("end_turn");
	expect(st.response).toBe(`${"a".repeat(4500)} … ${"z".repeat(1500)}`);
	const short = await judge.judge({ messages: msgs }, answer("short"));
	expect(short.error).toBeNull();
	expect(
		(calls[1]?.state as Record<string, string> | undefined)?.response,
	).toBe("short");
});

test("judge: budget exhausted skips Jev; caller client is not charged", async () => {
	const { calls, jev } = capture();
	let charged = 0;
	const judge = createCascadeJudge({
		jev,
		budget: {
			remainingUsd: () => 0,
			charge: (x) => {
				charged += x;
			},
		},
		timeoutMs: 500,
	});
	const r = await judge.judge({ messages: msgs }, answer("x"));
	expect(r).toMatchObject({
		passProbability: null,
		error: "jev budget exhausted",
	});
	expect(calls.length).toBe(0);
	const c = capture();
	const r2 = await judge.judge({ messages: msgs }, answer("x"), {
		jev: c.jev,
	});
	expect(r2.passProbability).toBe(0.8);
	expect(r2.jevCostUsd).toBeNull();
	expect(charged).toBe(0);
});

test("judge never throws on timeout", async () => {
	const jev = new TypeSafeClient({
		apiKey: "x",
		retry: { maxRetries: 0 },
		fetch: (_i, init) =>
			new Promise((_, rej) => {
				init?.signal?.addEventListener("abort", () =>
					rej(new Error("aborted")),
				);
			}),
	});
	const judge = createCascadeJudge({
		jev,
		budget: { remainingUsd: () => 1, charge: () => {} },
		timeoutMs: 30,
	});
	const r = await judge.judge({ messages: msgs }, answer("x"));
	expect(r.passProbability).toBeNull();
	expect(r.error).toBeTruthy();
});
