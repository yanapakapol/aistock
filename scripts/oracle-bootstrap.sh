#!/usr/bin/env bash
# Bootstrap aistock on a fresh Oracle Cloud Ubuntu 22.04 VM.
# Run as the `ubuntu` user:
#   curl -fsSL https://raw.githubusercontent.com/yanapakapol/aistock/main/scripts/oracle-bootstrap.sh | bash
# Idempotent: re-runs do `git pull && docker compose up -d --build` and re-apply migrations.
set -euo pipefail

REPO_URL="https://github.com/yanapakapol/aistock.git"
APP_DIR="/home/ubuntu/aistock"
COMPOSE_FILE="$APP_DIR/docker/docker-compose.yml"
SECRETS_DIR="$APP_DIR/docker/secrets"
WEB_ENV="$APP_DIR/apps/web/.env"
OVERRIDE="$APP_DIR/docker/docker-compose.override.yml"
SYSTEMD_UNIT="/etc/systemd/system/aistock.service"

log() { printf '\n=== %s ===\n' "$*"; }

log "1/8 apt packages"
sudo DEBIAN_FRONTEND=noninteractive apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  docker.io docker-compose-v2 git openssl iptables-persistent netfilter-persistent
sudo systemctl enable --now docker

log "2/8 add ubuntu to docker group"
sudo usermod -aG docker ubuntu || true
# Use sudo for docker calls in this script so a fresh session isn't required.
DC="sudo docker compose"

log "3/8 clone or update repo"
if [ ! -d "$APP_DIR/.git" ]; then
  git clone "$REPO_URL" "$APP_DIR"
else
  git -C "$APP_DIR" pull --ff-only
fi

log "4/8 secrets + env"
sudo mkdir -p "$SECRETS_DIR"
if [ ! -s "$SECRETS_DIR/master_key.txt" ]; then
  openssl rand -base64 32 | sudo tee "$SECRETS_DIR/master_key.txt" >/dev/null
fi
sudo chmod 600 "$SECRETS_DIR/master_key.txt"
sudo chown -R ubuntu:ubuntu "$SECRETS_DIR"
MASTER_KEY="$(cat "$SECRETS_DIR/master_key.txt")"

if [ ! -s "$WEB_ENV" ]; then
  SESSION_SECRET="$(openssl rand -base64 32)"
  mkdir -p "$(dirname "$WEB_ENV")"
  cat >"$WEB_ENV" <<EOF
DATABASE_URL=postgres://aistock:aistock@127.0.0.1:5432/aistock
KEY_PROVIDER=env
MASTER_KEY=$MASTER_KEY
SESSION_SECRET=$SESSION_SECRET
NODE_ENV=production
EOF
  chmod 600 "$WEB_ENV"
fi
SESSION_SECRET="$(grep '^SESSION_SECRET=' "$WEB_ENV" | cut -d= -f2-)"

# Override: inject MASTER_KEY/SESSION_SECRET; parent's ports stay 127.0.0.1.
# A separate aistock-edge socat container (below) publishes 0.0.0.0:3000.
cat | sudo tee "$OVERRIDE" >/dev/null <<EOF
services:
  app:
    environment:
      KEY_PROVIDER: env
      MASTER_KEY: "$MASTER_KEY"
      SESSION_SECRET: "$SESSION_SECRET"
EOF

log "5/8 build + start stack + public edge (socat 0.0.0.0:3000 -> app:3000)"
$DC -f "$COMPOSE_FILE" -f "$OVERRIDE" up -d --build
sudo docker rm -f aistock-edge >/dev/null 2>&1 || true
sudo docker run -d --name aistock-edge --restart unless-stopped \
  --network aistock_default -p 0.0.0.0:3000:3000 \
  alpine/socat tcp-listen:3000,fork,reuseaddr tcp:app:3000

log "6/8 wait for db then migrate"
for i in $(seq 1 40); do
  if $DC -f "$COMPOSE_FILE" -f "$OVERRIDE" exec -T db pg_isready -U aistock -d aistock >/dev/null 2>&1; then
    break
  fi
  sleep 3
done
# The runner image is a slim standalone bundle without tsx/drizzle-kit, so run
# migrations from a throwaway node:22-alpine container on the compose network.
sudo docker run --rm --network aistock_default \
  -e DATABASE_URL="postgres://aistock:aistock@db:5432/aistock" \
  -v "$APP_DIR:/work" -w /work/apps/web node:22-alpine \
  sh -c 'npm install --no-audit --no-fund --omit=optional --silent && npx --yes tsx lib/db/migrate.ts'

log "7/8 systemd unit"
cat | sudo tee "$SYSTEMD_UNIT" >/dev/null <<EOF
[Unit]
Description=aistock docker compose stack
Requires=docker.service
After=docker.service network-online.target
[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$APP_DIR/docker
ExecStart=/usr/bin/docker compose -f $COMPOSE_FILE -f $OVERRIDE up -d
ExecStop=/usr/bin/docker compose -f $COMPOSE_FILE -f $OVERRIDE down
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable aistock.service

log "8/8 done"
IP="$(curl -fsSL https://api.ipify.org || echo '<public-ip>')"
cat <<EOF

  aistock is up at:  http://$IP:3000
  First run         : open the URL and register the admin account at /register
  Update later      : bash $APP_DIR/scripts/oracle-update.sh
  Logs              : sudo docker compose -f $COMPOSE_FILE -f $OVERRIDE logs -f
  KEK backup (CRITICAL — losing it loses every stored API key):
                      sudo cat $SECRETS_DIR/master_key.txt

EOF
