# CLAUDE.md — MUST READ BEFORE EDITING THIS REPO

Project: **aistock** — Next.js 15 + Neon Postgres (HTTP driver) + AI SDK v6 + MCP, deployed on Vercel Hobby. Single-user platform with guest accounts.

This doc is the compressed scar tissue from a multi-hour debug saga. Read it once. Every landmine here has been stepped on; the fix is what you should do, the cause is why you'd otherwise re-step on it.

---

## 0. The single most important rule

**`vercel.json` cron jobs MUST run AT MOST ONCE PER DAY on Hobby plan.** Anything finer (`*/5 * * * *`, `0 * * * *`, etc.) causes Vercel to **silently reject every build** — no error, no failed deploy entry, just the prior bundle keeps serving. We lost ~6 hours and 17 phantom-fix commits to this. Current schedule is `0 1 * * *` (daily 01:00 UTC); for finer cadence use an external cron (cron-job.org) hitting `/api/cron/tick` with `Authorization: Bearer $CRON_SECRET`.

---

## 1. Before pushing, ALWAYS run

```bash
cd apps/web
rm -rf .next
npm run build          # catches every webpack / TS error Vercel will hit
```

If the local build is clean, the Vercel build will be too — UNLESS you touched `vercel.json` (then see rule 0).

**Even better**: deploy to a preview URL first with the Vercel CLI:
```bash
vercel              # preview deploy (own URL, doesn't affect prod)
vercel --prod       # production
vercel --prod --force  # skip Vercel's build cache (rarely needed)
```

The CLI surfaces real errors immediately. The dashboard "Ready" status can lie for 13+ hours.

---

## 2. Stack landmines (every one has bitten us)

### 2.1 Neon HTTP driver (`drizzle-orm/neon-http`)

- **No transactions.** `db.transaction(callback)` THROWS. Refactor to sequential `db.execute(...)` calls. Existing transaction-free sites: `getDefaultPortfolioId`, `register`, `ensure-schema/runDDL`, `models.writeCache`.
- **Numeric columns roundtrip as STRINGS.** `numeric(N,M)` and `bigint` come back as `"1.50"` not `1.5`. Calling `.toFixed()` on them throws `TypeError: $.close.toFixed is not a function` and Next renders the generic Vercel error page. **Coerce at the network boundary** via `Number(x)` (and `Number.isFinite()` guards). Already done for: portfolio prices, routines responses, admin USD caps, db-snapshot, getEvents/Fundamentals/etc. Watch for new endpoints reading numeric.
- **Requires the Neon POOLER URL** (`-pooler.neon.tech` in the hostname). Direct compute endpoint returns opaque 5xx. `lib/db/client.ts` warns on mismatch.

### 2.2 Vercel Node 20+ unhandled-rejection kill

`void someAsyncCall()` is a TIME BOMB. If the promise rejects, Node 20+'s default `--unhandled-rejections=throw` KILLS the function, and Vercel returns `Content-Length: 0` (no body). Looks like a generic 500 with no diagnostic.

**Always use `someAsyncCall().catch(() => undefined)`** for fire-and-forget. The `.catch` attaches a handler, marking the promise as handled even when rejected. Sites already fixed: `recordAttemptAudit`, `persistAssistant` in chat/route.ts. Watch every new fire-and-forget.

### 2.3 Webpack production circular-dependency TDZ

If `mcp/tools/index.ts` (the barrel) and `lib/scheduler/run.ts` (which used to static-import `TOOLS` from the barrel) form a cycle through `createRoutine.ts`, webpack's production minifier hoists references such that `createRoutine`'s binding is read while its module is mid-init. Result: `ReferenceError: Cannot access 'm' before initialization at Module.createRoutine`. Dev mode loose evaluation hides it.

**Rule:** any tool that imports `@/lib/scheduler` MUST do it as a dynamic `await import('@/lib/scheduler')` inside its `execute()`, NEVER at module top. Similarly, `lib/scheduler/run.ts` lazy-imports `'../mcp/tools'` inside `runRoutineOnce`. Both halves of the cycle must be lazy.

### 2.4 ES2025 import-attributes silently drop Vercel route bundles

`import('./models.json', { with: { type: 'json' } })` — the new attribute syntax — was making Vercel's bundler silently keep the prior route bundle. Just use plain `import('./models.json')`.

### 2.5 `output: 'standalone'` in next.config.ts breaks Vercel route updates

`output: 'standalone'` is for Docker/self-hosted Node. On Vercel it can prevent per-route bundle updates. Removed. Don't re-add unless you actually self-host.

### 2.6 `instrumentation.ts` can't import the scheduler

Importing `./lib/scheduler` from instrumentation drags webpack into `yahoo-finance2 → @deno/shim-deno → require('tty')` and fails. The in-process scheduler boot is REMOVED for this reason; Vercel uses `/api/cron/tick`. If you need local-dev cron, run an external poller.

