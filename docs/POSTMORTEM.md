# Post-mortem: the 18-commit debug saga (May 24-25, 2026)

A narrative account of the longest debug session this project has had — written so the next maintainer (human OR AI) knows the shape of the trap and doesn't fall in.

**TL;DR:** A single misconfigured cron schedule in `vercel.json` silently blocked every deployment for ~13 hours. Every "fix" I pushed during that window never reached prod, which made me misdiagnose phantom bugs and write 17 more fixes that also didn't deploy. The actual fix took 30 seconds once we saw the real error message via `vercel --prod` from the CLI.

---

## What the user experienced

1. **Chat in both Research and Analysis tabs returned an empty 500.** No body, no error message, no clue. Browser showed `POST /api/chat 500`.
2. **Portfolio page crashed with `TypeError: $.close.toFixed is not a function`** — the generic "Application error" Vercel page.
3. **Login / settings / model picker had various rough edges** that all seemed independent.

Each fix I wrote was correct. None of them reached production. From the user's perspective, every "I fixed it!" was followed by "still broken."

---

## The actual root cause

In commit `cf3fb71` (the "Cloud-only deploy" commit that made the platform PC-off-capable), I added `apps/web/vercel.json`:

```json
{
  "crons": [
    { "path": "/api/cron/tick", "schedule": "*/5 * * * *" }
  ]
}
```

Vercel Hobby plan rejects any cron that runs more than once per day. This rejection happens during build validation, BEFORE the actual build starts. Vercel:

