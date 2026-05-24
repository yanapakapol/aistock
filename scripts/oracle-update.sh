#!/usr/bin/env bash
# Pull latest aistock, rebuild containers, run migrations.
set -euo pipefail

APP_DIR="/home/ubuntu/aistock"
COMPOSE_FILE="$APP_DIR/docker/docker-compose.yml"
OVERRIDE="$APP_DIR/docker/docker-compose.override.yml"
DC="sudo docker compose -f $COMPOSE_FILE -f $OVERRIDE"

git -C "$APP_DIR" pull --ff-only
$DC up -d --build
sudo docker run --rm --network aistock_default \
  -e DATABASE_URL="postgres://aistock:aistock@db:5432/aistock" \
  -v "$APP_DIR:/work" -w /work/apps/web node:22-alpine \
  sh -c 'npm install --no-audit --no-fund --omit=optional --silent && npx --yes tsx lib/db/migrate.ts'
echo "updated."
