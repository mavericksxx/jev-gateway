# jev-gateway — Spec

Status: **draft for review** · Last updated: 2026-10-03

## 1. What it is

A local proxy that speaks the Claude Messages API (`POST /v1/messages`). Point any Claude client at it with `ANTHROPIC_BASE_URL=http://localhost:8787` and it:

1. **Routes** each request to the cheapest Claude model + effort level that can handle it (Jev decides).
2. **Cascades**: tries a cheap model first and escalates only if Jev judges the answer inadequate.
3. **Trims tools**: sends only the tools relevant to the current turn.
4. **Caches semantically**: returns a stored answer when Jev judges a new question equivalent to an old one.
5. **Shows the savings** on a dashboard: dollars saved, model mix, latency overhead, Jev spend.

Every layer is optional, switchable per request, and **fails open**: if Jev errors, times out or the budget is hit, the request goes through unchanged to the default model.

### Goals
- Drop-in: no client code changes beyond the base URL.
- Honest numbers: the headline "cut cost by X% at Y% quality" comes from a measured eval (Phase 7), not from estimates.
- Cheap to run: Jev spend capped (default $1); everything testable offline with mock mode.
- Bring-your-own keys: Anthropic key comes from the caller's request; Jev key from env or a per-request header.

### Non-goals (v1)
- Other LLM providers (OpenAI, Gemini, …).
- Hosted multi-tenant service, user accounts, auth.
- Conversation-history trimming (conflicts with preserved-thinking rules on current models; see §6).
- Batch API routing.

## 2. Background facts the design depends on

**Jev (TypeSafe)** — verified in Phase 0 against the live API (`fixtures/jev/verify.json`): model `jev-1.13.0`; each extra question adds ~70 input tokens (343 → 482 going from 1 to 3 questions), so question text is billed; output tokens are reported but free; latency 323–413 ms over 5 calls. The rest below comes from public write-ups.
- Answers only typed questions about a text/JSON `state`: **choice** (≤255 options, returns probabilities + confidence), **score** (ordered levels), **noul** (probability a statement is true).
- All questions in one request run in parallel and are independent of each other.
- ~70–500 ms latency. $0.042 / 1M input tokens, output free (~$0.00002 for a 450-token request).
- **State limit ~32k tokens**, total request ~64k. Plain text only, no streaming.
- Native endpoint reportedly `POST https://api.typesafe.ai/v1/systemone`; also available via OpenRouter (`POST /api/alpha/decisions`, model `typesafe/jev-1.13`). Official JS SDK: `@typesafe-ai/sdk` (Node ≥ 20).

**Claude models** (Anthropic list prices, $/1M tokens, cached 2026-09-25)

| Tier | Model ID | Input | Output | Notes |
|---|---|---|---|---|
| Haiku | `claude-haiku-4-5` | $1 | $5 | 200K context; thinking via `budget_tokens`; no `effort` |
| Sonnet | `claude-sonnet-5-5` | $2 | $10 | `effort` low→max; `thinking:{type:"disabled"}` is a 400 |
| Opus | `claude-opus-5-5` | $4 | $20 | `effort` default `medium`; thinking cannot be disabled |
| Fable | `claude-fable-5-1` | $10 | $50 | Top tier. Thinking always on (omit `thinking` or send adaptive); `effort` low→max; forced `tool_choice` is a 400; needs 30-day data retention (ZDR orgs get a 400) |

Implications:
- The input-price spread is only 4×, so **effort level and output/thinking tokens matter as much as model choice**. The router picks *model + effort*, not just model.
- Models accept different parameters. Switching model means **translating the request** (thinking config, effort, `tool_choice`), or the upstream returns 400s.
- Prompt caches are per model. Switching models mid-conversation throws away the cache, so routing is **sticky per conversation** by default.
- A simpler alternative to any cascade is "Opus at low effort". The eval must include it as a baseline.

## 3. Architecture

```
client ──► jev-gateway (:8787) ──► Anthropic API
             │  pipeline per request:
             │  1. identify conversation (hash of system + first user turn)
             │  2. semantic cache lookup ───────────► Jev (equivalence?)
             │  3. route: pick model+effort ────────► Jev (choice)
             │  4. trim tools ──────────────────────► Jev (noul per tool)
             │  5. translate params for chosen model
             │  6. call upstream (stream passthrough)
             │  7. cascade check (if enabled) ──────► Jev (answer adequate?)
             │  8. log to SQLite → dashboard
```

