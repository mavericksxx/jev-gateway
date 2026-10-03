# jev-gateway

A local proxy for the Claude Messages API that uses [TypeSafe Jev](https://typesafe.ai) — a fast, cheap model that returns typed decisions instead of text — to cut what Claude costs you. Point any Claude client at it and it can:

- **Route** `model: "auto"` requests to the cheapest model + effort that should handle them (Haiku → Sonnet → Opus → Fable).
- **Retry cheap-first**: answer with Haiku, let Jev check the answer, and escalate only if it falls short.
- **Trim tools**: send only the tool definitions the current turn is likely to need.
- **Cache answers**: reuse an earlier answer when Jev confirms it also answers the new question.
- **Show the savings** on a local dashboard.

Every Jev decision costs about $0.00003 and 0.3–0.6 s. Every feature fails open: if Jev errors, times out or its budget runs out, the request goes through unchanged.

## Results (v0.1)

40 [MT-Bench](https://github.com/lm-sys/FastChat) questions (5 per category, first turn only), answered four ways and judged by Claude Fable against the always-Opus answer. "Acceptable" = every claim correct, every instruction followed, nothing important missing.

| Setup | Acceptable (95% CI) | As good as Opus¹ | Answer cost | Saved | Cost per acceptable answer |
|---|---|---|---|---|---|
| Always Opus 5.5, medium effort (reference) | 94% (87–100) | — | $1.23 | — | $0.033 |
| Always Opus 5.5, low effort | 93% (84–100) | 0.50 | $0.95 | 22% | $0.026 |
| **Jev router** | 80% (67–93) | 0.26 | $0.75 | **39%** | **$0.023** |
| Jev router + cheap-first retry | 70% (56–84) | 0.18 | $0.56 | 54% | $0.020 |

¹ Mean side-by-side score vs the reference: 0.5 = as good on average, 0 = always worse.

What this says:
- **Routing to Sonnet works** (91% acceptable, 68% cheaper on the 11 questions it got). **Routing to Haiku is where quality is lost** (75% acceptable on 16 questions), mostly on reasoning, role-play and instruction-heavy writing.
- **Opus at low effort is the strong simple baseline**: 22% cheaper with no measurable quality loss.
- **Cheap-first retry is too lenient at its default threshold (0.7)**: Jev accepted Haiku's answer 75% of the time, including answers the judge rated unacceptable.

Caveats: one run per question, so the intervals overlap; MT-Bench is public and may be in the models' training data; answers came from `claude -p` (Claude Code print mode with a minimal system prompt), which measures the routing decisions, not the proxy itself; costs are API-equivalent list prices. Full per-question results: `eval/runs/mt-bench/` (`summary.md`, `report.html`).

## Quick start

Requires [Bun](https://bun.sh) 1.2+.

```bash
bun install
cp .env.example .env    # add TYPESAFE_API_KEY and set JEV_MODE=live to use real Jev
bun run start           # http://localhost:8787
```

Then point a client at it:

```bash
ANTHROPIC_BASE_URL=http://localhost:8787 your-claude-client
```

Send `"model": "auto"` to let Jev pick the model; any other model name is passed through unchanged. Your Anthropic key travels with each request and is never stored. The dashboard is at `http://localhost:8787/dashboard`; `bun run seed-demo demo.db` creates a database of synthetic traffic to explore it (`GATEWAY_DB=demo.db bun run start`).

With `JEV_MODE=mock` (the default) Jev's answers are simulated locally, so everything runs offline at no cost.

## Request headers

| Header | Effect |
|---|---|
| `x-gateway-mode: off` | Skip Jev routing (`auto` goes to the default tier) |
| `x-gateway-cascade: on\|off` | Cheap-first retry for this request |
| `x-gateway-trim-tools: on\|off` | Tool trimming for this request |
| `x-gateway-cache: on\|off` | Answer cache for this request |
| `x-jev-key: <key>` | Use your own Jev key for this request's decisions (not charged to the gateway's budget) |

Responses carry `x-gateway-tier`, `x-gateway-model`, `x-gateway-decision-id`, and, when used, `x-gateway-cascade`, `x-gateway-tools` and `x-gateway-cache-result`.

## Settings

All settings are environment variables; `.env.example` documents each one. The main ones:

| Variable | Default | |
|---|---|---|
| `JEV_MODE` | `mock` | `live` calls the real Jev API |
| `JEV_BUDGET_USD` | `1` | Spend cap for the gateway's own Jev calls (survives restarts) |
| `ROUTER_DEFAULT_TIER` | `opus-medium` | Used when Jev is unsure or unavailable |
| `ROUTER_MIN_CONFIDENCE` | `0.5` | Below this, use the default tier |
| `CASCADE_DEFAULT` / `CASCADE_MIN_PASS` | `off` / `0.7` | Cheap-first retry |
| `TRIM_TOOLS_DEFAULT` / `TRIM_TOOLS_MIN` | `off` / `15` | Tool trimming |
| `CACHE_DEFAULT` / `CACHE_MIN_MATCH` | `off` / `0.85` | Answer cache |
| `BASELINE_TIER` | `opus-medium` | What the dashboard compares savings against |
| `HOST` | `127.0.0.1` | The dashboard has no auth; keep it local |

The answer cache embeds questions locally with `Xenova/all-MiniLM-L6-v2` (8-bit, ~23 MB, downloaded on first use) and never shares answers across API keys.

## Development

```bash
bun test            # ~200 tests, no network
bun run typecheck
bun run lint
bun run eval        # the MT-Bench eval (uses `claude -p` and real Jev)
```

See [SPEC.md](SPEC.md) for the design and build phases.

## Next steps

- Tighten the Haiku tier description (route reasoning, role-play and instruction-heavy writing to Sonnet) and offer Opus-low as a tier the router prefers over Opus-medium.
- Raise the cheap-first threshold (try 0.9) and re-run the eval; saved answers make re-runs cheap.
- Test end-to-end through the proxy against the real Anthropic API.

## License

MIT. MT-Bench questions in `eval/data/` are from lm-sys/FastChat under Apache-2.0 (see `eval/data/NOTICE.md`).
