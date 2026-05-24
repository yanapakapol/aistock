# Multi-stage build.
# Final image: Node + Next standalone + pandoc + typst + Noto fonts for clean MD/DOCX/PDF exports
# with correct CJK/Thai shaping.

# ---------- deps ----------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json ./
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,target=/root/.npm \
    npm install --workspaces --include-workspace-root --omit=optional

# ---------- builder ----------
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY . .
WORKDIR /app/apps/web
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---------- runner ----------
# pandoc/typst base ships pandoc + typst. Add Node + fonts on top.
FROM pandoc/typst:latest-alpine AS runner
RUN apk add --no-cache \
    nodejs npm \
    font-noto font-noto-cjk font-noto-thai font-noto-extra \
    ca-certificates tini
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOST=0.0.0.0

# Next standalone output
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public

EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/web/server.js"]