- **Runtime**: Bun + TypeScript, Hono for HTTP, `bun:sqlite` for storage.
- **Upstream calls**: official `@anthropic-ai/sdk`, one client per request built from the caller's `x-api-key`; `anthropic-beta` headers forwarded as `betas`; streamed events re-emitted as SSE unchanged.
- **Jev calls**: `@typesafe-ai/sdk`'s `TypeSafeClient`, created by `createJevClient({ mode })`. `mock` mode swaps in a local fetch that returns schema-valid answers (the default in dev and tests). OpenRouter can be added later via the SDK's `baseURL` if needed.
- **Control headers** (request): `x-gateway-mode: off|route|full`, `x-jev-key: …` (BYO Jev key). Only requests with `model: "auto"` (or a configured alias) are rerouted; an explicit model is passed through untouched, though other layers can still apply.
- **Response headers**: `x-gateway-model`, `x-gateway-decision-id`, `x-gateway-cache: hit|miss`.
- **Safety**: Jev timeout (default 800 ms) → fail open. Jev spend tracked per call; over `JEV_BUDGET_USD` → all layers bypassed and the dashboard shows a warning.

### Proposed layout
```
src/
  server.ts            Hono app, pipeline wiring
  pipeline/            conversation-id, cache, router, tools, cascade
  upstream/            anthropic forwarder, SSE passthrough, param translation
  jev/                 JevClient interface, native/openrouter/mock impls, state builders
  store/               SQLite schema + queries
  pricing.ts           model price table, cost + counterfactual cost
  dashboard/           static HTML/JS served at /dashboard
test/                  bun test; fake upstream server; Jev fixtures
eval/                  prompt set, runner, grader, report
```

## 4. Phases

Each phase ends with a working, committed, demoable state. I check in with you at the end of each phase.

### Phase 0 — Groundwork and API verification
- Scaffold Bun/TS project, lint, `bun test`, `.env.example`.
- Make **one real Jev call** (~$0.00002) to confirm endpoint, auth, request/response shape, how tokens are counted (do question tokens count once per request or per question?), and real latency. Record it as the first mock fixture.
- Write the `JevClient` interface and the mock implementation.
- **Done when:** the real call's response is checked into `fixtures/`, and the mock replays it in a test.
- **Cost:** < $0.001 Jev.

### Phase 1 — Pass-through proxy
- `POST /v1/messages` forwards to Anthropic unchanged, streaming and non-streaming. Also `count_tokens`.
- Logs every request: model, usage (input/output/cache tokens), latency, cost.
- **Done when:** Claude Code and the Anthropic SDK both work through the proxy with `ANTHROPIC_BASE_URL`, and tests pass against a fake upstream.
- **Cost:** $0. Verified against a fake upstream. A live check against the real API waits until there's API credit (Max plan doesn't include any).

