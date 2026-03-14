/**
 * scripts/grid-engine.ts — Motor de Grid Trading 24/7 (standalone Node.js)
 *
 * Diseño:
 *   • Tres bucles paralelos independientes (orders / position / indicators)
 *   • Cada bucle usa setTimeout recursivo (nunca se apila si la llamada API tarda)
 *   • withRetry() aplica backoff exponencial con jitter en errores de red
 *   • La sesión GRVT se renueva automáticamente cada 50 min
 *   • SQLite guarda cada orden antes de enviarla al exchange (crash-safe)
 *   • Al reiniciar, reconcileOrders() detecta fills ocurridos durante el downtime
 *     y coloca las contra-órdenes pendientes antes de reanudar el polling
 */

import * as dotenv from "dotenv";
dotenv.config();

import {
  loginWithApiKey,
  getOpenOrders,
  createOrder,
  cancelAllOrders as grvtCancelAll,
  getPositions,
  getSubAccountSummary,
  getInstrumentInfo,
  getBinanceKlines,
  type GrvtSession,
} from "../lib/grvt-api";

import { signLimitOrder } from "../lib/eip712";

import {
  calculateGridLevels,
  getInitialOrders,
  getCounterOrder,
  calculateMaxGrids,
  detectMarketBias,
  getGridDirection,
  calculateTrailingStop,
  calculateDrawdown,
  shouldKillSwitch,
  type GridConfig,
  type MarketBias,
} from "../lib/grid-bot";

import { calculateIndicators, type IndicatorsResult } from "../lib/indicators";
import { BotDatabase, type DbOrder } from "./db";

// ─── Constantes ───────────────────────────────────────────────────────────────

const ORDER_POLL_MS      = 3_000;   // Poll fills cada 3 s
const POSITION_POLL_MS   = 5_000;   // Poll posición / drawdown / trailing stop cada 5 s
const INDICATORS_POLL_MS = 60_000;  // Actualizar indicadores cada 60 s
const SESSION_TTL_MS     = 50 * 60 * 1_000; // Renovar sesión a los 50 min

const RETRY_BASE_MS      = 1_000;
const RETRY_MAX_MS       = 60_000;
const RETRY_MAX_ATTEMPTS = 8;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Prefijos visuales para la consola */
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

/**
 * Ejecuta fn con reintentos exponenciales + jitter.
 * Rate-limit (429) → espera fija 60 s.
 * Auth error (403/401) → lanza AuthError después de 2 intentos para que
 *   el llamador limpie la sesión y reintente.
 */
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
      const isAuth      = message.includes("403") || message.includes("401");

      if (attempt >= maxAttempts) {
        log(db, "error", `[${label}] Máx reintentos (${maxAttempts}) alcanzados: ${message}`);
        throw err;
      }

      if (isAuth && attempt >= 2) {
        throw new AuthError("Session expired");
      }

      const delay = isRateLimit
        ? 60_000
        : Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS) + Math.random() * 1_000;

      log(
        db,
        "warn",
        `[${label}] Intento ${attempt}/${maxAttempts} falló (${message}). Reintentando en ${Math.round(delay / 1_000)}s`
      );
      await sleep(delay);
    }
  }
}

class AuthError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "AuthError";
  }
}

// ─── GridEngine ───────────────────────────────────────────────────────────────

export class GridEngine {
  private config: GridConfig;
  private db: BotDatabase;

  // Sesión GRVT
  private session: GrvtSession | null = null;
  private sessionTime = 0;

  // Ciclo de vida
  private running = false;

  // Metadatos del instrumento
  private levels: number[]   = [];
  private priceDecimals      = 2;
  private sizeDecimals       = 2;
  private minSize            = 0.01;
  private instrumentHash     = "";

  // Estado de mercado
  private currentPrice       = 0;
  private indicators: IndicatorsResult | null = null;
  private marketBias: MarketBias              = "NEUTRAL";

  // Risk management
  private trailingStopPrice: number | null = null;
  private peakPrice: number | null         = null;
  private troughPrice: number | null       = null;
  private maxEquity                        = 0;

