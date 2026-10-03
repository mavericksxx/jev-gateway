import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ClaudeCall {
	model: string;
	effort?: "low" | "medium" | "high";
	system: string;
	prompt: string;
	timeoutMs: number;
}

export interface ClaudeResult {
	text: string;
	model: string;
	usage: {
		input_tokens: number;
		output_tokens: number;
		cache_read_input_tokens: number;
		cache_creation_input_tokens: number;
	};
	costUsd: number;
	durationMs: number;
	stopReason: string | null;
	raw: unknown;
	/** Attempts used (1 unless a rate-limit/overload error was retried). */
	attempts?: number;
}

export type RunClaude = (call: ClaudeCall) => Promise<ClaudeResult>;

export type FailureClass =
	| "rate_limit"
	| "timeout"
	| "model_mismatch"
	| "cli_error"
	| "parse";

export class ClaudeError extends Error {
	constructor(
		readonly failureClass: FailureClass,
		message: string,
		readonly attempts = 1,
	) {
		super(message);
	}
}

const MAX_ATTEMPTS = 3;
const RETRYABLE = /rate.?limit|overload|too many requests|\b(429|503|529)\b/i;

/** Model that did the work: the modelUsage entry with the most tokens. */
export function servedModel(raw: Record<string, unknown>): string | null {
	const mu = raw.modelUsage as
		| Record<string, { inputTokens?: number; outputTokens?: number }>
		| undefined;
	if (!mu) return null;
	let best: string | null = null;
	let bestTokens = -1;
	for (const [m, u] of Object.entries(mu)) {
		const t = (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
		if (t > bestTokens) {
			best = m;
			bestTokens = t;
		}
	}
	return best;
}

const modelMatches = (served: string, wanted: string): boolean =>
	served === wanted || served.startsWith(`${wanted}-`);

/** Parse `claude -p --output-format json` stdout; throws ClaudeError on errors or a wrong served model. */
export function parseCliOutput(
	stdout: string,
	call: Pick<ClaudeCall, "model">,
): ClaudeResult {
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(stdout) as Record<string, unknown>;
	} catch {
		throw new ClaudeError(
			"parse",
			`unparseable CLI output: ${stdout.slice(0, 200)}`,
		);
	}
	if (raw.is_error === true) {
		const msg = String(raw.result ?? raw.subtype ?? "error");
		const status = String(raw.api_error_status ?? "");
		throw new ClaudeError(
			RETRYABLE.test(`${msg} ${status}`) ? "rate_limit" : "cli_error",
			`${msg} ${status}`.trim(),
		);
	}
	const served = servedModel(raw);
	if (!served || !modelMatches(served, call.model)) {
		throw new ClaudeError(
			"model_mismatch",
			`requested ${call.model}, served ${served ?? "unknown"}`,
		);
	}
	const u = (raw.usage ?? {}) as Record<string, number | undefined>;
	return {
		text: String(raw.result ?? ""),
		model: served,
		usage: {
			input_tokens: u.input_tokens ?? 0,
			output_tokens: u.output_tokens ?? 0,
			cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
			cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
		},
		costUsd: Number(raw.total_cost_usd ?? 0),
		durationMs: Number(raw.duration_ms ?? 0),
		stopReason: (raw.stop_reason as string | null | undefined) ?? null,
		raw,
	};
}

async function spawnOnce(call: ClaudeCall): Promise<ClaudeResult> {
	const args = [
		"claude",
		"-p",
		"--output-format",
		"json",
		"--model",
		call.model,
		"--system-prompt",
		call.system,
		// Load nothing from the user's setup: no settings/hooks/CLAUDE.md, MCP, tools, skills; no session file.
		"--setting-sources=",
		"--strict-mcp-config",
		"--tools=",
		"--disable-slash-commands",
		"--no-session-persistence",
		"--exclude-dynamic-system-prompt-sections",
	];
	if (call.effort) args.push("--effort", call.effort);
	const cwd = mkdtempSync(join(tmpdir(), "jev-eval-"));
	let timedOut = false;
	try {
		const proc = Bun.spawn(args, {
			cwd,
			stdin: Buffer.from(call.prompt),
			stdout: "pipe",
			stderr: "pipe",
		});
		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill("SIGKILL");
		}, call.timeoutMs);
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		clearTimeout(timer);
		if (timedOut) {
			throw new ClaudeError("timeout", `exceeded ${call.timeoutMs}ms`);
		}
		if (!stdout.trim()) {
			const msg = stderr.slice(0, 300);
			throw new ClaudeError(
				RETRYABLE.test(msg) ? "rate_limit" : "cli_error",
				msg || "empty output",
			);
		}
		return parseCliOutput(stdout, call);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

export const runClaudeCli: RunClaude = async (call) => {
	for (let attempt = 1; ; attempt++) {
		try {
			return { ...(await spawnOnce(call)), attempts: attempt };
		} catch (err) {
			const e =
				err instanceof ClaudeError
					? err
					: new ClaudeError("cli_error", String(err));
			if (e.failureClass !== "rate_limit" || attempt >= MAX_ATTEMPTS) {
				throw new ClaudeError(e.failureClass, e.message, attempt);
			}
			await Bun.sleep(2000 * 2 ** (attempt - 1) * (0.5 + Math.random()));
		}
	}
};
