# jev-gateway

A local proxy for the Claude Messages API that uses [TypeSafe Jev](https://typesafe.ai) — a fast, cheap model that returns typed decisions instead of text — to cut what Claude costs you. Point any Claude client at it and it can:

- **Route** `model: "auto"` requests to the cheapest model + effort that should handle them (Haiku → Sonnet → Opus → Fable).
- **Retry cheap-first**: answer with Haiku, let Jev check the answer, and escalate only if it falls short.
- **Trim tools**: send only the tool definitions the current turn is likely to need.
- **Cache answers**: reuse an earlier answer when Jev confirms it also answers the new question.
- **Show the savings** on a local dashboard.

Every Jev decision costs about $0.00003 and 0.3–0.6 s. Every feature fails open: if Jev errors, times out or its budget runs out, the request goes through unchanged.

## Results

80 [MT-Bench](https://github.com/lm-sys/FastChat) questions (first turn only), answered several ways and judged by Claude Fable against the always-Opus answer. "Acceptable" = every claim correct, every instruction followed, nothing important missing. The router's tier descriptions were tuned on the first 40 questions; the other 40 were held out to check the tuning generalizes.

| Setup | Tuning set (40): acceptable | Saved | Held-out (40): acceptable (95% CI) | Saved | Held-out cost per acceptable answer |
|---|---|---|---|---|---|
| Always Opus 5.5, medium effort (reference) | 96% | — | 99% (97–100) | — | $0.025 |
| Always Opus 5.5, low effort | 93% | 22% | 95% (88–100) | 14% | $0.023 |
| Jev router, v0.1 tiers | 80% | 39% | 85% (74–96) | 49% | $0.015 |
| **Jev router, tuned tiers** | **93%** | **52%** | **88% (77–98)** | **50%** | **$0.014** |
| Tuned router + cheap-first retry | 75% | 64% | 68% (53–82) | 75% | $0.009 |

What this says:
- **The tuned router halves the cost.** On held-out questions it saved 50% at 88% acceptable, versus 99% for always-Opus; cost per acceptable answer fell from $0.025 to $0.014. The quality gap is real but the intervals overlap at this sample size.
- **Tuning came from narrowing the Haiku tier.** v0.1 sent 16 of 40 questions to Haiku and lost most of its quality there; the tuned descriptions send most questions to Sonnet at low effort (28–32 of 40), which stays around 90% acceptable at about 60% cheaper.
- **But most of the tuning gain was specific to the tuning set.** On the tuning set it lifted acceptable answers from 80% to 93%; on held-out questions only from 85% to 88% (v0.1 sent 14 of 40 to Haiku there), at about the same cost. Both routers save roughly half; the tuned one is slightly better, within noise.
- **Opus at low effort is the safe option**: 14–22% cheaper with no measurable quality loss.
- **Cheap-first retry should stay off, at any threshold.** Jev's "does this fully answer it?" check accepted Haiku's answer 91% of the time on held-out questions, including many the judge rated unacceptable. Re-scoring the saved answers at other pass thresholds (no new calls) doesn't fix it: Jev's pass probability separates acceptable from unacceptable Haiku answers only weakly (AUROC 0.70; scores sit between 0.8 and 0.97), so a threshold low enough to save money drops quality, and one high enough to keep quality costs more than the router alone, because rejected questions pay for Haiku and then the routed model.

  | Pass threshold (80 questions) | Acceptable | Cost per acceptable answer |
  |---|---|---|
  | Router alone | 90.0% | **$0.0151** |
  | 0.7 (default) | 71.2% | $0.0122 |
  | 0.8 | 76.2% | $0.0132 |
  | 0.85 | 81.2% | $0.0169 |
  | 0.9 | 91.2% | $0.0178 |
  | 0.95 | 90.0% | $0.0200 |

  0.9, the best threshold on the tuning set that keeps quality, was 6% more expensive per acceptable answer than the router alone on held-out questions. Thresholds below 0.7 couldn't be scored, since the eval only graded Haiku answers Jev passed.

Caveats: one run per question; MT-Bench is public and may be in the models' training data; answers came from `claude -p` (Claude Code print mode with a minimal system prompt), which measures the routing decisions, not the proxy itself; costs are API-equivalent list prices. Per-question results: `eval/runs/mt-bench/` (v0.1), `eval/runs/mt-bench-r2/` (tuned, tuning set), `eval/runs/mt-bench-heldout/` (tuned, held-out), `eval/runs/mt-bench-heldout-v01/` (v0.1, held-out); each has `summary.md` and `report.html`.

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

- Repeat runs (2–3 per question) to narrow the confidence intervals.
- Test end-to-end through the proxy against the real Anthropic API.

## License

MIT. MT-Bench questions in `eval/data/` are from lm-sys/FastChat under Apache-2.0 (see `eval/data/NOTICE.md`).
