import { Database } from "bun:sqlite";
import type Anthropic from "@anthropic-ai/sdk";

export interface CacheEntry {
	id: string;
	scope: string;
	question: string;
	embedding: Float32Array;
	message: Anthropic.Beta.Messages.BetaMessage;
	requestId: string;
	createdAt: number;
}

export interface CacheStore {
	add(entry: CacheEntry): void;
	/** Non-expired entries in a scope, newest first, at most 5000. */
	inScope(scope: string, now: number, ttlMs: number): CacheEntry[];
	/** Delete expired entries; returns how many. */
	prune(now: number, ttlMs: number): number;
	close(): void;
}

interface Row {
	id: string;
	scope: string;
	question: string;
	embedding: Uint8Array;
	message: string;
	request_id: string;
	created_at: number;
}

export function createCacheStore(path: string): CacheStore {
	const db = new Database(path);
	if (path !== ":memory:") db.run("PRAGMA journal_mode = WAL");
	db.run(`CREATE TABLE IF NOT EXISTS cache_entries (
		id TEXT PRIMARY KEY,
		scope TEXT NOT NULL,
		question TEXT NOT NULL,
		embedding BLOB NOT NULL,
		message TEXT NOT NULL,
		request_id TEXT NOT NULL,
		created_at INTEGER NOT NULL
	)`);
	db.run(
		"CREATE INDEX IF NOT EXISTS cache_entries_scope ON cache_entries (scope, created_at)",
	);
	const insert = db.prepare(
		"INSERT OR REPLACE INTO cache_entries VALUES (?, ?, ?, ?, ?, ?, ?)",
	);
	const select = db.prepare(
		"SELECT * FROM cache_entries WHERE scope = ? AND created_at > ? ORDER BY created_at DESC LIMIT 5000",
	);
	const del = db.prepare("DELETE FROM cache_entries WHERE created_at <= ?");
	return {
		add(e) {
			insert.run(
				e.id,
				e.scope,
				e.question,
				new Uint8Array(
					e.embedding.buffer,
					e.embedding.byteOffset,
					e.embedding.byteLength,
				),
				JSON.stringify(e.message),
				e.requestId,
				e.createdAt,
			);
		},
		inScope(scope, now, ttlMs) {
			return (select.all(scope, now - ttlMs) as Row[]).map((r) => ({
				id: r.id,
				scope: r.scope,
				question: r.question,
				embedding: new Float32Array(
					r.embedding.buffer.slice(
						r.embedding.byteOffset,
						r.embedding.byteOffset + r.embedding.byteLength,
					),
				),
				message: JSON.parse(r.message),
				requestId: r.request_id,
				createdAt: r.created_at,
			}));
		},
		prune(now, ttlMs) {
			return del.run(now - ttlMs).changes;
		},
		close() {
			db.close();
		},
	};
}
