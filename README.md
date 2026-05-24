# aistock

A single-user, self-hosted, ChatGPT-style chat platform specialized for short/mid/long-term stock research and analysis. Combines **RAG** (pgvector + pg_search hybrid recall of dated news + research notes) with **MCP tool-calling** over a structured Postgres of prices, events, fundamentals, and future-event probabilities. Multi-market: SH, SZ, HKEX, KRX, TSE, SET, US, LSE, Xetra, Euronext.

Three tabs:

1. **Research** — AI builds a per-stock driver checklist, runs a research loop (news → dated events → price correlation), persists into the DB, summarizes on close.
2. **AI Analysis** — chat grounded in DB + live web search, with one-click bubble prompts ("main driver", "past upward triggers", "next earnings probability", "create morning routine").
3. **Routines** — TZ-aware scheduled prompts (GMT+7 default), same-day catch-up (capped N=3), cross-day skip, clean MD/DOCX/PDF export.

## Prerequisites

- **Node.js 22+**
- **Docker** (for Postgres 16 + pgvector + pg_search, and for the app image with Pandoc + Typst)
- **Pandoc + Typst** locally (optional — only needed if you run `apps/web` outside Docker and want export)

## Quickstart

```bash
docker compose -f docker/docker-compose.yml up
```

App at <http://localhost:3000> (bound to 127.0.0.1 by default).

1. Visit `/settings` and add at least one provider API key (OpenAI / Anthropic / Google / Mistral / Kimi / DeepSeek) plus a Tavily key for news.
2. Visit `/portfolio` and add a stock (try `NVDA`, `2330.TW`, `0700.HK`, `7203.T`, `PTT.BK`).
3. Open Research, Analysis, or Routines.

For first-run schema setup, run `npm run db:generate` then `npm run db:migrate` inside the container (or locally with `DATABASE_URL` set).

## Deploy

See [DEPLOY.md](./DEPLOY.md) for VPS deploy notes (Hetzner / Fly), Cloudflare Tunnel + Tailscale recipes, Docker secret KEK setup, and the public-binding shared-bearer flow.

## Plan

Full architecture and milestone plan: [`~/.claude/plans/notes-1-introduction-sprightly-cherny.md`](../../.claude/plans/notes-1-introduction-sprightly-cherny.md).

## Milestone status

| Milestone | Status | Notes |
|---|---|---|
| M1 — Foundation (Next.js + Postgres + Drizzle + KeyProvider + settings + model registry) | shipped | |
| M2 — Portfolio + market data (yahoo-finance2, daily ingest, chart) | shipped | |
| M3 — Research tab v1 (chat proxy, scrubber, budget, MCP, ToolHandler, Tavily, research loop) | shipped | |
| M4 — Analysis tab + RAG (pgvector hybrid, bubble registry, correlate_event_price, future events) | shipped | |
| M5 — Routines (croner singleton, catch-up N=3, run history, export pipeline) | shipped | |
| M6 — PWA + mobile polish (manifest, service worker, Web Push) | shipped | Push subscription persistence is a TODO — see `apps/web/app/api/push/subscribe/route.ts`. |
| M7 — Hardening + remote (shared-bearer cookie, CSP/CSRF, allowlist, audit, budget dashboard) | shipped | Public-binding setup flow at `/setup`; see DEPLOY.md. |

## Security posture (summary)

- No user auth. 100% key + data safety: LLM never sees keys; outbound is proxied through a server-side `secureFetch` allowlist.
- API keys are **envelope-encrypted** (per-record DEK, AES-256-GCM, AAD = `provider:kid:created_at`). KEK source: DPAPI on Windows dev, Docker secret in production, KMS optional.
- Default bind `127.0.0.1`. Public binding requires `SETUP_BEARER_HMAC_SECRET` and the `/setup` flow.
- Tool-result scrubber strips key-shaped tokens before they reach the LLM.
- CSP locked, CSRF enforced via `Sec-Fetch-Site` + cookie-bound origin check.
- No telemetry. No third-party error reporting.
