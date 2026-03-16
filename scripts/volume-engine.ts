/**
 * scripts/volume-engine.ts — Motor de Volume Optimizer 24/7
 *
 * Tres sub-estrategias que se alternan automáticamente:
 *
 *   SPREAD_CAPTURE (mercado lateral):
 *     Coloca pares bid/ask compactos alrededor del mid price.
 *     Cuando ambos lados se llenan → volumen + spread capturado.
 *     Recentra el grid cada 60s o cuando el precio deriva >50% del ancho.
 *
 *   SCALP_TREND (mercado con tendencia):
 *     Abre posición direccional pequeña con TP/SL ajustados.
 *     Ciclos rápidos que generan volumen adicional.
 *
 *   PAUSE (volatilidad extrema):
 *     Cancela todo y espera a que el mercado se calme.
 *     Protege capital de movimientos bruscos.
 *
 * Bucles:
 *   1. Order polling    (3s)  — detecta fills, coloca contra-órdenes
 *   2. Regime detection (30s) — evalúa indicadores, cambia de sub-estrategia
 *   3. Grid recenter    (60s) — recalcula grid si el precio se movió
 *   4. Protection check (10s) — drawdown, exposure, session loss
 */

import * as dotenv from "dotenv";
dotenv.config();

import {
  loginWithApiKey,
  getOpenOrders,
  createOrder,
  cancelOrder,
  cancelAllOrders as grvtCancelAll,
  getPositions,
  getSubAccountSummary,
  getInstrumentInfo,
  getBinanceKlines,
  type GrvtSession,
} from "../lib/grvt-api";

import { signLimitOrder } from "../lib/eip712";
import { calculateIndicators, type IndicatorsResult } from "../lib/indicators";
import { BotDatabase, type DbOrder } from "./db";

import {
  type VolumeConfig,
  type MarketRegime,
  type VolumeStats,
  type SpreadOrder,
  type ProtectionState,
  detectMarketRegime,
  generateSpreadOrders,
  generateScalpSignal,
  calculateAdaptiveRange,
  checkProtection,
  createVolumeStats,
  recordFill,
  calculatePerformanceMetrics,
  shouldRecenterGrid,
} from "../lib/volume-optimizer";

// ─── Constantes ──────────────────────────────────────────────────────────────

const ORDER_POLL_MS       = 3_000;
const REGIME_POLL_MS      = 30_000;
const PROTECTION_POLL_MS  = 10_000;
const SESSION_TTL_MS      = 50 * 60 * 1_000;

const RETRY_BASE_MS       = 1_000;
const RETRY_MAX_MS        = 60_000;
const RETRY_MAX_ATTEMPTS  = 8;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const ICONS = { info: "ℹ", warn: "⚠", error: "✖", success: "✔" } as const;

