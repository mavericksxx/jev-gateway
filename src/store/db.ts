import { Database } from "bun:sqlite";
import type { RequestRecord, RouteDecision } from "../types";

export interface StoredRequest extends RequestRecord {
	costUsd: number | null;
}

export interface Store {
	insert(record: RequestRecord, costUsd: number | null): void;
	/** Newest first (by startedAt, then insertion order). */
	recent(limit: number): StoredRequest[];
	/** Total Jev spend recorded so far (USD). */
	jevSpentUsd(): number;
	close(): void;
}

interface Row {
	id: string;
	started_at: number;
	latency_ms: number;
	endpoint: "messages" | "count_tokens";
	requested_model: string;
	upstream_model: string;
	stream: number;
	status: number;
	input_tokens: number | null;
	output_tokens: number | null;
	cache_creation_input_tokens: number | null;
	cache_read_input_tokens: number | null;
	error: string | null;
	cost_usd: number | null;
	route_tier: RouteDecision["tier"] | null;
	route_reason: RouteDecision["reason"] | null;
	route_confidence: number | null;
	route_probabilities: string | null;
	jev_latency_ms: number | null;
	jev_cost_usd: number | null;
	route_error: string | null;
}

const ROUTE_COLUMNS: Record<string, string> = {
	route_tier: "TEXT",
	route_reason: "TEXT",
	route_confidence: "REAL",
	route_probabilities: "TEXT",
	jev_latency_ms: "INTEGER",
	jev_cost_usd: "REAL",
	route_error: "TEXT",
};

/** Opens (and creates if needed) the database. Tests pass ":memory:". */
export function createStore(path: string): Store {
	const db = new Database(path);
	if (path !== ":memory:") db.run("PRAGMA journal_mode = WAL");
	db.run(`CREATE TABLE IF NOT EXISTS requests (
		id TEXT PRIMARY KEY,
		started_at INTEGER NOT NULL,
		latency_ms INTEGER NOT NULL,
		endpoint TEXT NOT NULL,
		requested_model TEXT NOT NULL,
		upstream_model TEXT NOT NULL,
		stream INTEGER NOT NULL,
		status INTEGER NOT NULL,
		input_tokens INTEGER,
		output_tokens INTEGER,
		cache_creation_input_tokens INTEGER,
		cache_read_input_tokens INTEGER,
		error TEXT,
		cost_usd REAL
	)`);
	const have = new Set(
		db
			.query<{ name: string }, []>("PRAGMA table_info(requests)")
			.all()
			.map((c) => c.name),
	);
	for (const [name, type] of Object.entries(ROUTE_COLUMNS)) {
		if (!have.has(name))
			db.run(`ALTER TABLE requests ADD COLUMN ${name} ${type}`);
	}
	db.run(
		"CREATE INDEX IF NOT EXISTS idx_requests_started_at ON requests (started_at)",
	);

	const insertStmt = db.query(
		`INSERT INTO requests (
			id, started_at, latency_ms, endpoint, requested_model, upstream_model,
			stream, status, input_tokens, output_tokens, cache_creation_input_tokens,
			cache_read_input_tokens, error, cost_usd,
			route_tier, route_reason, route_confidence, route_probabilities,
			jev_latency_ms, jev_cost_usd, route_error
		) VALUES (
			$id, $started_at, $latency_ms, $endpoint, $requested_model, $upstream_model,
			$stream, $status, $input_tokens, $output_tokens, $cache_creation_input_tokens,
			$cache_read_input_tokens, $error, $cost_usd,
			$route_tier, $route_reason, $route_confidence, $route_probabilities,
			$jev_latency_ms, $jev_cost_usd, $route_error
		)`,
	);
	const spentStmt = db.query<{ total: number | null }, []>(
		"SELECT SUM(jev_cost_usd) AS total FROM requests",
	);
	const recentStmt = db.query<Row, [number]>(
		"SELECT * FROM requests ORDER BY started_at DESC, rowid DESC LIMIT ?",
	);

	return {
		insert(r, costUsd) {
			insertStmt.run({
				$id: r.id,
				$started_at: r.startedAt,
				$latency_ms: r.latencyMs,
				$endpoint: r.endpoint,
				$requested_model: r.requestedModel,
				$upstream_model: r.upstreamModel,
				$stream: r.stream ? 1 : 0,
				$status: r.status,
				$input_tokens: r.usage?.input_tokens ?? null,
				$output_tokens: r.usage?.output_tokens ?? null,
				$cache_creation_input_tokens:
					r.usage?.cache_creation_input_tokens ?? null,
				$cache_read_input_tokens: r.usage?.cache_read_input_tokens ?? null,
				$error: r.error,
				$cost_usd: costUsd,
				$route_tier: r.route?.tier ?? null,
				$route_reason: r.route?.reason ?? null,
				$route_confidence: r.route?.confidence ?? null,
				$route_probabilities: r.route?.probabilities
					? JSON.stringify(r.route.probabilities)
					: null,
				$jev_latency_ms: r.route?.jevLatencyMs ?? null,
				$jev_cost_usd: r.route?.jevCostUsd ?? null,
				$route_error: r.route?.error ?? null,
			});
		},
		recent(limit) {
			return recentStmt.all(limit).map((row) => ({
				id: row.id,
				startedAt: row.started_at,
				latencyMs: row.latency_ms,
				endpoint: row.endpoint,
				requestedModel: row.requested_model,
				upstreamModel: row.upstream_model,
				stream: row.stream === 1,
				status: row.status,
				usage:
					row.input_tokens === null
						? null
						: {
								input_tokens: row.input_tokens,
								output_tokens: row.output_tokens ?? 0,
								cache_creation_input_tokens:
									row.cache_creation_input_tokens ?? 0,
								cache_read_input_tokens: row.cache_read_input_tokens ?? 0,
							},
				error: row.error,
				costUsd: row.cost_usd,
				...(row.route_tier !== null && row.route_reason !== null
					? {
							route: {
								tier: row.route_tier,
								reason: row.route_reason,
								confidence: row.route_confidence,
								probabilities: row.route_probabilities
									? JSON.parse(row.route_probabilities)
									: null,
								jevLatencyMs: row.jev_latency_ms,
								jevCostUsd: row.jev_cost_usd,
								error: row.route_error,
							},
						}
					: {}),
			}));
		},
		jevSpentUsd() {
			return spentStmt.get()?.total ?? 0;
		},
		close() {
			db.close();
		},
	};
}