  // Stats
  private totalPnL     = 0;
  private filledOrders = 0;

  constructor(config: GridConfig, dbPath: string) {
    this.config = { ...config };
    this.db     = new BotDatabase(dbPath);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SESIÓN
  // ══════════════════════════════════════════════════════════════════════════

  private async ensureSession(): Promise<GrvtSession> {
    const expired = Date.now() - this.sessionTime > SESSION_TTL_MS;
    if (this.session && !expired) return this.session;

    log(this.db, "info", "Autenticando con GRVT...");
    const apiKey = process.env.GRVT_API_KEY;
    if (!apiKey) throw new Error("GRVT_API_KEY no configurada");

    this.session     = await loginWithApiKey(apiKey);
    this.sessionTime = Date.now();
    log(this.db, "success", `Sesión establecida. Account: ${this.session.accountId}`);
    return this.session;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  COLOCAR ORDEN CON FIRMA EIP-712
  // ══════════════════════════════════════════════════════════════════════════

  private async placeLimitOrder(
    price: number,
    side: "buy" | "sell",
    size: string,
    levelIndex: number,
    reduceOnly = false
  ): Promise<string | null> {
    const privateKey    = process.env.GRVT_PRIVATE_KEY_EIP712;
    const subAccountId  = process.env.GRVT_SUB_ACCOUNT_ID;
    const useTestnet    = process.env.GRVT_USE_TESTNET === "true";

    if (!privateKey || !subAccountId) throw new Error("Credenciales incompletas");

    const priceStr = price.toFixed(this.priceDecimals);
    const sizeStr  = parseFloat(size).toFixed(this.sizeDecimals);

    // ① Insertar como 'pending' ANTES de enviar al exchange.
    //    Si el proceso muere aquí, recover() lo detectará como pending sin order_id
    //    y lo descartará (no se duplicará).
    const dbId = this.db.insertOrder({
      pair:             this.config.pair,
      level_index:      levelIndex,
      price,
      side,
      size:             sizeStr,
      order_id:         null,
      client_order_id:  null,
      status:           "pending",
      counter_placed:   0,
      created_at:       Date.now(),
      filled_at:        null,
    });

    try {
      const session = await this.ensureSession();

      const signed = await signLimitOrder({
        subAccountId,
        instrument:   this.config.pair,
        instrumentId: this.instrumentHash,
        size:         sizeStr,
        limitPrice:   priceStr,
        isBuying:     side === "buy",
        reduceOnly,
        privateKey,
        useTestnet,
      });

      const result  = await createOrder(session, signed);
      const orderId = result.order_id;

      // ② Actualizar con el order_id real → status 'open'
      this.db.updateOrderId(dbId, orderId, "open");

      log(this.db, "success", `[Orden] ${side.toUpperCase()} ${sizeStr} @ $${priceStr} → ID: ${orderId}`);
      return orderId;

    } catch (err: unknown) {
      // Marcar como cancelada para que no bloquee reconciliación futura
      this.db.updateOrderId(dbId, `failed_${dbId}`, "cancelled");
      const msg = err instanceof Error ? err.message : String(err);
      log(this.db, "error", `[Orden] Error al colocar ${side} @ $${priceStr}: ${msg}`);
      return null;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  INICIALIZACIÓN (primera ejecución)
  // ══════════════════════════════════════════════════════════════════════════

  private async initialize(): Promise<void> {
    log(this.db, "info", `Inicializando grid para ${this.config.pair}...`);

    this.db.setConfig("grid_config", this.config);
    this.db.setConfig("start_time", Date.now());

    // Metadatos del instrumento
    const info = await withRetry(
      () => getInstrumentInfo(this.config.pair),
      "InstrumentInfo",
      this.db,
      5
    );
    this.instrumentHash = info.instrumentHash;
    this.priceDecimals  = info.priceDecimals;
    this.sizeDecimals   = info.sizeDecimals;
    this.minSize        = parseFloat(info.minSize);

    // Precio actual (última vela 1m de Binance)
    const klines = await getBinanceKlines(this.config.pair, "1m", 3);
    this.currentPrice = klines.at(-1)?.close ?? 0;
    if (!this.currentPrice) throw new Error("No se pudo obtener el precio actual");
    log(this.db, "info", `Precio actual: $${this.currentPrice}`);

    // Balance inicial
    const session = await this.ensureSession();
    const subAccountId = process.env.GRVT_SUB_ACCOUNT_ID!;
    const balance  = await getSubAccountSummary(session, subAccountId);
    this.maxEquity = parseFloat(balance.equity);
    this.db.setMetric("max_equity",      this.maxEquity);
    this.db.setMetric("initial_equity",  this.maxEquity);
    log(this.db, "info", `Equity inicial: $${this.maxEquity.toFixed(2)}`);

    // Indicadores (primer cálculo)
    await this.refreshIndicators();

    // Auto-reducir grids si el tamaño de orden quedaría por debajo de min_size
    const safeGridCount = calculateMaxGrids(
      this.config.totalInvestment,
      this.config.gridCount,
      this.currentPrice,
      this.minSize,
      this.config.leverage
    );
    if (safeGridCount !== this.config.gridCount) {
      log(this.db, "warn", `Grid reducido ${this.config.gridCount} → ${safeGridCount} (min_size constraint)`);
      this.config.gridCount = safeGridCount;
    }

    // Calcular niveles de grilla
    this.levels = calculateGridLevels(
      this.config.lowerPrice,
      this.config.upperPrice,
      this.config.gridCount,
      this.config.gridType
    );

    const direction = getGridDirection(this.config.strategyMode, this.marketBias);
    log(this.db, "info", `Niveles: ${this.levels.length} | Dirección: ${direction} | Bias: ${this.marketBias}`);

    // Órdenes iniciales
    const initialOrders = getInitialOrders(
      this.levels,
      this.currentPrice,
      this.config.totalInvestment,
      this.config.gridCount,
      this.sizeDecimals,
      this.config.leverage,
      direction
    );

    log(this.db, "info", `Colocando ${initialOrders.length} órdenes iniciales...`);

    for (const order of initialOrders) {
      await withRetry(
        () => this.placeLimitOrder(
          order.price,
          order.type,
          order.size,
          this.levels.indexOf(order.price)
        ),
        `Init_${order.type}_${order.price}`,
        this.db,
        5
      );
      await sleep(150); // Pequeña pausa entre órdenes para no saturar la API
    }

    log(this.db, "success", `Grid inicializado con ${initialOrders.length} órdenes`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  RECUPERACIÓN (reinicio tras caída)
  // ══════════════════════════════════════════════════════════════════════════

  private async recover(): Promise<boolean> {
    const savedConfig = this.db.getConfig<GridConfig>("grid_config");
    if (!savedConfig) return false;

    log(this.db, "info", "Estado anterior encontrado. Recuperando...");

    // Restaurar configuración preservando overrides del archivo actual
    this.config = { ...savedConfig, ...this.config };

    // Restaurar métricas
    this.totalPnL           = this.db.getMetric("total_pnl", 0);
    this.filledOrders       = this.db.getMetric("filled_orders", 0);
    this.maxEquity          = this.db.getMetric("max_equity", 0);
    this.trailingStopPrice  = this.db.getMetric("trailing_stop_price", null);
    this.peakPrice          = this.db.getMetric("peak_price", null);
    this.troughPrice        = this.db.getMetric("trough_price", null);

    // Re-obtener metadatos del instrumento
    const info = await withRetry(
      () => getInstrumentInfo(this.config.pair),
      "InstrumentInfo",
      this.db,
      5
    );
    this.instrumentHash = info.instrumentHash;
    this.priceDecimals  = info.priceDecimals;
    this.sizeDecimals   = info.sizeDecimals;
    this.minSize        = parseFloat(info.minSize);

    // Reconstruir array de niveles desde la config guardada
    this.levels = calculateGridLevels(
      this.config.lowerPrice,
      this.config.upperPrice,
      this.config.gridCount,
      this.config.gridType
    );

    // Reconciliar órdenes con el exchange
    await this.reconcileOrders();

    log(
      this.db,
      "success",
      `Recuperación completa. PnL: $${this.totalPnL.toFixed(4)} | Fills totales: ${this.filledOrders}`
    );
    return true;
  }

  /**
   * Compara las órdenes 'open' en la DB contra el exchange.
   * Las que ya no estén en el exchange fueron llenadas durante el downtime:
   *   → las marca como 'filled' y coloca la contra-orden si no se hizo aún.
   */
  private async reconcileOrders(): Promise<void> {
    log(this.db, "info", "Reconciliando órdenes con el exchange...");

    const session       = await this.ensureSession();
    const subAccountId  = process.env.GRVT_SUB_ACCOUNT_ID!;

    const exchangeOrders = await withRetry(
      () => getOpenOrders(session, subAccountId, this.config.pair),
      "ReconcileOrders",
      this.db,
      5
    );

    const liveIds    = new Set(exchangeOrders.map((o) => o.id));
    const dbOpenOrders = this.db.getOpenOrders(this.config.pair);

    let filledDuringDowntime = 0;

    for (const order of dbOpenOrders) {
      if (!order.order_id) continue;

      if (!liveIds.has(order.order_id)) {
        // Llenada mientras el bot estaba caído
        log(
          this.db,
          "info",
          `[Reconcile] ${order.side.toUpperCase()} @ $${order.price} (ID: ${order.order_id}) fue llenada durante downtime`
        );
        this.db.updateOrderStatus(order.order_id, "filled", Date.now());
        filledDuringDowntime++;

        if (!order.counter_placed) {
          await this.placeCounterOrder(order);
          await sleep(150);
        }
      }
    }

    log(this.db, "info", `Reconciliación lista. Fills durante downtime: ${filledDuringDowntime}`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  CONTRA-ÓRDENES Y CÁLCULO DE P&L
  // ══════════════════════════════════════════════════════════════════════════

  private async placeCounterOrder(filledOrder: DbOrder): Promise<void> {
    const counter = getCounterOrder(
      filledOrder.price,
      filledOrder.side as "buy" | "sell",
      this.levels,
      this.config.totalInvestment,
      this.config.gridCount,
      this.sizeDecimals,
      this.config.leverage
    );

    if (!counter) {
      log(this.db, "warn", `[Counter] Sin nivel opuesto para ${filledOrder.side} @ $${filledOrder.price}`);
      return;
    }

    // P&L por ciclo (solo cuando se completa buy→sell)
    if (filledOrder.side === "buy") {
      const cyclePnl = (counter.price - filledOrder.price) * parseFloat(counter.size);
      this.totalPnL += cyclePnl;
      this.db.setMetric("total_pnl", this.totalPnL);
      log(
        this.db,
        "success",
        `[Fill] BUY @ $${filledOrder.price} → SELL @ $${counter.price.toFixed(this.priceDecimals)} | +$${cyclePnl.toFixed(4)} | PnL total: $${this.totalPnL.toFixed(4)}`
      );
    } else {
      log(
        this.db,
        "success",
        `[Fill] SELL @ $${filledOrder.price} → BUY @ $${counter.price.toFixed(this.priceDecimals)}`
      );
    }

    this.filledOrders++;
    this.db.setMetric("filled_orders", this.filledOrders);

    const orderId = await withRetry(
      () => this.placeLimitOrder(
        counter.price,
        counter.type,
        counter.size,
        this.levels.indexOf(counter.price)
      ),
      `Counter_${counter.type}_${counter.price}`,
      this.db,
      5
    );

    if (orderId && filledOrder.order_id) {
      this.db.markCounterPlaced(filledOrder.order_id);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  INDICADORES TÉCNICOS
  // ══════════════════════════════════════════════════════════════════════════

  private async refreshIndicators(): Promise<void> {
    try {
      const [klines1h, klines5m] = await Promise.all([
        getBinanceKlines(this.config.pair, "1h", 250),
        getBinanceKlines(this.config.pair, "5m",  10),
      ]);

      if (klines1h.length >= 50) {
        this.indicators = calculateIndicators(klines1h);
        this.marketBias = detectMarketBias(this.indicators);
        log(
          this.db,
          "info",
          `[Ind] Bias: ${this.marketBias} | Score: ${this.indicators.marketScore} | Fase: ${this.indicators.marketPhase} | Freefall: ${this.indicators.isFreefalling}`
        );
      }

      if (klines5m.length > 0) {
        this.currentPrice = klines5m.at(-1)!.close;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(this.db, "warn", `[Ind] Error actualizando indicadores: ${msg}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  BUCLE 1 — DETECCIÓN DE FILLS (cada 3 s)
  // ══════════════════════════════════════════════════════════════════════════

  private async orderPollingLoop(): Promise<void> {
    if (!this.running) return;

    try {
      const session      = await this.ensureSession();
      const subAccountId = process.env.GRVT_SUB_ACCOUNT_ID!;

      const exchangeOrders = await getOpenOrders(session, subAccountId, this.config.pair);
      const liveIds        = new Set(exchangeOrders.map((o) => o.id));

      const dbOpen = this.db.getOpenOrders(this.config.pair);

      for (const order of dbOpen) {
        if (!order.order_id) continue;

        if (!liveIds.has(order.order_id)) {
          // ¡Fill detectado!
          log(this.db, "info", `[Fill] Detectado: ${order.side.toUpperCase()} @ $${order.price} (ID: ${order.order_id})`);
          this.db.updateOrderStatus(order.order_id, "filled", Date.now());
          await this.placeCounterOrder(order);
        }
      }

    } catch (err: unknown) {
      if (err instanceof AuthError) {
        log(this.db, "warn", "[OrderPoll] Sesión expirada — re-autenticando...");
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

  // ══════════════════════════════════════════════════════════════════════════
  //  BUCLE 2 — POSICIÓN / DRAWDOWN / TRAILING STOP (cada 5 s)
  // ══════════════════════════════════════════════════════════════════════════

  private async positionPollingLoop(): Promise<void> {
    if (!this.running) return;

    try {
      const session      = await this.ensureSession();
      const subAccountId = process.env.GRVT_SUB_ACCOUNT_ID!;

      // ── Equity y drawdown ──────────────────────────────────────────────────
      const balance = await getSubAccountSummary(session, subAccountId);
      const equity  = parseFloat(balance.equity);

      if (equity > this.maxEquity) {
        this.maxEquity = equity;
        this.db.setMetric("max_equity", equity);
      }

      const drawdown = calculateDrawdown(equity, this.maxEquity);
      const maxDD    = this.config.maxDrawdownPct ?? 15;

      if (shouldKillSwitch(drawdown, maxDD)) {
        log(this.db, "error", `[KillSwitch] Drawdown ${drawdown.toFixed(1)}% ≥ ${maxDD}% → Deteniendo bot!`);
        await this.emergencyStop();
        return;
      }

      // ── Stop-Loss / Take-Profit estáticos ──────────────────────────────────
      if (this.currentPrice > 0) {
        if (this.config.stopLoss && this.currentPrice <= this.config.stopLoss) {
          log(this.db, "warn", `[SL] Activado @ $${this.currentPrice} (SL: $${this.config.stopLoss})`);
          await this.emergencyStop();
          return;
        }
        if (this.config.takeProfit && this.currentPrice >= this.config.takeProfit) {
          log(this.db, "success", `[TP] Activado @ $${this.currentPrice} (TP: $${this.config.takeProfit})`);
          await this.emergencyStop();
          return;
        }
      }

      // ── Trailing stop dinámico (requiere posición abierta) ─────────────────
      if (this.config.enableTrailingStop && this.indicators?.atr) {
        const positions = await getPositions(session, subAccountId, this.config.pair);
        const position  = positions.find((p) => p.instrument === this.config.pair) ?? null;

        if (position) {
          const posSize   = parseFloat(position.size);
          const markPrice = parseFloat(position.mark_price);
          const isLong    = posSize > 0;

          if (isLong) {
            const peakOrTrough = this.peakPrice ?? markPrice;
            const result = calculateTrailingStop(
              "long",
              markPrice,
              peakOrTrough,
              this.indicators.atr,
              this.config.trailingAtrMult ?? 2.0,
              this.trailingStopPrice
            );
            this.peakPrice         = result.newPeakOrTrough;
            this.trailingStopPrice = result.newTrailingStop;
            this.db.setMetric("peak_price",          this.peakPrice);
            this.db.setMetric("trailing_stop_price", this.trailingStopPrice);
            log(this.db, "info", `[TS] Peak: $${this.peakPrice.toFixed(this.priceDecimals)} | Stop: $${this.trailingStopPrice.toFixed(this.priceDecimals)}`);

            if (markPrice <= this.trailingStopPrice) {
              log(this.db, "warn", `[TS] Activado @ $${markPrice} (stop: $${this.trailingStopPrice.toFixed(this.priceDecimals)})`);
              await this.emergencyStop();
              return;
            }
          }
        }
      }

    } catch (err: unknown) {
      if (err instanceof AuthError) {
        this.session = null;
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        log(this.db, "warn", `[PosPoll] Error: ${msg}`);
      }
    }

    if (this.running) {
      setTimeout(() => this.positionPollingLoop(), POSITION_POLL_MS);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  BUCLE 3 — INDICADORES (cada 60 s)
  // ══════════════════════════════════════════════════════════════════════════

  private async indicatorsPollingLoop(): Promise<void> {
    if (!this.running) return;

    await this.refreshIndicators();

    if (this.running) {
      setTimeout(() => this.indicatorsPollingLoop(), INDICATORS_POLL_MS);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  STOP DE EMERGENCIA
  // ══════════════════════════════════════════════════════════════════════════

  async emergencyStop(): Promise<void> {
    log(this.db, "warn", "Stop de emergencia: cancelando todas las órdenes...");
    this.running = false;

    try {
      const session      = await this.ensureSession();
      const subAccountId = process.env.GRVT_SUB_ACCOUNT_ID!;
      await grvtCancelAll(session, subAccountId, this.config.pair);
      this.db.cancelAllOrders(this.config.pair);
      log(this.db, "success", "Todas las órdenes canceladas.");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(this.db, "error", `Error al cancelar órdenes: ${msg}`);
    }

    this.db.setConfig("bot_status", "stopped");
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  ARRANQUE PRINCIPAL
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * @param forceNew true → ignora el estado anterior y arranca desde cero
   */
  async start(forceNew = false): Promise<void> {
    log(this.db, "info", `Arrancando GridEngine para ${this.config.pair}...`);

    const subAccountId = process.env.GRVT_SUB_ACCOUNT_ID;
    if (!subAccountId) throw new Error("GRVT_SUB_ACCOUNT_ID no configurada");

    // Recuperar o inicializar
    let recovered = false;
    if (!forceNew) {
      recovered = await this.recover();
    }
    if (!recovered) {
      await this.initialize();
    }

    this.running = true;
    this.db.setConfig("bot_status",  "running");
    this.db.setConfig("last_start",  Date.now());

    log(this.db, "success", "Bot activo. Iniciando bucles de polling...\n");

    // Escalonar el arranque de los tres bucles para no saturar la API
    this.orderPollingLoop();
    await sleep(1_000);
    this.positionPollingLoop();
    await sleep(1_000);
    this.indicatorsPollingLoop();

    // Mantener el proceso vivo hasta que running = false
    await new Promise<void>((resolve) => {
      const id = setInterval(() => {
        if (!this.running) {
          clearInterval(id);
          resolve();
        }
      }, 1_000);
    });
  }

  // ── Shutdown limpio ────────────────────────────────────────────────────────

  async stop(): Promise<void> {
    log(this.db, "info", "Apagado solicitado...");
    await this.emergencyStop();
    this.db.close();
  }
}