- Reports the deployment as failed in the dashboard (but the user wasn't checking failed deploys, only the "Ready" filter)
- Returns 200 OK to the GitHub webhook (so GitHub thinks delivery succeeded)
- Keeps serving the PRIOR successful bundle (so the production URL still responds, just with old code)

**Net effect: every push between `cf3fb71` and `4342572` (the fix) silently failed to deploy. 17 commits of real fixes never reached prod.**

---

## Why it took so long to find

### 1. The dashboard "Ready" status filter hid the failures

The user's deployment dashboard URL had `?status=ready,...` filtering — failed deploys weren't visible by default. I asked the user to check the deployment list multiple times; they kept seeing the same green-checkmark list and reporting "no failures." The failed deploys were there, just filtered out.

### 2. The webhook returned 200, suggesting it worked

GitHub webhook delivery to `https://api.vercel.com/v1/integrations/deploy/prj_.../...` returned 200 OK on every push. That looks healthy. Vercel returns 200 once the request is queued, not once the build succeeds. The cron-limit rejection happens AFTER queueing, asynchronously, and isn't surfaced anywhere webhook-callers can see.

### 3. I had no Vercel CLI access myself

I'm a model running in someone else's terminal. I can `curl` prod but I can't `vercel logs` or `vercel inspect` from my side. Without dashboard access either, I was effectively debugging blind. Every test I ran was against the OLD bundle that was actually live, so my "fixes" appeared to never take effect — which led me to write more "fixes" for the same illusory problem.

### 4. The real bugs in the code were also real

Several genuine bugs DID exist:

- **TDZ in `createRoutine.ts`** caused by a circular import through `scheduler/run.ts ↔ mcp/tools/index.ts`. Webpack production minifier triggered it; dev mode hid it.
- **Numeric coercion** — `neon-http` returns `numeric(N,M)` as strings. `last.close.toFixed(2)` threw. Portfolio page rendered the Vercel error page.
- **Unhandled promise rejections** from `void recordAttemptAudit(...)` patterns. Node 20+ default `--unhandled-rejections=throw` kills the function → Vercel empty-body 500.
- **ES2025 import attributes** (`import('x.json', { with: { type: 'json' } })`) silently break Vercel route bundles.
- **`output: 'standalone'`** in `next.config.ts` was inherited from a Docker config and interferes with Vercel's per-route bundle updates.
- **bcrypt cost 12** added 500ms per login.
- **6 of 6 LLM provider SDKs were eagerly imported** in `clientFor.ts`, adding 1-2s to every cold start.

Each of these was a real bug, with a real fix. I shipped all of them. None reached prod because of the cron-config rejection. So when the user kept reporting "still broken," I assumed my fixes were wrong and wrote more variants — chasing a moving target that wasn't actually moving.

### 5. The single trick that broke the loop

Eventually the user installed Vercel CLI (`npm i -g vercel`) and ran `vercel --prod` directly. The CLI surfaced the build error immediately:

```
Error: Hobby accounts are limited to daily cron jobs. 
This cron expression (*/5 * * * *) would run more than once per day.
```

30 seconds later that one config line was fixed and all 17 stuck commits cascaded into production.

---

## Lessons learned

### For future maintainers

1. **The dashboard `Ready` filter lies.** Always change the filter to include `Error` / `Canceled` / `Initializing` and check the full deployment history when something seems stuck.

2. **The GitHub webhook returning 200 ≠ "deploy succeeded."** It just means Vercel queued the trigger. Use the Vercel CLI to confirm.

3. **`vercel --prod` from the local CLI is the single source of truth.** It surfaces real errors that the dashboard, webhook, and prod traffic all hide. Make it the first diagnostic on any "why isn't this working" issue.

4. **Stay inside Vercel Hobby plan limits explicitly.**
   - Cron jobs: max 1 per day. For finer cadence, use external cron services (cron-job.org is free) hitting `/api/cron/tick` with the `CRON_SECRET` bearer.
   - Function timeout: 60s on Hobby (not the 300s the code declares; Hobby caps the declaration silently).

5. **`output: 'standalone'` is a Docker artifact.** Never add it for Vercel deploys.

6. **Test prod builds locally.** Many of the bugs (TDZ, `tty` resolution failure, numeric coercion under HTTP driver) only show in `next build`, not `next dev`. Run `rm -rf .next && npm run build` before any push that touches webpack-relevant files.

### For Claude (or any AI agent)

1. **If you find yourself writing 3+ "fixes" for the same symptom, stop and verify your fix is deployed.** The illusion of a moving target is usually a deployment problem, not a code problem.

2. **Don't trust browser errors as the source of truth.** A `chunks/page-XXX.js` hash in a stack trace identifies WHICH bundle is running. If the user's hash doesn't change after a push, the deploy failed.

3. **When debugging Vercel, get the actual deploy log first.** Use the GitHub webhook payload, deploy URL, or CLI — not surface symptoms.

4. **Cascade-fail patterns are common.** A single config error (cron limit) caused 17 commits of phantom debugging. Always check the highest-leverage layer (platform config) before assuming the application code is broken.

5. **`Content-Length: 0` on a 500 response is a hallmark of Node process-kill.** That means `--unhandled-rejections=throw` killed the function. Audit every `void asyncCall()` and replace with `.catch(() => undefined)`.

---

## Sequence of events (timeline)

| Time | Commit | What I thought | What was actually happening |
|---|---|---|---|
| T+0h | `cf3fb71` | "Migrating to cloud-only deploy" | Added `vercel.json` cron `*/5 * * * *`. **All future deploys silently rejected from this point.** |
| T+1h | `ea0f087` | "Portfolio fix + chat UI redesign + error boundaries shipped" | Pushed, never deployed |
| T+2h | `b013e23` | "TDZ fix landed" | Pushed, never deployed. User still sees TDZ from old bundle. |
| T+2.5h | `ef75a23` | "Bulletproof catch — never empty 500 again" | Pushed, never deployed. User still sees empty 500. |
| T+3h | `6d7e53e`, `a9255e5`, `ddc2b65`, `d3985b7`, `0626726`, `abf1273`, `c6b8d5b`, `d82f9db`, `6b8bb7a`, `cea1813`, `a89b012`, `f9c8ab6`, `6b730ca` | (13 separate fixes for what I thought were 13 separate bugs) | Each pushed, none deployed |
| T+5h | User checked Vercel dashboard and shared screenshots; "Last deploy 13h ago" was visible | Realized auto-deploy was broken | Diagnosed missing webhook (red herring; webhook was working) |
| T+5.5h | User added the GitHub webhook | New pushes still didn't trigger builds | (Webhook fired, Vercel rejected silently) |
| T+6h | User installed Vercel CLI and ran `vercel --prod` | CLI surfaced the cron error in plain text | Real diagnosis — 30 seconds |
| T+6h+1min | `4342572` | Cron changed to `0 1 * * *` (daily) | Build finally attempted on Vercel |
| T+6h+5min | `858fe2a` | Fixed a secondary `instrumentation.ts → yahoo-finance2 → tty` webpack error revealed by the build | Build succeeded — all 18 stuck commits cascade-deploy to prod |

Total wall-clock: ~6 hours, almost all of which was debugging a problem that didn't exist in the application code.

---

## What's now in place to prevent recurrence

- **`CLAUDE.md` at the repo root** with every landmine cataloged and the required pre-push checklist. Any AI agent reading this repo will see it first.
- **`docs/POSTMORTEM.md`** (this file) for the narrative.
- **`README.md`** has a "MUST READ" banner at the top pointing to both.
- **`apps/web/vercel.json`** has a comment-free `0 1 * * *` schedule (Hobby-compatible) — if you change it, the comment in `CLAUDE.md` §0 warns you why.
- **`apps/web/scripts/smoke-test.mjs`** runs 15 checks in 6 seconds. Run after every deploy.
- **Trace endpoint at `POST /api/chat?trace=1`** — if it doesn't echo the current build stamp, your deploy is stale.

---

## Closing note

This was a frustrating session — for the user most of all. The lesson isn't "Vercel Hobby is bad" or "the code is fragile." The lesson is **observability over speed**. If we had spent the first 15 minutes confirming what was actually deployed (instead of trusting the dashboard and GitHub's 200 webhook responses), the next 5 hours would have been one 30-second fix.

For the next maintainer reading this: when something seems impossible to debug, the assumption "my code is wrong" is the trap. Verify what's actually running before you change anything.

— Authored after we finally got chat responding from prod, 2026-05-25.
