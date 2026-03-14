# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

# Dependencias nativas para better-sqlite3
RUN apt-get update && apt-get install -y \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:20-slim

RUN apt-get update && apt-get install -y \
    libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copiar artefactos de build
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# Directorio para el volumen persistente (SQLite)
RUN mkdir -p /data

ENV BOT_DB_PATH=/data/bot-state.sqlite
ENV NODE_ENV=production

EXPOSE 3000
CMD ["npm", "start"]