### 2.7 `vercel.live` feedback widget violates CSP

Vercel preview adds `https://vercel.live/feedback.js` to every page. Our CSP includes it only when `process.env.VERCEL` is set. Don't tighten the CSP without re-checking this.

### 2.8 Edge runtime requires `node:crypto` → `crypto.subtle` refactor

`/api/auth/me` and `/api/auth/login` are Edge. `lib/auth/session.ts` uses Web Crypto. Any caller that needs Node-only crypto must stay on `runtime = 'nodejs'`.

### 2.9 bcryptjs cost 10 (not 12)

12 was ~500ms per login compare on Vercel cold start. Lowered to 10 (~120ms). Existing higher-cost hashes still verify because cost is encoded in the hash string.

### 2.10 Browser cache + new Vercel deploy

A successful deploy doesn't reach users until they hard-refresh. Bundle hashes change but Service Workers / disk cache hold the old JS. `Ctrl+Shift+R` (Cmd+Shift+R on Mac) clears it. Every "still broken after deploy" report should start with this.

---

## 3. Repo layout for AI navigation

```
apps/web/
  app/
    api/
      auth/              # login, register, register-guest, me (edge), logout
      chat/route.ts      # MAIN chat handler — TDZ-sensitive, see §2.3
      chats/             # chat history + summarize
      portfolio/         # CRUD; ownership-gated via portfolios.user_id JOIN
      routines/          # cron routines; user_id required on all
      cron/tick/         # Vercel Cron entrypoint, Bearer-gated
      keys/              # API key vault (envelope-encrypted)
      stocks/[id]/db-snapshot/  # admin diagnostic
      account/request-cap/      # user→admin cap-increase requests
      admin/             # admin-only (users, cap-requests)
      export/            # JS-only DOCX + HTML (no pandoc on Vercel)
    portfolio/           # portfolio page + per-row chart
    research/, analysis/, settings/, routines/, admin/users/, register/, login/
    error.tsx, global-error.tsx  # global error boundaries
    icon.svg
    layout.tsx
  components/
    chat/                # NEW: thinking-card + answer-card (collapsed answer)
    error-boundary.tsx, error-listener.tsx
    cap-request-button.tsx
    settings/, portfolio/
  lib/
    db/
      client.ts          # Neon HTTP driver, pooler warning
      schema.ts          # Drizzle definitions
      ensure-schema.ts   # 90+ idempotent bumps, self-heals on first request
      migrate.ts         # CLI variant
    auth/
      session.ts         # Web Crypto HMAC, JWT-fast-path getCurrentUser
      effective-user.ts  # admin lookup for guest key inheritance
      guest-cleanup.ts
    crypto/keyProvider.ts  # MASTER_KEY env (cloud) or DPAPI (Windows dev only)
    llm/
      providers.ts, models.ts, keys.ts, clientFor.ts (lazy-imports providers)
      models.json        # static registry — keep IDs REAL (no placeholders)
    mcp/
      types.ts           # ToolCtx { userId, stockIdHint, provenance }
      tools/
        index.ts         # barrel — DO NOT static-import this from scheduler
        lazy.ts          # getToolsByNames(names) — chat route uses this
        *.ts             # one handler per tool; all call assertOwnsStock
      ownership.ts       # JOIN through portfolios → user check
      adapters/aiSdk.ts, adapters/mcp.ts
    scheduler/
      index.ts, run.ts (runRoutineOnce, runDueRoutines), runner.ts, catchup.ts
    rag/retriever.ts     # pg_search DISABLED on Neon (no extension); dense-only
    export/docx.ts, html.ts, sanitize.ts  # JS-only, pandoc REMOVED
    market/, news/, cost/, security/, push/
  scripts/smoke-test.mjs # 15-check prod smoke test
  vercel.json            # cron 1/day (Hobby limit)
  next.config.ts         # no `output:'standalone'` on Vercel
  middleware.ts          # auth gate + rate limit + setup-bearer
  instrumentation.ts     # ensureSchema kickoff only (scheduler removed)
```

---

## 4. Required env vars on Vercel

| Name | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Must be Neon **pooler** URL (`-pooler.neon.tech`) |
| `MASTER_KEY` | yes | `openssl rand -base64 32`. NEVER change — rotating invalidates every stored API key |
| `SESSION_SECRET` | optional | Same format. Falls back to MASTER_KEY |
| `CRON_SECRET` | yes for cron | Any random string. Vercel auto-injects in cron Bearer header |
| `OPENAI_API_KEY` etc. | optional | Admin-only fallback when no per-user vault row exists |
| `TAVILY_API_KEY` | optional | News fallback; users can save their own in Settings |
| `VAPID_*` | optional | Web push (degrades silently if missing) |
| `PROVIDER_DAILY_USD_CAP` | optional | Global per-provider daily $ ceiling for the budget ledger (admins bypass). Default $50. Set to `0` or `disabled` to turn off. |
| `PROVIDER_DAILY_USD_CAP_<PROVIDER>` | optional | Per-provider override of the above. e.g. `PROVIDER_DAILY_USD_CAP_MISTRAL=20`. Provider name uppercased. |

