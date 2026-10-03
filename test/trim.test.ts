import { expect, test } from "bun:test";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { createJevClient } from "../src/jev/client";
import { createMockFetch, type MockAnswers } from "../src/jev/mock-fetch";
import { createToolTrimmer, type ToolTrimmerOptions } from "../src/tools/trim";

const tool = (name: string, extra: Record<string, unknown> = {}) => ({
	name,
	description: `does ${name}`,
	input_schema: { type: "object", properties: {} },
	...extra,
});
const mkTools = (n: number) =>
	Array.from({ length: n }, (_, i) => tool(`tool${i}`));
const mkBody = (tools: unknown[], extra: Record<string, unknown> = {}) => ({
	model: "m",
	max_tokens: 10,
	messages: [{ role: "user", content: "hi" }],
	tools,
	...extra,
});
const names = (b: Record<string, unknown>) =>
	(b.tools as { name: string }[]).map((t) => t.name);

/** Scores by tool index: tools t0..; default low unless given. */
const answers = (high: number[], n: number, low = 0.01): MockAnswers =>
	Object.fromEntries(
		Array.from({ length: n }, (_, i) => [
			`t${i}`,
			high.includes(i) ? 0.9 : low,
		]),
	);

const setup = (
	mock: MockAnswers,
	o: Partial<ToolTrimmerOptions> = {},
	spent = { v: 0 },
) => {
	const trimmer = createToolTrimmer({
		jev: createJevClient({ mode: "mock", mockAnswers: mock }),
		budget: {
			remainingUsd: () => 1 - spent.v,
			charge: (x) => {
				spent.v += x;
			},
		},
		timeoutMs: 500,
		minTools: 5,
		minProbability: 0.2,
		keepTop: 0,
		pinned: [],
		...o,
	});
	return { trimmer, spent };
};

test("below minTools → null", async () => {
	const { trimmer } = setup({});
	const body = mkBody(mkTools(4));
	const r = await trimmer.trim(body);
	expect(r.record).toBeNull();
	expect(r.body).toBe(body);
});

test("defer_loading → null", async () => {
	const { trimmer } = setup({});
	const tools = mkTools(8);
	tools[2] = tool("x", { defer_loading: true }) as never;
	expect((await trimmer.trim(mkBody(tools))).record).toBeNull();
});

test("threshold, original order, estimate", async () => {
	const { trimmer } = setup(answers([1, 3, 5], 8));
	const body = mkBody(mkTools(8));
	const r = await trimmer.trim(body);
	expect(names(r.body)).toEqual(["tool1", "tool3", "tool5"]);
	expect(r.record?.kept).toBe(3);
	expect(r.record?.offered).toBe(8);
	expect(r.record?.removed).toEqual([
		"tool0",
		"tool2",
		"tool4",
		"tool6",
		"tool7",
	]);
	const removed = r.record?.removed.map((n) => body.tools[Number(n.slice(4))]);
	expect(r.record?.estimatedTokensSaved).toBe(
		Math.ceil(JSON.stringify(removed).length / 4),
	);
	expect(r.record?.scores?.tool1).toBe(0.9);
	expect(r.record?.error).toBeNull();
});

test("server tools kept and not scored; pinned; history; tool_choice", async () => {
	const seenQs: string[] = [];
	const jev = new TypeSafeClient({
		apiKey: "x",
		retry: { maxRetries: 0 },
		fetch: (i, init) => {
			seenQs.push(...Object.keys(JSON.parse(String(init?.body)).questions));
			return createMockFetch({})(i, init);
		},
	});
	const trimmer = createToolTrimmer({
		jev,
		budget: { remainingUsd: () => 1, charge() {} },
		timeoutMs: 500,
		minTools: 5,
		minProbability: 0.99,
		keepTop: 0,
		pinned: ["tool0"],
	});
	const tools = [
		...mkTools(8),
		{ type: "web_search_20260209", name: "web_search" },
		tool("custom1", { type: "custom" }),
	];
	const r = await trimmer.trim(
		mkBody(tools, {
			messages: [
				{ role: "user", content: "x" },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "1", name: "tool2", input: {} }],
				},
			],
			tool_choice: { type: "tool", name: "tool5" },
		}),
	);
	expect(names(r.body)).toEqual(["tool0", "tool2", "tool5", "web_search"]);
	expect(seenQs.length).toBe(9);
});

test("keepTop floor", async () => {
	const { trimmer } = setup(
		{ t2: 0.1, t4: 0.15, t0: 0.05, t1: 0.01, t3: 0.01, t5: 0.01 },
		{ minProbability: 0.9, keepTop: 2 },
	);
	const r = await trimmer.trim(mkBody(mkTools(6)));
	expect(names(r.body)).toEqual(["tool2", "tool4"]);
});

