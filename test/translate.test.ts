import { describe, expect, test } from "bun:test";
import { ALL_TIERS, TIERS, type Tier } from "../src/routing/tiers";
import { translateParams } from "../src/upstream/translate";

const BETA = "server-side-fallback-2026-07-01";
const messages = [{ role: "user", content: "hi" }];
const tools = [{ name: "x", input_schema: { type: "object" } }];

const sink = () => ({
	model: "auto",
	max_tokens: 100000,
	messages,
	tools,
	temperature: 0.5,
	top_p: 0.9,
	top_k: 40,
	thinking: { type: "enabled", budget_tokens: 2000, display: "summarized" },
	tool_choice: { type: "tool", name: "x", disable_parallel_tool_use: true },
	output_config: { effort: "max", format: { type: "json_schema", schema: {} } },
	mystery: { a: 1 },
});

const fmt = { type: "json_schema", schema: {} };

describe("kitchen sink", () => {
	test("haiku", () => {
		expect(translateParams(sink(), "haiku")).toEqual({
			body: {
				model: "claude-haiku-4-5",
				max_tokens: 64000,
				messages,
				tools,
				temperature: 0.5,
				top_p: 0.9,
				top_k: 40,
				thinking: {
					type: "enabled",
					budget_tokens: 2000,
					display: "summarized",
				},
				tool_choice: {
					type: "tool",
					name: "x",
					disable_parallel_tool_use: true,
				},
				output_config: { format: fmt },
				mystery: { a: 1 },
			},
			addBetas: [],
		});
	});

	for (const tier of ALL_TIERS.filter((t) => t !== "haiku")) {
		test(tier, () => {
			expect(translateParams(sink(), tier)).toEqual({
				body: {
					model: TIERS[tier].model,
					max_tokens: 100000,
					messages,
					tools,
					thinking:
						tier === "fable-high"
							? undefined
							: { type: "adaptive", display: "summarized" },
					tool_choice: { type: "auto", disable_parallel_tool_use: true },
					output_config: { effort: TIERS[tier].effort, format: fmt },
					mystery: { a: 1 },
					fallbacks: "default",
				},
				addBetas: [BETA],
			});
		});
	}
});

describe("thinking by model", () => {
	const enabled = { type: "enabled", budget_tokens: 2000 };
	const table: [string, Tier, Record<string, unknown>, unknown][] = [
		["haiku enabled valid", "haiku", enabled, enabled],
		[
			"haiku enabled low budget",
			"haiku",
			{ type: "enabled", budget_tokens: 100 },
			undefined,
		],
		["haiku disabled", "haiku", { type: "disabled" }, { type: "disabled" }],
		["haiku adaptive", "haiku", { type: "adaptive" }, undefined],
		["haiku between_tools", "haiku", { type: "between_tools" }, undefined],
		["haiku unknown", "haiku", { type: "zzz" }, undefined],
		[
			"sonnet adaptive",
			"sonnet-low",
			{ type: "adaptive" },
			{ type: "adaptive" },
		],
		[
			"sonnet between_tools",
			"sonnet-low",
			{ type: "between_tools" },
			{ type: "between_tools" },
		],
		["sonnet enabled", "sonnet-low", enabled, { type: "adaptive" }],
		[
			"sonnet enabled display",
			"sonnet-high",
			{ ...enabled, display: "omitted" },
			{ type: "adaptive", display: "omitted" },
		],
		["sonnet disabled", "sonnet-low", { type: "disabled" }, undefined],
		["opus adaptive", "opus-low", { type: "adaptive" }, { type: "adaptive" }],
		["opus enabled", "opus-medium", enabled, { type: "adaptive" }],
		[
			"opus enabled display",
			"opus-high",
			{ ...enabled, display: "summarized" },
			{ type: "adaptive", display: "summarized" },
		],
		["opus disabled", "opus-low", { type: "disabled" }, undefined],
		["opus between_tools", "opus-low", { type: "between_tools" }, undefined],
		[
			"fable adaptive",
			"fable-high",
			{ type: "adaptive" },
			{ type: "adaptive" },
		],
		["fable enabled", "fable-high", enabled, undefined],
		["fable disabled", "fable-high", { type: "disabled" }, undefined],
		["fable between_tools", "fable-high", { type: "between_tools" }, undefined],
	];
	for (const [name, tier, thinking, expected] of table) {
		test(name, () => {
			const { body } = translateParams({ max_tokens: 4096, thinking }, tier);
			expect(body.thinking).toEqual(expected);
			expect("thinking" in body).toBe(expected !== undefined);
		});
	}

	test("absent stays absent", () => {
		for (const t of ALL_TIERS) {
			expect("thinking" in translateParams({ max_tokens: 10 }, t).body).toBe(
				false,
			);
		}
	});
});

describe("haiku", () => {
	test("effort-only output_config is removed", () => {
		const { body } = translateParams(
			{ output_config: { effort: "high" } },
			"haiku",
		);
		expect("output_config" in body).toBe(false);
	});
	test("budget >= clamped max_tokens is dropped", () => {
		const { body } = translateParams(
			{
				max_tokens: 100000,
				thinking: { type: "enabled", budget_tokens: 70000 },
			},
			"haiku",
		);
		expect(body.max_tokens).toBe(64000);
		expect("thinking" in body).toBe(false);
	});
	test("max_tokens under the cap is unchanged", () => {
		expect(translateParams({ max_tokens: 500 }, "haiku").body.max_tokens).toBe(
			500,
		);
	});
});

describe("fallbacks", () => {
	test("client value preserved for non-haiku", () => {
		for (const t of ALL_TIERS.filter((x) => x !== "haiku")) {
			const r = translateParams({ fallbacks: [{ model: "m" }] }, t);
			expect(r.body.fallbacks).toEqual([{ model: "m" }]);
			expect(r.addBetas).toEqual([]);
		}
	});
	test("removed for haiku", () => {
		const r = translateParams({ fallbacks: "default" }, "haiku");
		expect("fallbacks" in r.body).toBe(false);
		expect(r.addBetas).toEqual([]);
	});
});

describe("tool_choice", () => {
	test("any without parallel flag", () => {
		expect(
			translateParams({ tool_choice: { type: "any" } }, "opus-low").body
				.tool_choice,
		).toEqual({ type: "auto" });
	});
	test("auto and none unchanged", () => {
		expect(
			translateParams({ tool_choice: { type: "none" } }, "opus-low").body
				.tool_choice,
		).toEqual({ type: "none" });
	});
});

describe("purity", () => {
	test("input is not mutated", () => {
		for (const t of ALL_TIERS) {
			const input = sink();
			const before = structuredClone(input);
			translateParams(input, t);
			expect(input).toEqual(before);
		}
	});
	test("idempotent", () => {
		for (const t of ALL_TIERS) {
			const once = translateParams(sink(), t).body;
			expect(translateParams(once, t).body).toEqual(once);
		}
	});
});