---

## 5. Editing checklist (run before EVERY commit)

```bash
# 1. typecheck must be clean
npm run -w apps/web typecheck

# 2. clean build must succeed (catches webpack errors local dev hides)
cd apps/web && rm -rf .next && npm run build && cd ../..

# 3. (optional but high signal) preview deploy
vercel              # preview
# ... test the preview URL ...
vercel --prod       # promote
```

If you skip step 2 you WILL eventually push a circular-dep / numeric-coercion / `tool-name-tdz` bug that only shows up in webpack production builds.

---

## 6. When something breaks on prod

1. **Look at Vercel deploy log first.** Browser errors are downstream noise. Open `https://vercel.com/yanapakapols-projects/aistock-web-j1cz/deployments` → top entry → "Build" tab if it's red; "Functions" tab if it's green-but-broken.
2. **Look at the chunk hash in the browser error stack.** If it matches a chunk from a known-stale deploy, the user just needs a hard refresh. If it matches the latest deploy, it's a real bug.
3. **Run the smoke test:** `node apps/web/scripts/smoke-test.mjs` — hits 15 endpoints, 6 seconds, 0 deps. Pass/fail tells you the surface state of prod.
4. **Check the trace endpoint** the chat route has at the top: `POST /api/chat?trace=1` with any cookie returns `{ok:true, trace:"v10-..."}` if the latest chat bundle is live.

---

## 7. Adding a new MCP tool

1. New file under `lib/mcp/tools/` named `<verb><Subject>.ts`.
2. Export a `ToolHandler<Input, Output>` named `<verbSubject>` (camelCase matching filename).
3. Register in `lib/mcp/tools/index.ts` (the barrel) AND `lib/mcp/tools/lazy.ts` (the loader registry).
4. **In `execute(input, ctx)` first call `assertOwnsStock(input.stock_id, ctx)`** if stock-scoped.
5. **DO NOT static-import `@/lib/scheduler`** from the tool — dynamic `await import` only.
6. Add to `RESEARCH_TOOL_ALLOW` in `app/api/chat/route.ts` if research tab should use it.
7. `npm run build` and verify chat still loads.

---

## 8. Adding a new API route

1. Always `runtime = 'nodejs'` unless you've verified every transitive import is edge-compatible.
2. First lines must be `const me = await getCurrentUser(); if (!me) return NextResponse.json({error:'unauthorized'}, {status:401});` UNLESS the route is explicitly auth-free (then add it to `middleware.ts` AUTH_FREE_PATHS).
3. For stock-scoped data: call `getStockById(id, me.id)` from `lib/portfolio/queries` — returns null if not owned. NEVER `db.select().from(stocks).where(eq(stocks.id, id))` without the ownership join.
4. For numeric columns in the response: coerce with `Number(x)` before returning JSON.
5. For fire-and-forget calls: `.catch(() => undefined)` not `void`.
6. For mutating routes: check `Sec-Fetch-Site` header.

---

## 9. Database changes

1. Edit `lib/db/schema.ts` (Drizzle definitions).
2. Add idempotent ALTER/CREATE to `lib/db/ensure-schema.ts` (runs at first request).
3. Mirror in `lib/db/migrate.ts` (CLI variant).
4. **`ensure-schema.ts` runs in the background** via `ensureSchema()` which returns immediately; bumps happen on next tick. Don't `await ensureSchemaSync()` in a hot path.
5. FK ADD CONSTRAINT has no `IF NOT EXISTS` — wrap in `tryStmt` so re-runs are no-ops.

---

## 10. Tooling that saves your sanity

```bash
# Vercel CLI (do install this — every "I don't know why it's broken" debug is faster with it)
npm i -g vercel
cd apps/web && vercel link

# Deploy
vercel              # preview
vercel --prod       # prod (catches real errors that dashboard hides)
vercel --prod --force  # skip build cache

# Inspect
vercel ls
vercel inspect <url>
vercel logs <url> --follow

# Env
vercel env pull             # syncs prod env to .env.local
vercel env add NAME production
vercel env rm NAME production
```

The single tool that would have saved 6 hours of phantom debugging: `vercel --prod` from your local CLI. It surfaces the real error (cron-limit rejection, build failure, etc.) immediately instead of letting Vercel silently keep serving the prior bundle.

---

## 11. The smoke-test script is your friend

```bash
node apps/web/scripts/smoke-test.mjs
```

Runs 15 checks against prod (`https://aistock-web-j1cz.vercel.app`) in ~6 seconds. After every deploy, run this. If any check fails, that's your repro.

---

## 12. The post-mortem narrative is in `docs/POSTMORTEM.md`

If you want the full story of how this codebase got into the state it's in, read that. This doc is the cliff-notes for not making the same mistakes.
