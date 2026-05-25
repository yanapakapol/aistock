# aistock

> # 🚨 MUST READ BEFORE EDITING — for humans AND AI agents
>
> - **AI agents / Claude sessions:** read [`CLAUDE.md`](./CLAUDE.md) **first, in full**, before any tool call. It catalogs every landmine that has cost real hours of debugging, with the exact fix for each. It is the working memory of this project.
> - **Humans onboarding to the codebase:** read [`docs/POSTMORTEM.md`](./docs/POSTMORTEM.md) for the narrative of how the codebase got into the state it's in (the 18-commit Vercel-deploy debug saga). Then `CLAUDE.md` for the rules.
> - **Cloud deploy steps:** see [`docs/CLOUD_DEPLOY.md`](./docs/CLOUD_DEPLOY.md).
>
> **Single most important rule:** Vercel Hobby allows AT MOST 1 cron run per day. If you change `apps/web/vercel.json` to anything finer (`*/5 * * * *`, etc.) **every single deploy will silently fail** until it's reverted. We lost 6 hours and 17 phantom-fix commits to this exact bug. See `CLAUDE.md §0`.

---

A single-user / multi-user platform for short / mid / long-term stock research and analysis. Combines **RAG** (pgvector hybrid recall of dated news + research notes) with **MCP tool-calling** over a structured Postgres of prices, events, fundamentals, and future-event probabilities. Multi-market: SH, SZ, HKEX, KRX, TSE, SET, US, LSE, Xetra, Euronext.

Three tabs:

1. **Research** — AI builds a per-stock driver checklist, runs a research loop (news → dated events → price correlation), persists into the DB, summarizes on close.
2. **AI Analysis** — chat grounded in DB + live web search, with one-click bubble prompts ("main driver", "past upward triggers", "next earnings probability", "create morning routine").
3. **Routines** — TZ-aware scheduled prompts (GMT+7 default), driven by Vercel Cron on prod and an external poller on self-host. Clean MD / DOCX / HTML (browser-PDF) exports.

## Quickstart (local dev)

```bash
docker compose -f docker/docker-compose.yml up -d db   # Postgres + pgvector
cp apps/web/.env.example apps/web/.env                  # set DATABASE_URL + MASTER_KEY
npm install
npm run dev                                              # http://localhost:3000
```

1. Visit `/register` — the first user becomes admin.
2. Visit `/settings` and add at least one provider API key (Mistral is the default — cheapest), plus Tavily for news.
3. Visit `/portfolio` and add a stock (try `NVDA`, `2330.TW`, `0700.HK`, `7203.T`, `PTT.BK`).
4. Open Research, Analysis, or Routines.

Schema self-heals on first request — no separate `db:migrate` step needed.

## Cloud deploy (Vercel + Neon)

See [`docs/CLOUD_DEPLOY.md`](./docs/CLOUD_DEPLOY.md) for the full env-var checklist and one-command setup. Short version:

```bash
# Once, from your machine
npm i -g vercel
cd apps/web && vercel link    # link to your aistock-web-j1cz project
vercel --prod                  # deploy
```

Required env vars on Vercel: `DATABASE_URL` (Neon pooler URL), `MASTER_KEY` (`openssl rand -base64 32`), `SESSION_SECRET` (optional, falls back to MASTER_KEY), `CRON_SECRET` (any random 32+ char string).

## After every prod deploy

```bash
node apps/web/scripts/smoke-test.mjs   # 15 checks, 6 seconds, exit 0 if healthy
```

If anything fails, the output tells you which endpoint and the response code.

## Architecture summary

- **Next.js 15 App Router** on Vercel Fluid Compute (Node 22)
- **Postgres** via `@neondatabase/serverless` HTTP driver — no transactions, returns numeric as strings (`CLAUDE.md §2.1`)
- **AI SDK v6** with first-party providers; lazy-imported per request (one cold-start cost reduced from 6 SDKs → 1)
- **MCP tool layer** with per-tool ownership checks via `assertOwnsStock(stockId, ctx)` joining `stocks → portfolios → users.id`
- **Envelope encryption** for API keys: per-record AES-256-GCM DEK wrapped by a KEK from `MASTER_KEY` env (cloud) or DPAPI (Windows dev)
- **Web Crypto** session HMAC (so `/api/auth/me` + `/api/auth/login` run on Edge for lower cold-start)
- **Per-user data isolation**: every stock-scoped query joins through `portfolios.user_id`. Each user gets their own `stocks` row even for the same `(symbol, exchange)`, with cascade delete.

## Security posture

- **Per-user auth.** First registered user is admin; subsequent users are `user` (own keys) or admin-created `guest` (inherits admin's keys, 7-day data TTL).
- **Envelope-encrypted API keys.** LLM never sees raw keys; outbound is proxied through a server-side `secureFetch` allowlist.
- **Per-user data isolation.** Every stock-scoped read/write joins through `portfolios.user_id`. Routines, chats, push subs all have `user_id` FK with CASCADE delete.
- **MCP tool ctx** carries `userId`; every stock-scoped tool calls `assertOwnsStock` before any read.
- **Tool-result scrubber** strips key-shaped tokens (Anthropic / OpenAI / Google patterns + high-entropy + trigger-word proximity) before they reach the LLM.
- **CSP** locked: `default-src 'self'`, `vercel.live` only on Vercel deploys. CSRF via `Sec-Fetch-Site` enforcement.
- **No telemetry.** No third-party error reporting.

## Where to find things

| What | Where |
|---|---|
| Critical landmines + safe-update rules | [`CLAUDE.md`](./CLAUDE.md) |
| Debug saga post-mortem | [`docs/POSTMORTEM.md`](./docs/POSTMORTEM.md) |
| Vercel deploy guide | [`docs/CLOUD_DEPLOY.md`](./docs/CLOUD_DEPLOY.md) |
| Schema (Drizzle) | `apps/web/lib/db/schema.ts` |
| Runtime schema self-heal | `apps/web/lib/db/ensure-schema.ts` |
| Chat route (the heart of the platform) | `apps/web/app/api/chat/route.ts` |
| MCP tool registry | `apps/web/lib/mcp/tools/index.ts` + `lazy.ts` |
| Per-tool ownership check | `apps/web/lib/mcp/ownership.ts` |
| Smoke test | `apps/web/scripts/smoke-test.mjs` |
| Original master plan | [`~/.claude/plans/notes-1-introduction-sprightly-cherny.md`](../../.claude/plans/notes-1-introduction-sprightly-cherny.md) |

## Milestone status

| Milestone | Status |
|---|---|
| M1 — Foundation (Next.js + Neon + Drizzle + KeyProvider + settings) | shipped |
| M2 — Portfolio + market data | shipped |
| M3 — Research tab v1 (chat, MCP tools, scrubber, budget, Tavily) | shipped |
| M4 — Analysis tab + RAG (pgvector dense; BM25 disabled on Neon) | shipped |
| M5 — Routines (Vercel Cron + runRoutineOnce, JS-only export) | shipped |
| M6 — PWA + mobile polish | shipped |
| M7 — Hardening + cloud deploy + smoke test + global error boundaries | shipped |
| M8 — Per-user data isolation + guest accounts + admin user mgmt + cap requests | shipped |
| M9 — Speed pass (Neon HTTP, lazy LLM SDKs, JWT-fast-path /me, Edge auth) | shipped |
| M10 — Chat UI redesign (thinking-card + collapsed answer + progress bar) | shipped |
