# aistock — deploy guide

aistock is a single-user, self-hosted app. Default posture is **bind 127.0.0.1
and tunnel for remote access**. Public binding is supported but requires the
shared-bearer-cookie setup flow (M7) — see [Public binding](#public-binding).

---

## Environment variables

| Var | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | yes | — | Postgres 16 with `pgvector` + `pg_search` extensions. |
| `BIND_HOST` | no | `127.0.0.1` | Set to `0.0.0.0` only with `SETUP_BEARER_HMAC_SECRET`. |
| `SETUP_BEARER_HMAC_SECRET` | when public | — | Long random string (≥32 bytes). HMAC key for the access cookie. |
| `MASTER_KEY` | cloud | — | Base64 KEK for `DockerSecretProvider`. Windows dev uses DPAPI instead. |
| `KEY_PROVIDER` | no | auto | `dpapi` \| `docker_secret` \| `kms`. Auto-detects DPAPI on Windows. |
| `VAPID_PUBLIC_KEY` | push | — | Web Push VAPID public key (base64url). |
| `VAPID_PRIVATE_KEY` | push | — | Web Push VAPID private key (server-only). |
| `VAPID_SUBJECT` | push | — | `mailto:you@example.com`. |

The KEK is the root secret. **Lose it and every encrypted API key in `api_keys`
is unrecoverable.** Back it up out-of-band.

---

## Option 1 — Hetzner Cloud (Docker Compose + Cloudflare Tunnel)

Recommended for the default setup. Keeps the app on `127.0.0.1` and exposes it
via Cloudflare Tunnel — no inbound ports open, no public IP exposure, free TLS.

1. **Provision** a CPX11 / CAX11 (€4–5/mo). Ubuntu 24.04.
2. **Install Docker** + Compose plugin:
   ```sh
   curl -fsSL https://get.docker.com | sh
   ```
3. **Create the KEK as a Docker secret** (32 random bytes, base64):
   ```sh
   openssl rand -base64 32 | docker secret create aistock_master_key -
   ```
4. **Clone + configure**:
   ```sh
   git clone <repo> /opt/aistock && cd /opt/aistock
   cp .env.example .env   # fill DATABASE_URL only
   ```
5. **Compose up** — the provided `docker/docker-compose.yml` binds the app
   to `127.0.0.1:3000`, runs Postgres with pgvector + pg_search, mounts the
   secret at `/run/secrets/aistock_master_key`, and bundles pandoc + typst +
   Noto fonts for the export pipeline:
   ```sh
   cd docker && docker compose up -d
   ```
6. **Cloudflare Tunnel** (zero-trust dashboard or `cloudflared`):
   ```sh
   cloudflared tunnel login
   cloudflared tunnel create aistock
   cloudflared tunnel route dns aistock aistock.example.com
   # /etc/cloudflared/config.yml
   #   tunnel: aistock
   #   credentials-file: /root/.cloudflared/<id>.json
   #   ingress:
   #     - hostname: aistock.example.com
   #       service: http://127.0.0.1:3000
   #     - service: http_status:404
   cloudflared service install
   ```
7. **Lock down** with Cloudflare Access (Google / GitHub / one-time PIN) on the
   `aistock.example.com` hostname. This is the primary auth layer — the
   bearer-cookie flow is the fallback.

**Backups**: `pg_dump` to a Backblaze B2 bucket nightly. The KEK file must be
backed up separately (encrypted, offline) — losing it loses every API key.

---

## Option 2 — Fly.io (Dockerfile + Tigris / external Postgres)

1. **Install flyctl** and `fly auth login`.
2. **Build + launch** from `docker/Dockerfile`:
   ```sh
   fly launch --dockerfile docker/Dockerfile --no-deploy
   ```
   Pick a region close to you. Decline the bundled Postgres if you already have
   one — Fly's managed Postgres is being deprecated; prefer **Neon**,
   **Supabase**, or **Crunchy Bridge** with pgvector + pg_search.
3. **Set secrets** (these become env vars in the VM):
   ```sh
   fly secrets set \
     DATABASE_URL='postgres://...' \
     MASTER_KEY="$(openssl rand -base64 32)" \
     KEY_PROVIDER=docker_secret \
     SETUP_BEARER_HMAC_SECRET="$(openssl rand -base64 32)" \
     BIND_HOST=0.0.0.0 \
     VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT='mailto:you@example.com'
   ```
4. **Optional: Tigris** for export-file blob storage:
   ```sh
   fly storage create
   ```
   Then point `EXPORT_BUCKET` / `EXPORT_BUCKET_REGION` at it.
5. **Deploy**: `fly deploy`. Fly terminates TLS at its edge, so the app
   listens on `:3000` inside the VM.
6. **Public binding requires the bearer cookie** — visit `/setup` first.

---

## Option 3 — Tailscale Funnel (zero infra)

For a single-developer workflow with no cloud bill beyond the VPS:

1. `tailscale up` on the host.
2. `tailscale funnel 3000` to expose `https://<machine>.tail-net.ts.net` to
   the public internet (Tailscale handles TLS).
3. Keep `BIND_HOST=127.0.0.1` — Tailscale Funnel proxies from the tailnet to
   loopback. No bearer cookie needed if you trust your tailnet.
4. For sharing read-only access with someone outside the tailnet, switch to
   `BIND_HOST=0.0.0.0` + bearer cookie, or stick with Cloudflare Access.

**iOS install over Funnel works**: the `.ts.net` hostname has a real TLS
certificate, which iOS Safari requires for PWA install + Web Push.

---

## Public binding

If you set `BIND_HOST=0.0.0.0`:

1. **Generate the shared secret** (treat it as a password — store in 1Password):
   ```sh
   openssl rand -base64 32
   ```
2. Set `SETUP_BEARER_HMAC_SECRET` to that value in the environment.
3. First visit to any route redirects to `/setup`. Paste the secret → a
   `HttpOnly; Secure; SameSite=Strict` cookie is issued for 90 days.
4. All `/api/*` mutating requests additionally enforce
   `Sec-Fetch-Site: same-origin` and pass through a 60 req/min per-IP token
   bucket. The `/api/push/vapid-public-key` endpoint and `/setup` itself are
   exempt from the cookie check.

**The shared secret is possession-only, not identity.** Anyone who learns it
has full access. Rotate by changing `SETUP_BEARER_HMAC_SECRET` and restarting
— all existing cookies are invalidated.

---

## PWA install on iOS Safari

iOS only allows Web Push when the app is installed to the home screen.

1. Open the deployed URL in **Safari** (not Chrome — Chrome on iOS is Safari
   under the hood but does not expose the install flow).
2. Tap the **Share** button → **Add to Home Screen** → **Add**.
3. Launch aistock from the home-screen icon (this gives it a standalone
   `WindowClient` that owns the service worker registration).
4. In **Settings → Notifications**, allow notifications for aistock.
5. Inside the app, accept the permission prompt when it appears. The
   subscription is POSTed to `/api/push/subscribe`.

**Caveats**:
- Requires iOS 16.4+.
- Every push from the server **must** call `showNotification()` — silent
  pushes will cause iOS to revoke the subscription after a few failures. The
  service worker enforces this.
- iOS evicts PWA storage after ~7 days of inactivity. Don't put anything in
  IndexedDB that isn't safely re-fetchable.
- EU users on iOS in the EU may have a different install flow depending on
  Safari version / DMA compliance — fall back to the in-browser experience.

---

## Backups

- **Postgres**: `pg_dump --format=custom` nightly → S3-compatible bucket
  (Backblaze B2 or Tigris). Test restore quarterly.
- **KEK**: separate, encrypted, offline. Without it the encrypted API keys in
  `api_keys` are dead. A printed paper backup in a safe is not unreasonable.
- **Routine exports**: persisted to the database via `routine_runs.export_path`
  if you mount object storage; otherwise written to the app's writable volume.
