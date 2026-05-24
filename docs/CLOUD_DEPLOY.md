# Cloud Deploy (Vercel + Neon) — PC-off ready

Goal: keep the platform fully online when your PC is off. No VPS, no Tailscale,
no local Postgres. Just Vercel (app + cron) and Neon (Postgres).

For VPS / self-host instead, see [../DEPLOY.md](../DEPLOY.md).

---

## 1. One-command deploy on Vercel

1. Push the repo to GitHub. Already done: <https://github.com/yanapakapol/aistock>.
2. In the Vercel dashboard, **Add New → Project → Import** the GitHub repo.
   - Root directory: `apps/web` (this is a monorepo; the Next.js app lives there).
   - Framework preset: Next.js (auto-detected).
   - Build/output settings: leave defaults.
3. Set the env vars in section 2 **before** the first deploy (Vercel will build
   regardless, but the app will 500 until they are present).
4. Click Deploy. Every subsequent push to `main` auto-rebuilds.

---

## 2. Required env vars

Set in **Vercel → Project → Settings → Environment Variables** for the
`Production` (and `Preview` if you use preview deploys) environments. None of
these should ever carry the `NEXT_PUBLIC_` prefix.

| Var | What it is | How to get / generate |
|---|---|---|
| `DATABASE_URL` | Neon Postgres connection string. Free tier is fine. | Neon dashboard → your project → **Connection string** → copy the **pooled** URL (ends with `-pooler...neon.tech`). The app uses the Neon HTTP driver, so pooled is correct. |
| `MASTER_KEY` | Base64-encoded 32 random bytes. Used as the KEK that wraps per-record DEKs for stored API keys. | `openssl rand -base64 32` &nbsp;or&nbsp; `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. **Never rotate** once set — rotating invalidates every stored provider key. |
| `SESSION_SECRET` | Random base64 string used to sign session JWTs. | Same generator as `MASTER_KEY`. If unset, falls back to `MASTER_KEY` (still secure, just couples the two). |
| `CRON_SECRET` | Shared secret Vercel injects as `Authorization: Bearer …` when calling declared cron paths. Validated by `/api/cron/tick`. | Any high-entropy string >32 chars, e.g. `openssl rand -hex 32`. If unset, the cron route returns 503 — fails closed. |

---

## 3. Optional env vars (degrade gracefully if missing)

| Var | Effect when missing |
|---|---|
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Web push notifications are silently disabled. Everything else works. Generate with `npx web-push generate-vapid-keys`. `VAPID_SUBJECT` is a `mailto:` URL. |
| `TAVILY_API_KEY` | Server-side fallback for news search is disabled. Users can still save their own Tavily key in `/settings`. |

---

## 4. First-deploy bootstrap

- **Schema:** self-heals on the first request. `ensureSchema()` runs idempotent
  `IF NOT EXISTS` bumps against Neon, so on a fresh DB you do **not** need to
  run `npm run db:migrate` anymore.
- **First user = admin:** open `https://YOUR-DOMAIN.vercel.app/register` and
  create an account. The first registered user is auto-promoted to `admin`.
  Every subsequent registration defaults to the `user` role.
- **Guests:** the admin can create guest accounts from `/admin/users` and set
  per-guest token / USD caps there.

---

## 5. Vercel Cron Jobs (scheduled routines)

- `apps/web/vercel.json` declares one cron entry:

  ```json
  { "path": "/api/cron/tick", "schedule": "*/5 * * * *" }
  ```

- Hobby plan allows 2 crons at 5-minute minimum granularity. We use 1, so
  you have headroom.
- Each tick: runs every routine whose next-fire time is now-or-past, and
  sweeps expired guest data. Auth is enforced via `CRON_SECRET`.

---

## 6. What still needs a human (one-time, from any browser)

- Register the first admin at `/register`.
- In `/admin/users`: set default guest caps (token cap, USD cap) if you plan
  to invite guests.
- In `/settings`: paste at least one LLM provider key (OpenAI / Anthropic /
  Google / Mistral / Kimi / DeepSeek) and optionally a personal Tavily key.

---

## 7. What does NOT need your PC anymore

| Concern | How it stays up |
|---|---|
| Schema migrations | Auto on first request via `ensureSchema()`. |
| Scheduled routines | Vercel Cron hits `/api/cron/tick` every 5 minutes. |
| Chat / research / portfolio / analysis | All server-side on Vercel functions. |
| API key encryption | `MASTER_KEY` env var (not DPAPI / not a local file). |
| Database | Neon serverless Postgres. |

---

## 8. PC-off verification checklist

Power off your PC, then from your phone:

- [ ] Vercel project dashboard shows the latest deploy in green / Ready.
- [ ] `curl https://YOUR-DOMAIN.vercel.app/api/auth/me` returns JSON (a 401
      with a JSON body is fine — proves the route is live).
- [ ] Sign in via the mobile browser.
- [ ] Add a stock from `/portfolio` (e.g. `NVDA`).
- [ ] Send a chat message in `/analysis` and confirm a response streams back.
- [ ] In Vercel → Project → Deployments → Functions → Logs, confirm
      `/api/cron/tick` is being invoked every 5 minutes with `200 ok`.

If all six pass, the platform is fully cloud-resident and your PC is no
longer in the loop.