function log(
  db: BotDatabase,
  level: "info" | "warn" | "error" | "success",
  msg: string
): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${ICONS[level]} ${msg}`);
  db.appendLog(level, msg);
}

class AuthError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "AuthError";
  }
}

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  db: BotDatabase,
  maxAttempts = RETRY_MAX_ATTEMPTS
): Promise<T> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err: unknown) {
      attempt++;
      const message = err instanceof Error ? err.message : String(err);
      const isRateLimit = message.includes("429") || message.toLowerCase().includes("rate limit");
      const isAuth = message.includes("403") || message.includes("401");

      if (attempt >= maxAttempts) {
        log(db, "error", `[${label}] Max retries (${maxAttempts}): ${message}`);
        throw err;
      }
      if (isAuth && attempt >= 2) throw new AuthError("Session expired");

      const delay = isRateLimit
        ? 60_000
        : Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS) + Math.random() * 1_000;

      log(db, "warn", `[${label}] Attempt ${attempt}/${maxAttempts} failed (${message}). Retry in ${Math.round(delay / 1_000)}s`);
      await sleep(delay);
    }
  }
}

// ─── Tracked Order (órdenes activas en memoria) ─────────────────────────────

interface TrackedOrder {
  dbId: number;
  orderId: string;
  side: "buy" | "sell";
  price: number;
  size: string;
  pairIndex: number;    // índice del par spread (0, 1, 2...)
  placedAt: number;     // timestamp
  isScalp: boolean;     // es orden de scalp (no spread)
}

// ─── VolumeEngine ────────────────────────────────────────────────────────────

export class VolumeEngine {
  private config: VolumeConfig;
  private db: BotDatabase;

  // Session
  private session: GrvtSession | null = null;
  private sessionTime = 0;

  // Lifecycle
  private running = false;

  // Instrument metadata
  private priceDecimals = 2;
  private sizeDecimals = 2;
  private minSize = 0.01;
  private instrumentHash = "";

  // Market state
  private currentPrice = 0;
  private indicators: IndicatorsResult | null = null;
  private regime: MarketRegime = "RANGING";

  // Grid state
  private gridCenter = 0;
  private gridHalfWidth = 0;
  private lastGridPlacedAt = 0;
  private trackedOrders: TrackedOrder[] = [];

  // Scalp state
  private hasOpenScalp = false;
  private scalpSide: "buy" | "sell" | null = null;

  // Stats & protection
  private stats: VolumeStats = createVolumeStats();
  private maxEquity = 0;
  private initialEquity = 0;

  constructor(config: VolumeConfig, dbPath: string) {
    this.config = { ...config };
    this.db = new BotDatabase(dbPath);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SESSION
  // ══════════════════════════════════════════════════════════════════════════

  private async ensureSession(): Promise<GrvtSession> {
    const expired = Date.now() - this.sessionTime > SESSION_TTL_MS;
    if (this.session && !expired) return this.session;

    log(this.db, "info", "Authenticating with GRVT...");
    const apiKey = process.env.GRVT_API_KEY;
    if (!apiKey) throw new Error("GRVT_API_KEY not set");

    this.session = await loginWithApiKey(apiKey);
    this.sessionTime = Date.now();
    log(this.db, "success", `Session established. Account: ${this.session.accountId}`);
    return this.session;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  ORDER PLACEMENT
  // ══════════════════════════════════════════════════════════════════════════

  private async placeLimitOrder(
    price: number,
    side: "buy" | "sell",
    size: string,
    pairIndex: number,
    isScalp = false,
    reduceOnly = false
  ): Promise<TrackedOrder | null> {
    const privateKey = process.env.GRVT_PRIVATE_KEY_EIP712;
    const subAccountId = process.env.GRVT_SUB_ACCOUNT_ID;
    const useTestnet = process.env.GRVT_USE_TESTNET === "true";

    if (!privateKey || !subAccountId) throw new Error("Missing credentials");

    const priceStr = price.toFixed(this.priceDecimals);
    const sizeStr = parseFloat(size).toFixed(this.sizeDecimals);

    const dbId = this.db.insertOrder({
      pair: this.config.pair,
      level_index: pairIndex,
      price,
      side,
      size: sizeStr,
      order_id: null,
      client_order_id: null,
      status: "pending",
      counter_placed: 0,
      created_at: Date.now(),
      filled_at: null,
    });

    try {
      const session = await this.ensureSession();

      const signed = await signLimitOrder({
        subAccountId,
        instrument: this.config.pair,
        instrumentId: this.instrumentHash,
        size: sizeStr,
        limitPrice: priceStr,
        isBuying: side === "buy",
        reduceOnly,
        privateKey,
        useTestnet,
      });

      const result = await createOrder(session, signed);
      const orderId = result.order_id;

      this.db.updateOrderId(dbId, orderId, "open");

      const tag = isScalp ? "SCALP" : "SPREAD";
      log(this.db, "success", `[${tag}] ${side.toUpperCase()} ${sizeStr} @ $${priceStr} → ID: ${orderId}`);

      const tracked: TrackedOrder = {
        dbId,
        orderId,
        side,
        price,
        size: sizeStr,
        pairIndex,
        placedAt: Date.now(),
        isScalp,
      };
      this.trackedOrders.push(tracked);
      return tracked;

    } catch (err: unknown) {
      this.db.updateOrderId(dbId, `failed_${dbId}`, "cancelled");
      const msg = err instanceof Error ? err.message : String(err);
      log(this.db, "error", `[Order] Error placing ${side} @ $${priceStr}: ${msg}`);
      return null;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  INITIALIZATION
  // ══════════════════════════════════════════════════════════════════════════

  private async initialize(): Promise<void> {
    log(this.db, "info", `Initializing Volume Optimizer for ${this.config.pair}...`);

    this.db.setConfig("volume_config", this.config);
    this.db.setConfig("start_time", Date.now());

    // Instrument metadata
    const info = await withRetry(
      () => getInstrumentInfo(this.config.pair),
      "InstrumentInfo",
      this.db,
      5
    );
    this.instrumentHash = info.instrumentHash;
    this.priceDecimals = info.priceDecimals;
    this.sizeDecimals = info.sizeDecimals;
    this.minSize = parseFloat(info.minSize);

    // Current price
    const klines = await getBinanceKlines(this.config.pair, "1m", 3);
    this.currentPrice = klines.at(-1)?.close ?? 0;
    if (!this.currentPrice) throw new Error("Could not get current price");
    log(this.db, "info", `Current price: $${this.currentPrice}`);

    // Initial balance
    const session = await this.ensureSession();
    const subAccountId = process.env.GRVT_SUB_ACCOUNT_ID!;
    const balance = await getSubAccountSummary(session, subAccountId);
    this.maxEquity = parseFloat(balance.equity);
    this.initialEquity = this.maxEquity;
    this.db.setMetric("max_equity", this.maxEquity);
    this.db.setMetric("initial_equity", this.initialEquity);
    log(this.db, "info", `Initial equity: $${this.maxEquity.toFixed(2)}`);

    // Set leverage
    const { setInitialLeverage } = await import("../lib/grvt-api");
    try {
      await setInitialLeverage(session, subAccountId, this.config.pair, this.config.leverage);
      log(this.db, "info", `Leverage set to ${this.config.leverage}x`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(this.db, "warn", `Leverage set failed (may already be set): ${msg}`);
    }

    // Initial indicators
    await this.refreshIndicators();

    // Place initial spread grid
    await this.placeSpreadGrid();
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SPREAD GRID PLACEMENT
  // ══════════════════════════════════════════════════════════════════════════

  private async placeSpreadGrid(): Promise<void> {
    // Cancel existing spread orders
    await this.cancelSpreadOrders();

    const atr14 = this.indicators?.atr14 ?? null;
    const { lower, upper, halfWidth } = calculateAdaptiveRange(
      this.currentPrice,
      atr14,
      this.config.gridAtrMult
    );

    this.gridCenter = this.currentPrice;
    this.gridHalfWidth = halfWidth;
    this.lastGridPlacedAt = Date.now();

    log(
      this.db,
      "info",
      `[Grid] Centering @ $${this.currentPrice.toFixed(this.priceDecimals)} | Range: $${lower.toFixed(this.priceDecimals)} – $${upper.toFixed(this.priceDecimals)} (width: $${(halfWidth * 2).toFixed(this.priceDecimals)})`
    );

    const orders = generateSpreadOrders(
      this.currentPrice,
      this.config,
      this.sizeDecimals,
      this.priceDecimals,
      this.minSize
    );

    if (orders.length === 0) {
      log(this.db, "warn", "[Grid] Order size below minimum — reduce spreadPairs or increase capital");
      return;
    }

    log(this.db, "info", `[Grid] Placing ${orders.length} spread orders (${orders.length / 2} pairs)...`);

    for (const order of orders) {
      await withRetry(
        () => this.placeLimitOrder(order.price, order.side, order.size, order.pairIndex),
        `Spread_${order.side}_${order.pairIndex}`,
        this.db,
        3
      );
      await sleep(150);
    }

    log(this.db, "success", `[Grid] ${orders.length} spread orders placed`);
  }

  private async cancelSpreadOrders(): Promise<void> {
    const spreadOrders = this.trackedOrders.filter((o) => !o.isScalp);
    if (spreadOrders.length === 0) return;

    const session = await this.ensureSession();
    const subAccountId = process.env.GRVT_SUB_ACCOUNT_ID!;

    for (const order of spreadOrders) {
      try {
        await cancelOrder(session, subAccountId, order.orderId);
        this.db.updateOrderStatus(order.orderId, "cancelled", Date.now());
      } catch {
        // Order may already be filled or cancelled
      }
      await sleep(100);
    }

    this.trackedOrders = this.trackedOrders.filter((o) => o.isScalp);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SCALP MANAGEMENT
  // ══════════════════════════════════════════════════════════════════════════

  private async openScalpPosition(): Promise<void> {
    if (this.hasOpenScalp) return;
    if (this.regime !== "TRENDING_UP" && this.regime !== "TRENDING_DOWN") return;

    const signal = generateScalpSignal(
      this.currentPrice,
      this.regime,
      this.config,
      this.sizeDecimals,
      this.priceDecimals,
      this.minSize
    );

    if (!signal) return;

    log(
      this.db,
      "info",
      `[Scalp] ${signal.side.toUpperCase()} signal @ $${signal.entryPrice.toFixed(this.priceDecimals)} | TP: $${signal.tpPrice.toFixed(this.priceDecimals)} | SL: $${signal.slPrice.toFixed(this.priceDecimals)}`
    );

    // Place entry (market-like limit order, tight to current price)
    const entryOffset = this.currentPrice * 0.0002; // 2 bps slippage tolerance
    const entryPrice = signal.side === "buy"
      ? this.currentPrice + entryOffset
      : this.currentPrice - entryOffset;

    const entry = await this.placeLimitOrder(
      parseFloat(entryPrice.toFixed(this.priceDecimals)),
      signal.side,
      signal.size,
      99, // special pairIndex for scalps
      true
    );

    if (entry) {
      this.hasOpenScalp = true;
      this.scalpSide = signal.side;

      // Place TP order (reduce only, opposite side)
      const tpSide = signal.side === "buy" ? "sell" : "buy";
      await sleep(200);
      await this.placeLimitOrder(
        signal.tpPrice,
        tpSide,
        signal.size,
        100, // TP marker
        true,
        true // reduce only
      );
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  FILL DETECTION (ORDER POLLING)
  // ══════════════════════════════════════════════════════════════════════════

  private async orderPollingLoop(): Promise<void> {
    if (!this.running) return;

    try {
      const session = await this.ensureSession();
      const subAccountId = process.env.GRVT_SUB_ACCOUNT_ID!;

      const exchangeOrders = await getOpenOrders(session, subAccountId, this.config.pair);
      const liveIds = new Set(exchangeOrders.map((o) => o.id));

      const filled: TrackedOrder[] = [];
      const stillOpen: TrackedOrder[] = [];

      for (const tracked of this.trackedOrders) {
        if (!liveIds.has(tracked.orderId)) {
          filled.push(tracked);
          this.db.updateOrderStatus(tracked.orderId, "filled", Date.now());
        } else {
          stillOpen.push(tracked);
        }
      }

      this.trackedOrders = stillOpen;

      for (const order of filled) {
        await this.handleFill(order);
      }

    } catch (err: unknown) {
      if (err instanceof AuthError) {
        this.session = null;
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        log(this.db, "warn", `[OrderPoll] Error: ${msg}`);
      }
    }

    if (this.running) {
      setTimeout(() => this.orderPollingLoop(), ORDER_POLL_MS);
    }
  }

  private async handleFill(order: TrackedOrder): Promise<void> {
    const notional = order.price * parseFloat(order.size);

    if (order.isScalp) {
      // Scalp fill
      this.stats.scalpTrades++;
      log(
        this.db,
        "success",
        `[Scalp Fill] ${order.side.toUpperCase()} @ $${order.price.toFixed(this.priceDecimals)} | Notional: $${notional.toFixed(2)}`
      );

      // If TP or SL hit, clean up scalp state
      if (order.pairIndex === 100) {
        // TP filled — calculate profit
        const tpPnl = notional * (this.config.scalpTpBps / 10_000);
        this.stats = recordFill(this.stats, order.price, order.size, tpPnl);
        this.hasOpenScalp = false;
        this.scalpSide = null;
        log(this.db, "success", `[Scalp] TP hit! PnL: +$${tpPnl.toFixed(4)}`);
        // Cancel remaining scalp orders
        await this.cancelScalpOrders();
      } else if (order.pairIndex === 99) {
        // Entry filled — just track volume, PnL comes at exit
        this.stats = recordFill(this.stats, order.price, order.size, 0);
      }
      return;
    }

    // Spread fill
    log(
      this.db,
      "success",
      `[Spread Fill] ${order.side.toUpperCase()} @ $${order.price.toFixed(this.priceDecimals)} (pair ${order.pairIndex}) | Notional: $${notional.toFixed(2)}`
    );

    // Check if the opposite side of this pair was also filled (complete cycle)
    const oppositeSide = order.side === "buy" ? "sell" : "buy";
    const counterFilled = this.trackedOrders.findIndex(
      (o) => o.pairIndex === order.pairIndex && o.side === oppositeSide && !o.isScalp
    );

    // Calculate approximate PnL: half the spread offset for this pair
    const spreadBps = this.config.spreadOffsetBps + this.config.spreadStepBps * order.pairIndex;
    const approxSpreadPnl = notional * (spreadBps / 10_000);

    // Record fill with estimated PnL (conservative: only count if we expect the counter to fill)
    this.stats = recordFill(this.stats, order.price, order.size, 0);

    if (counterFilled !== -1) {
      // Both sides filled — complete cycle!
      this.stats.spreadCycles++;
      this.stats.totalPnL += approxSpreadPnl * 2; // both sides contributed
      this.stats.sessionPnL += approxSpreadPnl * 2;
      log(
        this.db,
        "success",
        `[Spread Cycle] Pair ${order.pairIndex} completed! Spread profit: ~$${(approxSpreadPnl * 2).toFixed(4)} | Cycles: ${this.stats.spreadCycles}`
      );
    }

    // Place replacement order at same level for continuous cycling
    await sleep(200);
    await this.placeLimitOrder(order.price, order.side, order.size, order.pairIndex);

    this.persistStats();
  }

  private async cancelScalpOrders(): Promise<void> {
    const scalpOrders = this.trackedOrders.filter((o) => o.isScalp);
    const session = await this.ensureSession();
    const subAccountId = process.env.GRVT_SUB_ACCOUNT_ID!;

    for (const order of scalpOrders) {
      try {
        await cancelOrder(session, subAccountId, order.orderId);
        this.db.updateOrderStatus(order.orderId, "cancelled", Date.now());
      } catch {
        // May already be filled
      }
    }
    this.trackedOrders = this.trackedOrders.filter((o) => !o.isScalp);
    this.hasOpenScalp = false;
    this.scalpSide = null;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  REGIME DETECTION LOOP
  // ══════════════════════════════════════════════════════════════════════════

  private async regimeDetectionLoop(): Promise<void> {
    if (!this.running) return;

    try {
      await this.refreshIndicators();

      const prevRegime = this.regime;
      if (this.indicators) {
        this.regime = detectMarketRegime(this.indicators, this.config.maxVolatilityRatio);
      }

      if (this.regime !== prevRegime) {
        log(this.db, "info", `[Regime] Changed: ${prevRegime} → ${this.regime}`);
        await this.handleRegimeChange(prevRegime, this.regime);
      }

      // Check if grid needs recentering
      if (
        this.regime === "RANGING" &&
        shouldRecenterGrid(
          this.currentPrice,
          this.gridCenter,
          this.gridHalfWidth,
          this.lastGridPlacedAt,
          this.config.gridRecenterIntervalMs
        )
      ) {
        log(this.db, "info", "[Grid] Recentering grid (price drifted or stale orders)...");
        await this.placeSpreadGrid();
      }

      // Try opening scalp in trending market
      if (
        (this.regime === "TRENDING_UP" || this.regime === "TRENDING_DOWN") &&
        !this.hasOpenScalp
      ) {
        await this.openScalpPosition();
      }

      // Print periodic metrics
      this.printMetrics();

    } catch (err: unknown) {
      if (err instanceof AuthError) {
        this.session = null;
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        log(this.db, "warn", `[Regime] Error: ${msg}`);
      }
    }

    if (this.running) {
      setTimeout(() => this.regimeDetectionLoop(), REGIME_POLL_MS);
    }
  }

  private async handleRegimeChange(from: MarketRegime, to: MarketRegime): Promise<void> {
    if (to === "VOLATILE_PAUSE") {
      log(this.db, "warn", "[Regime] High volatility — pausing all operations");
      await this.cancelAllTracked();
      return;
    }

    if (from === "VOLATILE_PAUSE") {
      log(this.db, "info", "[Regime] Volatility normalized — resuming operations");
      await this.placeSpreadGrid();
      return;
    }

    if (to === "RANGING") {
      // Cancel scalps, ensure spread grid is active
      await this.cancelScalpOrders();
      if (this.trackedOrders.filter((o) => !o.isScalp).length === 0) {
        await this.placeSpreadGrid();
      }
    }

    if (to === "TRENDING_UP" || to === "TRENDING_DOWN") {
      // Keep spread grid but with wider spacing, add scalp
      // The grid will adapt on next recenter cycle
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  PROTECTION CHECK LOOP
  // ══════════════════════════════════════════════════════════════════════════

  private async protectionCheckLoop(): Promise<void> {
    if (!this.running) return;

    try {
      const session = await this.ensureSession();
      const subAccountId = process.env.GRVT_SUB_ACCOUNT_ID!;

      const balance = await getSubAccountSummary(session, subAccountId);
      const equity = parseFloat(balance.equity);

      if (equity > this.maxEquity) {
        this.maxEquity = equity;
        this.db.setMetric("max_equity", equity);
      }

      // Calculate total exposure from positions
      const positions = await getPositions(session, subAccountId, this.config.pair);
      const totalExposure = positions.reduce((sum, p) => {
        return sum + Math.abs(parseFloat(p.size)) * parseFloat(p.mark_price);
      }, 0);

      const state: ProtectionState = {
        sessionPnL: this.stats.sessionPnL,
        maxEquity: this.maxEquity,
        currentEquity: equity,
        totalExposure,
        isPaused: false,
        pauseReason: null,
      };

      const pauseReason = checkProtection(this.config, state);

      if (pauseReason) {
        log(this.db, "error", `[Protection] ${pauseReason} → Emergency stop!`);
        await this.emergencyStop();
        return;
      }

      // ── Session Take Profit ──────────────────────────────────────────────
      if (this.config.sessionTpPct > 0) {
        const tpTarget = this.config.totalInvestment * (this.config.sessionTpPct / 100);
        if (this.stats.sessionPnL >= tpTarget) {
          log(
            this.db,
            "success",
            `[TP] Objetivo de sesión alcanzado: PnL +$${this.stats.sessionPnL.toFixed(4)} >= meta $${tpTarget.toFixed(2)} (+${this.config.sessionTpPct}%) → Deteniendo para asegurar ganancias`
          );
          await this.emergencyStop();
          return;
        }
      }

      // ── Stop Loss por posición abierta (spread) ──────────────────────────
      if (this.config.spreadSlBps > 0 && this.currentPrice > 0) {
        const positions = await getPositions(session, subAccountId, this.config.pair);
        for (const pos of positions) {
          const size = parseFloat(pos.size);
          if (Math.abs(size) < this.minSize) continue;

          const entryPrice = parseFloat(pos.entry_price);
          const markPrice  = parseFloat(pos.mark_price);
          if (!entryPrice || !markPrice) continue;

          const isLong    = size > 0;
          const slDist    = entryPrice * (this.config.spreadSlBps / 10_000);
          const slTrigger = isLong
            ? markPrice <= entryPrice - slDist
            : markPrice >= entryPrice + slDist;

          if (slTrigger) {
            const unrlPnl = parseFloat(pos.unrealized_pnl);
            log(
              this.db,
              "warn",
              `[Spread SL] ${isLong ? "LONG" : "SHORT"} ${Math.abs(size)} @ entry $${entryPrice.toFixed(this.priceDecimals)} → mark $${markPrice.toFixed(this.priceDecimals)} | PnL no realizado: $${unrlPnl.toFixed(4)} → Cerrando posición`
            );

            // Cierre reduce-only con pequeño slippage para ejecución rápida
            const closeSide  = isLong ? "sell" : "buy";
            const slippage   = this.currentPrice * 0.001; // 10 bps
            const closePrice = isLong
              ? this.currentPrice - slippage
              : this.currentPrice + slippage;

            await this.placeLimitOrder(
              parseFloat(closePrice.toFixed(this.priceDecimals)),
              closeSide,
              Math.abs(size).toFixed(this.sizeDecimals),
              300, // marker especial para cierre por SL
              false,
              true  // reduce only
            );

            // Registrar pérdida estimada en stats
            const lossEst = Math.abs(unrlPnl) > 0 ? Math.abs(unrlPnl) : Math.abs(size) * slDist;
            this.stats.totalPnL  -= lossEst;
            this.stats.sessionPnL -= lossEst;

            // Recentrar el grid en el precio actual después del SL
            await sleep(600);
            await this.placeSpreadGrid();
          }
        }
      }

      // ── Stop Loss de Scalp (check manual porque usamos limit orders) ─────
      if (this.hasOpenScalp && this.scalpSide && this.currentPrice > 0) {
        const scalpEntry = this.trackedOrders.find((o) => o.isScalp && o.pairIndex === 99);
        if (scalpEntry) {
          const slBps = this.config.scalpSlBps;
          const slDistance = scalpEntry.price * (slBps / 10_000);
          const shouldSL = this.scalpSide === "buy"
            ? this.currentPrice <= scalpEntry.price - slDistance
            : this.currentPrice >= scalpEntry.price + slDistance;

          if (shouldSL) {
            log(this.db, "warn", `[Scalp SL] Hit @ $${this.currentPrice.toFixed(this.priceDecimals)}`);
            const slLoss = scalpEntry.price * parseFloat(scalpEntry.size) * (slBps / 10_000);
            this.stats.totalPnL -= slLoss;
            this.stats.sessionPnL -= slLoss;
            await this.cancelScalpOrders();
          }
        }
      }

    } catch (err: unknown) {
      if (err instanceof AuthError) {
        this.session = null;
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        log(this.db, "warn", `[Protection] Error: ${msg}`);
      }
    }

    if (this.running) {
      setTimeout(() => this.protectionCheckLoop(), PROTECTION_POLL_MS);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  INDICATORS
  // ══════════════════════════════════════════════════════════════════════════

  private async refreshIndicators(): Promise<void> {
    try {
      const [klines1h, klines5m] = await Promise.all([
        getBinanceKlines(this.config.pair, "1h", 250),
        getBinanceKlines(this.config.pair, "5m", 10),
      ]);

      if (klines1h.length >= 50) {
        this.indicators = calculateIndicators(klines1h);
        log(
          this.db,
          "info",
          `[Ind] Phase: ${this.indicators.marketPhase} | Score: ${this.indicators.marketScore} | ADX: ${this.indicators.adx?.adx.toFixed(1) ?? "N/A"} | Vol: ${((this.indicators.volatilityRatio ?? 0) * 100).toFixed(2)}%`
        );
      }

      if (klines5m.length > 0) {
        this.currentPrice = klines5m.at(-1)!.close;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(this.db, "warn", `[Ind] Error: ${msg}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  METRICS
  // ══════════════════════════════════════════════════════════════════════════

  private printMetrics(): void {
    const metrics = calculatePerformanceMetrics(this.stats, this.config.totalInvestment);

    log(
      this.db,
      "info",
      `[Stats] Vol: $${this.stats.totalVolume.toFixed(0)} | ` +
      `Trades: ${this.stats.totalTrades} | ` +
      `PnL: $${this.stats.totalPnL.toFixed(4)} | ` +
      `Cycles: ${this.stats.spreadCycles} | ` +
      `Vol/hr: $${metrics.volumePerHour.toFixed(0)} | ` +
      `Vol/day est: $${metrics.volumePerDay.toFixed(0)} | ` +
      `Regime: ${this.regime}`
    );

    this.persistStats();
  }

  private persistStats(): void {
    this.db.setMetric("total_volume", this.stats.totalVolume);
    this.db.setMetric("total_trades", this.stats.totalTrades);
    this.db.setMetric("total_pnl", this.stats.totalPnL);
    this.db.setMetric("spread_cycles", this.stats.spreadCycles);
    this.db.setMetric("scalp_trades", this.stats.scalpTrades);
    this.db.setMetric("session_pnl", this.stats.sessionPnL);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  CANCEL HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  private async cancelAllTracked(): Promise<void> {
    const session = await this.ensureSession();
    const subAccountId = process.env.GRVT_SUB_ACCOUNT_ID!;

    try {
      await grvtCancelAll(session, subAccountId, this.config.pair);
      for (const order of this.trackedOrders) {
        this.db.updateOrderStatus(order.orderId, "cancelled", Date.now());
      }
      this.trackedOrders = [];
      this.hasOpenScalp = false;
      this.scalpSide = null;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(this.db, "error", `[Cancel] Error: ${msg}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  EMERGENCY STOP
  // ══════════════════════════════════════════════════════════════════════════

  async emergencyStop(): Promise<void> {
    log(this.db, "warn", "Emergency stop — cancelling all orders...");
    this.running = false;

    try {
      await this.cancelAllTracked();
      log(this.db, "success", "All orders cancelled.");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(this.db, "error", `Error cancelling orders: ${msg}`);
    }

    this.printMetrics();
    this.db.setConfig("bot_status", "stopped");
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  START
  // ══════════════════════════════════════════════════════════════════════════

  async start(): Promise<void> {
    log(this.db, "info", `Starting VolumeEngine for ${this.config.pair}...`);

    const subAccountId = process.env.GRVT_SUB_ACCOUNT_ID;
    if (!subAccountId) throw new Error("GRVT_SUB_ACCOUNT_ID not set");

    await this.initialize();

    this.running = true;
    this.db.setConfig("bot_status", "running");
    this.db.setConfig("last_start", Date.now());

    log(this.db, "success", "Volume bot active. Starting polling loops...\n");

    this.orderPollingLoop();
    await sleep(1_000);
    this.regimeDetectionLoop();
    await sleep(1_000);
    this.protectionCheckLoop();

    // Keep alive
    await new Promise<void>((resolve) => {
      const id = setInterval(() => {
        if (!this.running) {
          clearInterval(id);
          resolve();
        }
      }, 1_000);
    });
  }

  async stop(): Promise<void> {
    log(this.db, "info", "Shutdown requested...");
    await this.emergencyStop();
    this.db.close();
  }
}
