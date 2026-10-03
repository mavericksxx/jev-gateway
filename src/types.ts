import type { Tier } from "./routing/tiers";

/** Token usage as reported by the Anthropic Messages API. */
export interface ClaudeUsage {
	input_tokens: number;
	output_tokens: number;
	cache_creation_input_tokens: number;
	cache_read_input_tokens: number;
}

/** One proxied request, emitted by the server once the upstream response has fully finished. */
export interface RequestRecord {
	/** Gateway-generated id (crypto.randomUUID()). */
	id: string;
	/** Epoch ms when the gateway received the request. */
	startedAt: number;
	/** Ms from receipt until the last byte was sent to the client. */
	latencyMs: number;
	endpoint: "messages" | "count_tokens";
	/** `model` from the client's request body. */
	requestedModel: string;
	/** Model actually sent upstream (equals requestedModel until Phase 2). */
	upstreamModel: string;
	stream: boolean;
	/** Upstream HTTP status, or 502 if the upstream could not be reached. */
	status: number;
	/** Null for count_tokens and for failed requests. */
	usage: ClaudeUsage | null;
	/** Error message for non-2xx or network failures, else null. */
	error: string | null;
	/** Present only when the gateway chose the model (`model: "auto"`). */
	route?: RouteDecision;
	/** Present only when a cheap-first attempt ran for this request. */
	cascade?: CascadeAttempt;
	/** Present only when tool trimming ran for this request. */
	toolTrim?: ToolTrim;
	/** Present only when the answer cache was consulted for this request. */
	cache?: CacheLookup;
}

/** How the router picked a tier for one request. */
export interface RouteDecision {
	tier: Tier;
	/**
	 * jev: Jev's pick. low-confidence: Jev unsure, default tier used. sticky: the
	 * conversation's earlier, higher tier kept. fallback: Jev skipped or failed
	 * (error, timeout, budget exhausted, routing turned off), default tier used.
	 */
	reason: "jev" | "low-confidence" | "sticky" | "fallback";
	/** Jev's confidence in its pick; null when Jev wasn't called or failed. */
	confidence: number | null;
	/** Jev's probability per offered tier; null when Jev wasn't called or failed. */
	probabilities: Partial<Record<Tier, number>> | null;
	jevLatencyMs: number | null;
	/** Charged to the gateway's Jev budget; null when Jev wasn't called or a caller-supplied key was used. */
	jevCostUsd: number | null;
	error: string | null;
}

/**
 * A cheap-first attempt. `RequestRecord.usage` and `upstreamModel` always describe the
 * response actually returned to the client: the first tier's when accepted, the
 * escalation tier's when not.
 */
export interface CascadeAttempt {
	/** Tier tried first. */
	firstTier: Tier;
	/** The router's pick; used when the first answer is rejected. */
	escalationTier: Tier;
	/** True when the first answer was returned to the client. */
	accepted: boolean;
	/** Jev's probability that the first answer fully answers the request; null when Jev wasn't asked. */
	passProbability: number | null;
	jevLatencyMs: number | null;
	/** Charged to the gateway's Jev budget; null when Jev wasn't called or a caller-supplied key was used. */
	jevCostUsd: number | null;
	/** Usage of the rejected first attempt; null when accepted or it failed before returning usage. */
	wastedUsage: ClaudeUsage | null;
	/** Cost of the rejected first attempt; 0 when accepted. */
	wastedCostUsd: number;
	/** Why it escalated without asking Jev (e.g. "stop_reason max_tokens"), or a Jev/upstream error. */
	error: string | null;
}

/** Tool trimming for one request: Jev scored each tool and unlikely ones were not sent upstream. */
export interface ToolTrim {
	/** Tools in the client's request. */
	offered: number;
	/** Tools sent upstream. */
	kept: number;
	/** Names of tools not sent upstream (empty when nothing was trimmed). */
	removed: string[];
	/** Estimate: Math.ceil(JSON.stringify(removed tool definitions).length / 4). */
	estimatedTokensSaved: number;
	/** Jev's probability per scored tool name; null when Jev wasn't called or failed. */
	scores: Record<string, number> | null;
	jevLatencyMs: number | null;
	/** Charged to the gateway's Jev budget; null when Jev wasn't called or a caller-supplied key was used. */
	jevCostUsd: number | null;
	/** Jev error, timeout or budget exhaustion; when set nothing was trimmed. */
	error: string | null;
}

/**
 * One answer-cache lookup. On a hit no upstream call is made: `RequestRecord.usage` and
 * `upstreamModel` describe the cached response (what it originally took to produce), and
 * the request's actual cost is 0.
 */
export interface CacheLookup {
	outcome: "hit" | "miss";
	/** Stored entries above the similarity threshold that Jev was asked about. */
	candidates: number;
	/** Cosine similarity of the closest stored question in scope; null when the scope was empty. */
	bestSimilarity: number | null;
	/** Jev's probability that the best candidate's answer fits; null when Jev wasn't asked. */
	matchProbability: number | null;
	/** On a hit, the id of the request whose answer was served. */
	sourceRequestId: string | null;
	jevLatencyMs: number | null;
	/** Charged to the gateway's Jev budget; null when Jev wasn't called or a caller-supplied key was used. */
	jevCostUsd: number | null;
	/** Wall time of the whole lookup, including embedding. */
	lookupMs: number;
	/** On a miss: true when this request's answer was storable and handed to the cache. Always false on a hit. */
	stored: boolean;
	error: string | null;
}
