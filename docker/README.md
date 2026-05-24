# Docker

## Local dev (DB only)

```
docker compose -f docker/docker-compose.yml up -d db
```

Then run the app on the host with `npm run dev` and `DATABASE_URL=postgres://aistock:aistock@127.0.0.1:5432/aistock`.

## Full stack

1. Generate the master key once:
   ```
   mkdir -p docker/secrets
   openssl rand -base64 32 > docker/secrets/master_key.txt
   chmod 600 docker/secrets/master_key.txt
   ```
2. `docker compose -f docker/docker-compose.yml up --build`
3. Visit `http://127.0.0.1:3000`.

The app binds to `127.0.0.1` only by default. For remote access put it behind Cloudflare Tunnel or Tailscale Funnel and complete the `/setup` flow (lands in M7) to set a shared bearer cookie.
