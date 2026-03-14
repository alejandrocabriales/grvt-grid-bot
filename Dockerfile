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

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:20-slim

RUN apt-get update && apt-get install -y \
    libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copiar dependencias compiladas y fuentes
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app .

# Directorio para el volumen persistente (SQLite)
RUN mkdir -p /data

ENV BOT_DB_PATH=/data/bot-state.sqlite
ENV NODE_ENV=production

CMD ["npx", "tsx", "scripts/run-bot.ts"]