test("monotonic per conversation", async () => {
	const { trimmer } = setup(answers([1], 8));
	const first = await trimmer.trim(mkBody(mkTools(8)));
	expect(names(first.body)).toEqual(["tool1"]);
	const trimmer2Body = mkBody(mkTools(8));
	// Same conversation, now a different tool scores high.
	const { trimmer: t2 } = setup(answers([4], 8));
	await t2.trim(mkBody(mkTools(8)));
	const second = await t2.trim(trimmer2Body);
	expect(names(second.body)).toEqual(["tool4"]);
	const t3 = setup(answers([1], 8)).trimmer;
	await t3.trim(mkBody(mkTools(8)));
	// swap scores by using a trimmer with shared state: emulate via a switching jev
	let hi = [1];
	const shared = createToolTrimmer({
		jev: new TypeSafeClient({
			apiKey: "x",
			retry: { maxRetries: 0 },
			fetch: (i, init) => createMockFetch(answers(hi, 8))(i, init),
		}),
		budget: { remainingUsd: () => 1, charge() {} },
		timeoutMs: 500,
		minTools: 5,
		minProbability: 0.2,
		keepTop: 0,
		pinned: [],
	});
	await shared.trim(mkBody(mkTools(8)));
	hi = [4];
	const turn2 = await shared.trim(mkBody(mkTools(8)));
	expect(names(turn2.body)).toEqual(["tool1", "tool4"]);
	const other = await shared.trim(
		mkBody(mkTools(8), { messages: [{ role: "user", content: "other" }] }),
	);
	expect(names(other.body)).toEqual(["tool4"]);
});

test(">50 tools → multiple Jev calls", async () => {
	const bodies: { questions: Record<string, unknown> }[] = [];
	const trimmer = createToolTrimmer({
		jev: new TypeSafeClient({
			apiKey: "x",
			retry: { maxRetries: 0 },
			fetch: (i, init) => {
				bodies.push(JSON.parse(String(init?.body)));
				return createMockFetch({})(i, init);
			},
		}),
		budget: { remainingUsd: () => 1, charge() {} },
		timeoutMs: 500,
		minTools: 5,
		minProbability: 0.2,
		keepTop: 0,
		pinned: [],
	});
	const r = await trimmer.trim(mkBody(mkTools(120)));
	expect(bodies.length).toBe(3);
	expect(bodies.map((b) => Object.keys(b.questions).length)).toEqual([
		50, 50, 20,
	]);
	expect(r.record?.kept).toBe(120);
});

test("Jev error → nothing trimmed", async () => {
	const trimmer = createToolTrimmer({
		jev: new TypeSafeClient({
			apiKey: "x",
			retry: { maxRetries: 0 },
			fetch: async () => new Response("boom", { status: 500 }),
		}),
		budget: { remainingUsd: () => 1, charge() {} },
		timeoutMs: 500,
		minTools: 5,
		minProbability: 0.2,
		keepTop: 0,
		pinned: [],
	});
	const body = mkBody(mkTools(8));
	const r = await trimmer.trim(body);
	expect(r.body).toBe(body);
	expect(r.record?.error).toBeTruthy();
	expect(r.record?.kept).toBe(8);
	expect(r.record?.scores).toBeNull();
});

test("budget exhausted → Jev not called; caller client not charged", async () => {
	let calls = 0;
	const jev = new TypeSafeClient({
		apiKey: "x",
		retry: { maxRetries: 0 },
		fetch: (i, init) => {
			calls++;
			return createMockFetch(answers([1], 8))(i, init);
		},
	});
	const spent = { v: 0 };
	let remaining = 0;
	const trimmer = createToolTrimmer({
		jev,
		budget: {
			remainingUsd: () => remaining,
			charge: (x) => {
				spent.v += x;
			},
		},
		timeoutMs: 500,
		minTools: 5,
		minProbability: 0.2,
		keepTop: 0,
		pinned: [],
	});
	const r = await trimmer.trim(mkBody(mkTools(8)));
	expect(calls).toBe(0);
	expect(r.record?.error).toContain("budget");
	const c = await trimmer.trim(mkBody(mkTools(8)), { jev });
	expect(calls).toBe(1);
	expect(names(c.body)).toEqual(["tool1"]);
	expect(c.record?.jevCostUsd).toBeNull();
	expect(spent.v).toBe(0);
	remaining = 1;
	const own = await trimmer.trim(mkBody(mkTools(8), { system: "s" }));
	expect(own.record?.jevCostUsd).toBeGreaterThan(0);
	expect(spent.v).toBeGreaterThan(0);
});

test("cache_control moves to last kept tool; no mutation", async () => {
	const { trimmer } = setup(answers([1, 2], 8));
	const tools = mkTools(8);
	(tools[7] as Record<string, unknown>).cache_control = { type: "ephemeral" };
	const body = mkBody(tools);
	const before = structuredClone(body);
	const r = await trimmer.trim(body);
	expect(body).toEqual(before);
	const out = r.body.tools as Record<string, unknown>[];
	expect(out.map((t) => t.name)).toEqual(["tool1", "tool2"]);
	expect(out[1]?.cache_control).toEqual({ type: "ephemeral" });
	expect(out[0]?.cache_control).toBeUndefined();
	expect((tools[2] as Record<string, unknown>).cache_control).toBeUndefined();
});
