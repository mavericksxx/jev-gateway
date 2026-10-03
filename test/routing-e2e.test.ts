import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { createJevClient } from "../src/jev/client";
import { createMockFetch } from "../src/jev/mock-fetch";
import { createRouter } from "../src/routing/router";
import { createApp } from "../src/server";
import type { RequestRecord } from "../src/types";
import { type FakeUpstream, startFakeUpstream } from "./fake-upstream";

let upstream: FakeUpstream;
let gateway: ReturnType<typeof Bun.serve>;
let records: RequestRecord[] = [];
let jevCalls = 0;
let madeKeys: string[] = [];
let spent = 0;

const { TypeSafeClient: Jev } = await import("@typesafe-ai/sdk");
const countingJev = () =>
	new Jev({
		apiKey: "mock",
		retry: { maxRetries: 0 },
		fetch: (i, init) => {
			jevCalls++;
			return createMockFetch({ tier: "sonnet-low" })(i, init);
		},
	}) as TypeSafeClient;

const client = () =>
	new Anthropic({
		apiKey: "k1",
		baseURL: `http://localhost:${gateway.port}`,
		maxRetries: 0,
	});
const msgs = [{ role: "user" as const, content: "hi" }];
const lastBody = () => upstream.requests.at(-1)?.body as { model: string };

beforeAll(() => {
	upstream = startFakeUpstream();
	const router = createRouter({
		jev: countingJev(),
		budget: {
			remainingUsd: () => 1 - spent,
			charge: (x) => {
				spent += x;
			},
		},
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
			makeJevClient: (key) => {
				madeKeys.push(key);
				return createJevClient({
					mode: "mock",
					mockAnswers: { tier: "haiku" },
				});
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
	jevCalls = 0;
	madeKeys = [];
	spent = 0;
	upstream.requests.length = 0;
});

test("auto routes via Jev, sets headers, records decision", async () => {
	const { data, response } = await client()
		.messages.create({ model: "auto", max_tokens: 10, messages: msgs })
		.withResponse();
	expect(data.content[0]).toMatchObject({ text: "Hello" });
	expect(lastBody().model).toBe("claude-sonnet-5-5");
	expect(response.headers.get("x-gateway-tier")).toBe("sonnet-low");
	expect(response.headers.get("x-gateway-model")).toBe("claude-sonnet-5-5");
	expect(response.headers.get("x-gateway-decision-id")).toBe(
		records[0]?.id ?? "",
	);
	expect(records[0]).toMatchObject({
		requestedModel: "auto",
		upstreamModel: "claude-sonnet-5-5",
		route: { tier: "sonnet-low", reason: "jev" },
	});
	expect(spent).toBeGreaterThan(0);
});

test("streaming routed request works", async () => {
	const msg = await client()
		.messages.stream({ model: "auto", max_tokens: 10, messages: msgs })
		.finalMessage();
	expect(msg.content[0]).toMatchObject({ text: "Hello" });
	expect(lastBody().model).toBe("claude-sonnet-5-5");
	await Bun.sleep(20);
	expect(records[0]?.route?.tier).toBe("sonnet-low");
});

test("x-gateway-mode off uses default tier without calling Jev", async () => {
	await client().messages.create(
		{ model: "auto", max_tokens: 10, messages: msgs },
		{ headers: { "x-gateway-mode": "off" } },
	);
	expect(jevCalls).toBe(0);
	expect(lastBody().model).toBe("claude-opus-5-5");
	expect(records[0]?.route).toMatchObject({
		tier: "opus-medium",
		reason: "fallback",
		error: "routing off",
	});
});

test("x-jev-key builds a caller client and is not forwarded", async () => {
	await client().messages.create(
		{
			model: "auto",
			max_tokens: 10,
			messages: [{ role: "user", content: "other conversation" }],
		},
		{ headers: { "x-jev-key": "secret-key" } },
	);
	expect(madeKeys).toEqual(["secret-key"]);
	expect(jevCalls).toBe(0);
	expect(upstream.requests[0]?.headers["x-jev-key"]).toBeUndefined();
	expect(lastBody().model).toBe("claude-haiku-4-5");
	expect(records[0]?.route?.jevCostUsd).toBeNull();
	expect(JSON.stringify(records)).not.toContain("secret-key");
});

test("explicit model passes through untranslated", async () => {
	const { response } = await client()
		.messages.create({ model: "m", max_tokens: 10, messages: msgs })
		.withResponse();
	expect(lastBody().model).toBe("m");
	expect(jevCalls).toBe(0);
	expect(response.headers.get("x-gateway-tier")).toBeNull();
	expect(records[0]?.route).toBeUndefined();
});

test("count_tokens with auto uses default tier, no Jev", async () => {
	await client().messages.countTokens({ model: "auto", messages: msgs });
	expect(jevCalls).toBe(0);
	expect(lastBody().model).toBe("claude-opus-5-5");
	expect(records[0]?.route).toBeUndefined();
	expect(records[0]?.upstreamModel).toBe("claude-opus-5-5");
});
