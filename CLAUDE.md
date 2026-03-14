# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Start Next.js dev server (localhost:3000)
npm run build     # Production build + type check
npm run lint      # ESLint
npx tsc --noEmit  # Type check without building

# Run the backtest script (requires tsx)
npx tsx scripts/backtest.ts
```

There are no automated tests. Use `npx tsc --noEmit` after every significant change to catch type errors before running the dev server.

## Environment Setup

Copy `.env.example` to `.env` and fill in:

```
GRVT_API_KEY=                   # From GRVT UI → Settings → API Keys
GRVT_PRIVATE_KEY_EIP712=0x      # 64-char hex private key of the EIP-712 signer wallet
GRVT_SUB_ACCOUNT_ID=            # Numeric sub-account ID
GRVT_USE_TESTNET=false          # true = testnet, false = mainnet
NEXT_PUBLIC_GRVT_USE_TESTNET=false  # Mirror of above for client-side WebSocket URL
```

## Architecture

### Security Model

Credentials never reach the browser. The flow is:

```
Browser (React) → /api/bot/* (Next.js server routes) → GRVT API
```

- `lib/server/env.ts` — reads/validates `.env` credentials, only callable server-side
- `lib/server/session-store.ts` — singleton GRVT session stored in `globalThis` (survives Next.js hot-reload); sessions expire after 50 min and auto-renew on 403
- All API routes authenticate lazily: if no session exists, they call `loginWithApiKey` and cache the result

### Order Signing

GRVT uses EIP-712 typed data signing. Every order must be signed server-side with the private key before submission:

1. `getInstrumentId(instrument)` fetches the `instrument_hash` (uint256) required by EIP-712
2. `signLimitOrder()` in `lib/eip712.ts` signs the order using `ethers.Wallet.signTypedData`
3. The signed payload is sent to `POST /full/v1/create_order`

The chain IDs are `325` (mainnet) and `326` (testnet). The EIP-712 domain has no `verifyingContract` or `salt`.

### Bot Execution (Client-Side)

The bot runs entirely in the browser via `hooks/useGridBot.ts`. This means it stops if the tab is closed (Phase 2 of `plan.md` describes a server-side engine that hasn't been built yet).

Key runtime loops in `useGridBot.ts`:
- **WebSocket** — subscribes to `mini.s` stream for real-time mark price; triggers SL/TP/trailing stop checks on every price tick
- **Order polling** (every 3s) — compares tracked `orderId`s against open orders; missing IDs = filled → places counter-order
- **Position polling** (every 5s) — updates position state, recalculates trailing stop, checks drawdown kill switch
- **Indicators polling** (every 60s) — fetches 250 klines from Binance, runs `calculateIndicators`, detects market bias, triggers directional strategy signals, and checks if grid needs repositioning

### Strategy Modes

`GridConfig.strategyMode` controls the bot's behavior:

| Mode | Description |
|---|---|
| `NEUTRAL_GRID` | Standard grid: BUY below price, SELL above price |
| `LONG_GRID` | Same as neutral but direction-aware |
| `SHORT_GRID` | Inverted grid: SELL above, BUY below (for bear markets) |
| `AUTO_GRID` | Detects market bias via EMA50/EMA200 and selects LONG or SHORT grid dynamically |
| `BULL_MOMENTUM` | Directional long: enters on RSI cross-up + trend confirmation, exits on overbought |
| `BEAR_BREAKDOWN` | Directional short: enters on MACD cross-down + trend, exits on oversold |

Directional strategies (`BULL_MOMENTUM`, `BEAR_BREAKDOWN`) do not place grid orders — they open single positions via market orders.

### Key Library Files

- `lib/grid-bot.ts` — all pure grid math: level calculation, order sizing, counter-orders, market bias detection, trailing stop, drawdown, repositioning, signal cooldown
- `lib/indicators.ts` — wraps `technicalindicators` package; returns EMA21/50/100/200, RSI (last 5), MACD (last 5), ATR, volatility ratio, EMA cross state, trend strength
- `lib/grvt-api.ts` — typed wrappers for every GRVT REST endpoint; `getBinanceKlines` provides kline data as a fallback (GRVT doesn't expose a public klines endpoint)
- `lib/eip712.ts` — order signing
- `lib/liquidation.ts` — liquidation price formulas for isolated margin

### API Routes

All routes under `app/api/bot/` follow the same pattern: read credentials from env, get or create a session, call the GRVT API, return `{ ok: true, ... }` or `{ ok: false, error: string }`.

The `/api/bot/klines` route proxies to Binance (`api.binance.com`) because GRVT doesn't expose historical klines publicly.

### UI Layout

Single page (`app/page.tsx`): two-column layout — left sidebar (`GridBotConfig`) for config/controls, right panel (`Dashboard` + `ActivityLog`) for live data. The right panel only renders after the bot starts and `state` is non-null.

`GridBotConfig` auto-detects market bias by fetching klines when the pair selector changes and shows color-coded preset strategies (green = bullish → LONG_GRID, red = bearish → SHORT_GRID).

### Instrument Size Constraints

GRVT enforces `min_size` and `tick_size` per instrument. `getInstrumentInfo()` fetches and caches these. `calculateMaxGrids()` auto-reduces grid count if orders would fall below `min_size`. Prices must be multiples of `tick_size` (use `price.toFixed(priceDecimalsRef.current)`).
