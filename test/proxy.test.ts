import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { createApp } from "../src/server";
import type { RequestRecord } from "../src/types";
import { type FakeUpstream, startFakeUpstream } from "./fake-upstream";

let upstream: FakeUpstream;
let gateway: ReturnType<typeof Bun.serve>;
let records: RequestRecord[] = [];

const serve = (upstreamBaseURL: string) =>
	Bun.serve({
		port: 0,
		fetch: createApp({
			upstreamBaseURL,
			onRecord: (r) => records.push(r),
		}).fetch,
	});

const client = (opts: ConstructorParameters<typeof Anthropic>[0] = {}) =>
	new Anthropic({
		apiKey: "k1",
		baseURL: `http://localhost:${gateway.port}`,
		maxRetries: 0,
		...opts,
	});

const req = { model: "m", max_tokens: 10 };
const msgs = [{ role: "user" as const, content: "hi" }];

beforeAll(() => {
	upstream = startFakeUpstream();
	gateway = serve(upstream.url);
});
afterAll(() => {
	gateway.stop(true);
	upstream.stop();
});
beforeEach(() => {
	records = [];
	upstream.requests.length = 0;
});

test("non-streaming passes body through and records usage", async () => {
	const body = {
		...req,
		messages: msgs,
		metadata: { user_id: "u1" },
		made_up_field: { a: 1 },
	};
	const msg = await client().messages.create(body as never);
	expect(msg.content[0]).toMatchObject({ text: "Hello" });
	expect(upstream.requests[0]?.body).toEqual(body);
	expect(upstream.requests[0]?.headers["x-api-key"]).toBe("k1");
	expect(records).toHaveLength(1);
	expect(records[0]).toMatchObject({
		status: 200,
		stream: false,
		endpoint: "messages",
		usage: {
			input_tokens: 10,
			output_tokens: 5,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 3,
		},
	});
});

test("streaming returns text and records usage", async () => {
	const msg = await client()
		.messages.stream({ ...req, messages: msgs })
		.finalMessage();
	expect(msg.content[0]).toMatchObject({ text: "Hello" });
	await Bun.sleep(20);
	expect(records[0]).toMatchObject({
		stream: true,
		status: 200,
		usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 },
	});
});

test("anthropic-beta header is forwarded", async () => {
	await client().messages.create(
		{ ...req, messages: msgs },
		{ headers: { "anthropic-beta": "foo-2025, bar-2025" } },
	);
	expect(upstream.requests[0]?.headers["anthropic-beta"]).toContain("foo-2025");
});

test("upstream 400 surfaces as BadRequestError", async () => {
	const err = await client()
		.messages.create({ model: "error-model", max_tokens: 1, messages: msgs })
		.catch((e) => e);
	expect(err).toBeInstanceOf(Anthropic.BadRequestError);
	expect(err.message).toContain("bad model");
	expect(records[0]?.status).toBe(400);
	expect(records[0]?.error).not.toBeNull();
});

test("count_tokens", async () => {
	const res = await client().messages.countTokens({
		model: "m",
		messages: msgs,
	});
	expect(res.input_tokens).toBe(42);
	expect(records[0]).toMatchObject({
		endpoint: "count_tokens",
		usage: null,
		stream: false,
	});
});

test("no credentials gives 401 without calling upstream", async () => {
	const res = await fetch(`http://localhost:${gateway.port}/v1/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ ...req, messages: msgs }),
	});
	expect(res.status).toBe(401);
	expect(upstream.requests).toHaveLength(0);
	expect(records[0]?.status).toBe(401);
});

test("bearer token is forwarded", async () => {
	await client({ apiKey: null, authToken: "t0k" }).messages.create({
		...req,
		messages: msgs,
	});
	expect(upstream.requests[0]?.headers.authorization).toBe("Bearer t0k");
});

test("unreachable upstream gives 502", async () => {
	const dead = startFakeUpstream();
	const deadUrl = dead.url;
	dead.stop();
	const gw = serve(deadUrl);
	const res = await fetch(`http://localhost:${gw.port}/v1/messages`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-api-key": "k" },
		body: JSON.stringify({ ...req, messages: msgs }),
	});
	gw.stop(true);
	expect(res.status).toBe(502);
	expect(records[0]?.status).toBe(502);
});
