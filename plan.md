# Plan: Upgrade Grid Bot to Pionex-Level Features

## Context

The GRVT grid bot is functional (placing grid orders with 20x leverage on `ETH_USDT_Perp` with ~$49.50), but lacks critical safety features (no liquidation price, no stop-loss), runs only while the browser is open (no counter-orders on disconnect), and has unreliable fill detection (matches public trades by price proximity instead of actual order fills). With real money at 20x leverage, risk protection is the top priority.

---

## Phase 1: Risk Protection (browser-based, no new deps)

### 1A. Position Tracking
* **New**: `lib/grvt-api.ts` → add `getPositions(session, subAccountId)` calling `POST /full/v1/positions`
* **New**: `app/api/bot/positions/route.ts` → `GET` endpoint returning positions array
* **Modify**: `components/Dashboard.tsx` → add Position card (entry price, size, unrealized PnL, margin)
* **Action**: Poll every 5s when the bot is running.

### 1B. Liquidation Price
* **New**: `lib/liquidation.ts` → pure functions:
  * `calculateLiquidationPrice(entryPrice, leverage, side, mmr)`
  * *Long*: `entry * (1 - (1 - MMR) / leverage)` | *Short*: `entry * (1 + (1 - MMR) / leverage)`
  * `calculateDistanceToLiquidation(currentPrice, liqPrice)`
* **Modify**: `components/Dashboard.tsx` → display liq price with danger indicator when <5% away
* **Modify**: `app/api/bot/balance/route.ts` → include `maintenance_margin` from `account_summary`

### 1C. Stop Loss / Take Profit
* **Modify**: `lib/grid-bot.ts` → extend `GridConfig` with `stopLoss?: number`, `takeProfit?: number`
* **Modify**: `hooks/useGridBot.ts` → in WebSocket price handler, check SL/TP triggers → cancel all + close position
* **New**: `app/api/bot/orders/close-position/route.ts` → query position, sign opposite market/reduce-only order
* **Modify**: `lib/eip712.ts` → support `is_market: true` and `reduce_only: true` (currently hardcoded false)
* **Modify**: `components/GridBotConfig.tsx` → add SL/TP input fields with recommended values

### 1D. Fix Fill Detection (CRITICAL)
* **Modify**: `hooks/useGridBot.ts` → replace public trade heuristic with polling-based detection:
  * Compare open orders list between polls.
  * If an order disappears and was previously tracked → it was filled.
  * Place counter-order based on the filled order's level.
  * Keep WebSocket for price only, not fill detection.

---

## Phase 2: Server-Side Execution (24/7 operation)

### 2A. Database Layer
* **Install**: `better-sqlite3` + `@types/better-sqlite3`
* **New**: `lib/server/db.ts` → SQLite at `./data/grid-bot.db`
  * **Tables**: 
    * `bots` (id, config JSON, state, grid_state JSON)
    * `trades` (order_id, side, price, size, pnl, timestamp)
    * `logs` (level, message, timestamp)

### 2B. Server-Side Bot Engine
* **New**: `lib/server/bot-engine.ts` → `GridBotEngine` class
  * Manages WebSocket connections (market data for price, private trading WS for fills)
  * Handles order placement, fill detection, counter-orders, SL/TP monitoring
  * Records trades to SQLite
  * Reconnection logic with exponential backoff

### 2C. Bot Manager
* **New**: `lib/server/bot-manager.ts` → singleton via `globalThis`
  * `startBot(config)`, `stopBot(id)`, `getBotState(id)`, `getAllBots()`
  * `restoreFromDb()` → restart bots after server restart

### 2D. New API Routes
* `app/api/bot/start/route.ts` → `POST`, starts bot server-side
* `app/api/bot/stop/route.ts` → `POST`, stops bot
* `app/api/bot/status/route.ts` → `GET`, returns full bot state
* `app/api/bot/trades/route.ts` → `GET`, trade history from DB

### 2E. Frontend Simplification
* **Modify**: `hooks/useGridBot.ts` → strip to ~100 lines, just API calls + polling:
  * `startBot()` → `POST /api/bot/start`
  * `stopBot()` → `POST /api/bot/stop`
  * Poll `GET /api/bot/status` every 2s for state updates
* No more client-side WebSocket, fill detection, or order logic.

---

## Phase 3: Real PnL & Trade History

### 3A. Fill History from GRVT
* **Add**: to `lib/grvt-api.ts`: `getFillHistory(session, subAccountId, instrument)`
* Bot engine records actual fill prices + fees from private WS / fill history API.

### 3B. Accurate PnL
* **New**: `lib/pnl.ts` → `calculateRealizedPnL(buyPrice, sellPrice, size, fee)`
* Replace current estimation (`step * size * 0.998`)

### 3C. Trade History UI
* **New**: `components/TradeHistory.tsx` → table with pagination, CSV export
* **Modify**: `app/page.tsx` → add "Trades" tab

---

## Phase 4: Enhanced Features

### 4A. Funding Rate
* **New**: `app/api/bot/funding/route.ts` → fetch funding rate
* **Modify**: `components/Dashboard.tsx` → funding rate card + daily cost estimate

### 4B. Multiple Bots
* Already enabled by BotManager pattern from Phase 2.
* **Modify**: UI to add bot selector, "New Bot" button.

---

## Dependency Graph

* **Phase 1** *(no deps, works now)*
  * 1A Position → 1B Liquidation (needs entry price)
  * 1A Position → 1C Stop Loss (needs position close)
  * 1D Fill Fix (independent)
* **Phase 2** *(independent of Phase 1, but incorporates it)*
  * 2A DB → 2B Engine → 2C Manager → 2D Routes → 2E Frontend
* **Phase 3** *(needs Phase 2 DB)*
  * 3A Fills → 3B PnL → 3C UI
* **Phase 4** *(needs Phase 2)*
  * 4A Funding (independent)
  * 4B Multi-bot (needs 2C)

---

## Verification

* **Phase 1**: Start bot → verify position card shows in Dashboard, liquidation price displays, set SL below range → trigger SL → verify orders cancelled + position closed.
* **Phase 2**: Start bot → close browser → wait for fill → reopen → verify counter-order was placed, trade recorded in DB.
* **Phase 3**: Run bot for several cycles → verify trade history table matches actual GRVT fills, PnL matches manual calculation.
* **Phase 4**: Check funding rate displays, start second bot on BTC.

---

## Execution Order

Start with **Phase 1** (all 4 sub-tasks in parallel: 1A+1B, 1C, 1D), then **Phase 2**, then **Phase 3**, then **Phase 4**.