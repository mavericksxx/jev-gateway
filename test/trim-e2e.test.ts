import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { createMockFetch } from "../src/jev/mock-fetch";
import { createRouter } from "../src/routing/router";
import { createApp } from "../src/server";
import { createToolTrimmer } from "../src/tools/trim";
import type { RequestRecord } from "../src/types";
import { type FakeUpstream, startFakeUpstream } from "./fake-upstream";

let upstream: FakeUpstream;
let gateway: ReturnType<typeof Bun.serve>;
let records: RequestRecord[] = [];
let defaultOn = false;
let madeKeys: string[] = [];
let callerCalls = 0;
let conv = 0;

const mkJev = (onCall?: () => void) =>
	new TypeSafeClient({
		apiKey: "x",
		retry: { maxRetries: 0 },
		fetch: (i, init) => {
			onCall?.();
			const qs = JSON.parse(String(init?.body)).questions;
			return createMockFetch(
				"tier" in qs ? { tier: "sonnet-low" } : { t0: 0.9, t1: 0.9 },
			)(i, init);
		},
	});
const budget = { remainingUsd: () => 1, charge() {} };
const tools = Array.from({ length: 24 }, (_, i) => ({
	name: `tool${i}`,
	description: `d${i}`,
	input_schema: { type: "object" as const, properties: {} },
}));
const client = (headers: Record<string, string> = {}) =>
	new Anthropic({
		apiKey: "k1",
		baseURL: `http://localhost:${gateway.port}`,
		maxRetries: 0,
		defaultHeaders: headers,
	});
// Unique conversation per call so the monotonic state never leaks between tests.
const msgs = () => [{ role: "user" as const, content: `hi ${conv++}` }];
const lastBody = () =>
	upstream.requests.at(-1)?.body as { model: string; tools?: unknown[] };

beforeAll(() => {
	upstream = startFakeUpstream();
	const jev = mkJev();
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
			makeJevClient: (key) => {
				madeKeys.push(key);
				return mkJev(() => callerCalls++);
			},
			toolTrim: {
				trimmer: createToolTrimmer({
					jev,
					budget,
					timeoutMs: 500,
					minTools: 15,
					minProbability: 0.6,
					keepTop: 0,
					pinned: [],
				}),
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
	upstream.requests.length = 0;
	madeKeys = [];
	callerCalls = 0;
	defaultOn = false;
});

const send = (c: Anthropic, model = "claude-opus-4-7") =>
	c.messages
		.create({ model, max_tokens: 10, messages: msgs(), tools })
		.asResponse();

test("header on trims", async () => {
	const res = await send(client({ "x-gateway-trim-tools": "on" }));
	expect(lastBody().tools?.length).toBe(2);
	expect(records[0]?.toolTrim?.kept).toBe(2);
	expect(res.headers.get("x-gateway-tools")).toBe("2/24");
});

test("header off keeps all", async () => {
	defaultOn = true;
	const res = await send(client({ "x-gateway-trim-tools": "off" }));
	expect(lastBody().tools?.length).toBe(24);
	expect(records[0]?.toolTrim).toBeUndefined();
	expect(res.headers.get("x-gateway-tools")).toBeNull();
});

test("defaultOn trims without header", async () => {
	defaultOn = true;
	await send(client());
	expect(lastBody().tools?.length).toBe(2);
});

test("routed + trimmed", async () => {
	await send(client({ "x-gateway-trim-tools": "on" }), "auto");
	expect(lastBody().model).toBe("claude-sonnet-5-5");
	expect(lastBody().tools?.length).toBe(2);
	expect(records[0]?.route).toBeDefined();
	expect(records[0]?.toolTrim).toBeDefined();
});

test("count_tokens never trimmed", async () => {
	await client({ "x-gateway-trim-tools": "on" }).messages.countTokens({
		model: "claude-opus-4-7",
		messages: msgs(),
		tools,
	});
	expect(lastBody().tools?.length).toBe(24);
	expect(records[0]?.toolTrim).toBeUndefined();
});

test("x-jev-key uses caller client", async () => {
	await send(client({ "x-gateway-trim-tools": "on", "x-jev-key": "mine" }));
	expect(madeKeys).toEqual(["mine"]);
	expect(callerCalls).toBe(1);
	expect(records[0]?.toolTrim?.jevCostUsd).toBeNull();
});