### Phase 2 — Router
- **State builder**: compress a request into a Jev state under 32k tokens: system-prompt excerpt, last user turn, tool names, turn count, estimated input size, whether images or documents are attached.
- One Jev **choice** over tiers: `haiku`, `sonnet-low`, `sonnet-high`, `opus-low`, `opus-medium`, `opus-high`, `fable-high`. Each tier gets a written description of when it applies (tunable in config). Fable is reserved for the hardest requests and can be disabled in config.
- On Sonnet 5.5 / Opus 5.5 / Fable 5.1, the gateway adds Anthropic's server-side refusal fallback (`fallbacks: "default"`) unless the client set its own.
- If confidence is below a threshold, use the configured default tier.
- **Param translation**: e.g. strip `effort` and convert `thinking` for Haiku; drop a forced `tool_choice` for Sonnet/Opus 5.5 (it's a 400 there).
- **Sticky routing**: a conversation keeps its first routed model unless the router picks a higher tier. Models only ever escalate.
- **Done when:** `model: "auto"` requests are routed, every routing decision and its probabilities are logged, and a param-translation test matrix covers each model.

### Phase 3 — Dashboard
- `/dashboard`: total spend vs counterfactual ("if everything went to the baseline model"), savings over time, model/effort mix, Jev latency overhead p50/p95, Jev spend vs budget, and a request table you can open to see each Jev decision.
- The counterfactual is labelled as an *estimate* (same token counts priced at the baseline model); real numbers come from Phase 7.
- **Done when:** the dashboard renders with real proxied traffic and in mock mode.

### Phase 4 — Cascade
- **Off by default.** Turned on per request with `x-gateway-cascade: on`, or globally in config.
- When on, try the cheapest acceptable tier first. Jev **noul**: "this response fully and correctly answers the request". Below the threshold → re-run one tier up.
- Streaming: the cheap attempt is buffered, then replayed as SSE if accepted. Expect higher time-to-first-token; it can be turned off per request.
- Wasted cheap attempts count against savings on the dashboard.
- **Done when:** escalation rate, wasted spend and net savings show on the dashboard.

### Phase 5 — Tool trimming
- Requests with ≥ N tools (default 15): one Jev request with a **noul** per tool ("tool X may be needed for the latest turn"). Keep tools above the threshold, plus pinned tools, tools already used in the conversation, and any tool named in `tool_choice`.
- **Monotonic per conversation**: the kept set only grows, so the prompt-cache prefix changes rarely.
- **Done when:** tokens saved per request show on the dashboard, and a test confirms that a tool the model calls is never one that was trimmed.

### Phase 6 — Semantic cache
- Scope: requests with no tools and a single user turn (plus the system prompt), without `temperature > 0`.
- Embed locally (transformers.js, MiniLM). Look up the top-k candidates by cosine similarity, then ask Jev the **noul** "the cached answer to A correctly answers B". A hit returns the stored message, synthesized as SSE when the client asked for streaming.
- Cache key is scoped by system-prompt hash and model tier. TTL is configurable.
- **Done when:** hit rate and dollars saved show on the dashboard, and a known-paraphrase test set hits while known-different questions miss.

### Phase 7 — Evaluation and write-up
- About 40 prompts spanning easy chat, coding and reasoning. Four configs: always Opus medium (default), always Opus low, router, router + cascade. Opus grades each answer against the always-Opus-medium answer.
- **Runs on the Max plan, not the API.** Jev picks the tier for each prompt (same router code as Phase 2), then the prompt runs with `claude -p --model <model> --effort <level> --output-format json`. The JSON result reports token usage and what the call would have cost on the API, which gives the cost per config. Cascade is replayed the same way: Haiku first, Jev judges, escalate if needed.
- This measures **routing quality and API-equivalent cost**, not the proxy itself. Claude Code's own system prompt is included in every call, which inflates input tokens equally across configs.
- Report: API-equivalent cost per config, quality win/tie/loss, latency. The README headline uses these numbers.
- Jev cost: ~$0.01. Claude cost: $0 on the plan, though it counts toward Max usage limits.
- **Done when:** the eval report is committed, the README is finished, and v0.1 is tagged.

## 5. Testing
- Unit tests: state builders, param translation matrix, pricing, sticky routing, monotonic tool sets.
- Integration tests: a fake Anthropic upstream (records requests, returns canned SSE) plus mock Jev. No network in `bun test`.
- Real-API smoke tests only behind `LIVE=1`.

## 6. Risks
| Risk | Mitigation |
|---|---|
| Jev API shape differs from public write-ups | Phase 0 verifies before anything is built on it |
| Jev routes badly (vendor accuracy is only 67.8% on their benchmark) | Confidence threshold → safe default; Phase 7 measures it |
| Param translation misses a case → upstream 400 | Test matrix per model; on 400, retry once on the originally requested model |
| Switching models or tool sets invalidates prompt cache | Sticky routing, monotonic tool sets; dashboard shows cache-read tokens |
| Editing history breaks preserved-thinking checks on Opus/Sonnet 5.5 | Gateway never edits prior turns, only the model, params and tools of the current request |
| Cascade adds latency | Off by default for streaming; per-request toggle |
| Counterfactual savings look better than reality | Labelled as an estimate; Phase 7 provides measured numbers |

## 7. Decisions
- Name: `jev-gateway`.
- Runtime: Bun + Hono.
- Budget: $4 of **Jev** credit; `JEV_BUDGET_USD` defaults to $1 so a bug can't drain it.
- Claude access is a Max subscription, which doesn't include API credit. Development uses a fake upstream; the Phase 7 eval runs through `claude -p`. A live end-to-end proxy test waits for API credit.
- Fable 5.1 is the top routing tier.
- Cascade is off by default and opt-in per request. Phase 7 decides whether to turn it on for non-streaming requests.
