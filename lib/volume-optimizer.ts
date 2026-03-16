/**
 * lib/volume-optimizer.ts — Volume Optimizer Strategy
 *
 * Estrategia diseñada para maximizar volumen de trading semanal
 * mientras preserva el capital y busca PnL break-even o positivo.
 *
 * Tres modos de operación que se seleccionan automáticamente:
 *   1. SPREAD_CAPTURE — Mercado lateral: grilla ultracompacta alrededor del mid price
 *   2. SCALP_TREND   — Mercado en tendencia: órdenes direccionales rápidas
 *   3. PAUSE         — Volatilidad extrema: proteger capital
 *
 * Principio clave: reutilizar el mismo margen con ciclos rápidos.
 * Con $50 @ 10x leverage → $500 nocional por ciclo.
 * Si completas 100 ciclos/día → $50,000 de volumen diario.
 */

import type { IndicatorsResult } from "./indicators";

// ─── Configuración ──────────────────────────────────────────────────────────

export interface VolumeConfig {
  pair: string;                     // "BTC_USDT_Perp", "ETH_USDT_Perp"
  totalInvestment: number;          // capital real en USDC (ej: 50-100)
  leverage: number;                 // ej: 10 (máximo volumen por dólar)

  // ── Spread Capture ─────────────────────────────────────────────────────────
  /** Número de pares bid/ask simultáneos (default 3) */
  spreadPairs: number;
  /** Offset mínimo del mid price en bps (1 bp = 0.01%) (default 2) */
  spreadOffsetBps: number;
  /** Separación entre niveles en bps (default 3) */
  spreadStepBps: number;
  /** Tiempo máximo para que una orden se llene antes de cancelar y replantear (ms) (default 30000) */
  orderStalenessMs: number;

  // ── Scalp Trend ────────────────────────────────────────────────────────────
  /** Take profit en bps para scalp direccional (default 8) */
  scalpTpBps: number;
  /** Stop loss en bps para scalp direccional (default 5) */
  scalpSlBps: number;
  /** Máximas operaciones de scalp simultáneas (default 1) */
  maxScalpPositions: number;

  // ── Capital Protection ─────────────────────────────────────────────────────
  /** Drawdown máximo antes de pausar todo (%) (default 3) */
  maxDrawdownPct: number;
  /** Pérdida máxima por sesión en USDC (default: totalInvestment * 0.05) */
  maxSessionLossUsdc: number;
  /** Volatility ratio máximo antes de pausar (default 0.04 = 4%) */
  maxVolatilityRatio: number;
  /** Porcentaje máximo de capital expuesto en posiciones abiertas (default 50) */
  maxExposurePct: number;

  // ── Adaptive Grid ──────────────────────────────────────────────────────────
  /** Reajustar grid cada N segundos (default 60) */
  gridRecenterIntervalMs: number;
  /** Multiplicador de ATR para ancho de grilla (default 0.3 — grilla muy compacta) */
  gridAtrMult: number;

  // ── Take Profit / Stop Loss ─────────────────────────────────────────────────
  /**
   * Take profit de sesión: detiene el bot cuando el PnL acumulado supera
   * este % del capital invertido. 0 = deshabilitado. (default 5 = +5%)
   */
  sessionTpPct: number;
  /**
   * Stop loss por posición individual en bps (1 bp = 0.01%).
   * Cierra la posición con reduce-only si el precio se aleja más de este %
   * desde el entry_price. 0 = deshabilitado. (default 20 = 0.2%)
   */
  spreadSlBps: number;
}

/** Valores por defecto optimizados para volumen con capital pequeño */
export function defaultVolumeConfig(
  pair: string,
  totalInvestment: number,
  leverage = 10
): VolumeConfig {
  return {
    pair,
    totalInvestment,
    leverage,
    spreadPairs: 3,
    spreadOffsetBps: 2,
    spreadStepBps: 3,
    orderStalenessMs: 30_000,
    scalpTpBps: 8,
    scalpSlBps: 5,
    maxScalpPositions: 1,
    maxDrawdownPct: 3,
    maxSessionLossUsdc: totalInvestment * 0.05,
    maxVolatilityRatio: 0.04,
    maxExposurePct: 50,
    gridRecenterIntervalMs: 60_000,
    gridAtrMult: 0.3,
    sessionTpPct: 5,
    spreadSlBps: 20,
  };
}

// ─── Market Regime Detection ────────────────────────────────────────────────

export type MarketRegime = "RANGING" | "TRENDING_UP" | "TRENDING_DOWN" | "VOLATILE_PAUSE";

/**
 * Detecta el régimen de mercado para decidir qué sub-estrategia usar.
 *
 * RANGING (lateral):
 *   ADX < 20 AND volatilityRatio < maxVol → SPREAD_CAPTURE (grilla compacta)
 *
 * TRENDING_UP/DOWN:
 *   ADX > 25 AND EMA21 vs EMA50 confirma dirección → SCALP_TREND
 *
 * VOLATILE_PAUSE:
 *   volatilityRatio > maxVol OR freefall → PAUSE (proteger capital)
 */
export function detectMarketRegime(
  indicators: IndicatorsResult,
  maxVolatilityRatio: number
): MarketRegime {
  const { adx, volatilityRatio, isFreefalling, marketPhase } = indicators;

  // Volatilidad extrema o colapso → pausar
  if (
    isFreefalling ||
    marketPhase === "COLLAPSE" ||
    (volatilityRatio !== null && volatilityRatio > maxVolatilityRatio)
  ) {
    return "VOLATILE_PAUSE";
  }

  // ADX bajo → mercado lateral → ideal para spread capture
  if (adx && !adx.trending) {
    return "RANGING";
  }

  // ADX alto con dirección → scalping direccional
  if (adx && adx.trending) {
    return adx.bullishTrend ? "TRENDING_UP" : "TRENDING_DOWN";
  }

  return "RANGING";
}

// ─── Spread Capture Orders ──────────────────────────────────────────────────

export interface SpreadOrder {
  price: number;
  side: "buy" | "sell";
  size: string;
  /** Tag para identificar el par al que pertenece */
  pairIndex: number;
}

/**
 * Genera pares de órdenes bid/ask alrededor del mid price.
 *
 * Ejemplo con midPrice=$2000, offsetBps=2, stepBps=3, pairs=3:
 *   BUY  @ $1999.60 (mid - 2bps)       SELL @ $2000.40 (mid + 2bps)
 *   BUY  @ $1999.00 (mid - 5bps)       SELL @ $2001.00 (mid + 5bps)
 *   BUY  @ $1998.40 (mid - 8bps)       SELL @ $2001.60 (mid + 8bps)
 *
 * Si ambos lados de un par se llenan → volumen generado + spread capturado.
 * Spread capturado por par ≈ 2 * offsetBps del nocional.
 */
export function generateSpreadOrders(
  midPrice: number,
  config: VolumeConfig,
  sizeDecimals: number,
  priceDecimals: number,
  minSize: number
): SpreadOrder[] {
  const orders: SpreadOrder[] = [];
  const sizePerPair = calculateVolumeOrderSize(
    config.totalInvestment,
    config.spreadPairs,
    midPrice,
    sizeDecimals,
    config.leverage
  );

  if (parseFloat(sizePerPair) < minSize) return orders;

  for (let i = 0; i < config.spreadPairs; i++) {
    const offsetBps = config.spreadOffsetBps + config.spreadStepBps * i;
    const offset = midPrice * (offsetBps / 10_000);

    const buyPrice = parseFloat((midPrice - offset).toFixed(priceDecimals));
    const sellPrice = parseFloat((midPrice + offset).toFixed(priceDecimals));

    orders.push({ price: buyPrice, side: "buy", size: sizePerPair, pairIndex: i });
    orders.push({ price: sellPrice, side: "sell", size: sizePerPair, pairIndex: i });
  }

  return orders;
}

/**
 * Tamaño de orden para volumen: divide el capital entre pares activos.
 * Usa leverage completo para maximizar nocional por ciclo.
 */
export function calculateVolumeOrderSize(
  totalInvestment: number,
  activePairs: number,
  price: number,
  sizeDecimals: number,
  leverage: number
): string {
  const marginPerPair = totalInvestment / activePairs;
  const notional = marginPerPair * leverage;
  const size = notional / price;
  const factor = 10 ** sizeDecimals;
  const floored = Math.floor(size * factor) / factor;
  return floored.toFixed(sizeDecimals);
}

// ─── Scalp Orders ───────────────────────────────────────────────────────────

export interface ScalpSignal {
  side: "buy" | "sell";
  entryPrice: number;
  tpPrice: number;
  slPrice: number;
  size: string;
}

/**
 * Genera una señal de scalp direccional basada en la tendencia detectada.
 *
 * En TRENDING_UP: abre long al precio actual, TP y SL en bps.
 * En TRENDING_DOWN: abre short al precio actual, TP y SL en bps.
 *
 * El tamaño usa una fracción conservadora del capital (25%) para no
 * bloquear todo el margen en una sola operación.
 */
export function generateScalpSignal(
  currentPrice: number,
  regime: "TRENDING_UP" | "TRENDING_DOWN",
  config: VolumeConfig,
  sizeDecimals: number,
  priceDecimals: number,
  minSize: number
): ScalpSignal | null {
  const capitalForScalp = config.totalInvestment * 0.25;
  const size = calculateVolumeOrderSize(
    capitalForScalp,
    1,
    currentPrice,
    sizeDecimals,
    config.leverage
  );

  if (parseFloat(size) < minSize) return null;

  const tpOffset = currentPrice * (config.scalpTpBps / 10_000);
  const slOffset = currentPrice * (config.scalpSlBps / 10_000);

  if (regime === "TRENDING_UP") {
    return {
      side: "buy",
      entryPrice: currentPrice,
      tpPrice: parseFloat((currentPrice + tpOffset).toFixed(priceDecimals)),
      slPrice: parseFloat((currentPrice - slOffset).toFixed(priceDecimals)),
      size,
    };
  } else {
    return {
      side: "sell",
      entryPrice: currentPrice,
      tpPrice: parseFloat((currentPrice - tpOffset).toFixed(priceDecimals)),
      slPrice: parseFloat((currentPrice + slOffset).toFixed(priceDecimals)),
      size,
    };
  }
}

// ─── Adaptive Grid ──────────────────────────────────────────────────────────

/**
 * Calcula un rango de grilla ultra-compacto basado en ATR.
 *
 * Más compacto que el grid normal (gridAtrMult=0.3 vs 2.0):
 *   - Más fills por hora
 *   - Más volumen generado
 *   - Spread capture más eficiente
 *
 * Si la volatilidad aumenta, el grid se amplía automáticamente.
 * Si la volatilidad baja, se comprime para capturar más micro-movimientos.
 */
export function calculateAdaptiveRange(
  midPrice: number,
  atr14: number | null,
  gridAtrMult: number
): { lower: number; upper: number; halfWidth: number } {
  const halfWidth = atr14
    ? atr14 * gridAtrMult
    : midPrice * 0.002; // fallback: ±0.2%

  return {
    lower: midPrice - halfWidth,
    upper: midPrice + halfWidth,
    halfWidth,
  };
}

// ─── Capital Protection ─────────────────────────────────────────────────────

export interface ProtectionState {
  sessionPnL: number;
  maxEquity: number;
  currentEquity: number;
  totalExposure: number;
  isPaused: boolean;
  pauseReason: string | null;
}

/**
 * Evalúa si debe pausarse la operación por protección de capital.
 * Retorna el motivo si debe pausarse, null si está ok.
 */
export function checkProtection(
  config: VolumeConfig,
  state: ProtectionState
): string | null {
  // Drawdown kill switch
  if (state.maxEquity > 0) {
    const drawdown = ((state.maxEquity - state.currentEquity) / state.maxEquity) * 100;
    if (drawdown >= config.maxDrawdownPct) {
      return `Drawdown ${drawdown.toFixed(1)}% >= ${config.maxDrawdownPct}%`;
    }
  }

  // Session loss limit
  if (state.sessionPnL < 0 && Math.abs(state.sessionPnL) >= config.maxSessionLossUsdc) {
    return `Pérdida sesión $${Math.abs(state.sessionPnL).toFixed(2)} >= máx $${config.maxSessionLossUsdc.toFixed(2)}`;
  }

  // Max exposure
  if (state.currentEquity > 0) {
    const exposurePct = (state.totalExposure / state.currentEquity) * 100;
    if (exposurePct >= config.maxExposurePct) {
      return `Exposición ${exposurePct.toFixed(0)}% >= ${config.maxExposurePct}%`;
    }
  }

  return null;
}

// ─── Volume Tracking ────────────────────────────────────────────────────────

export interface VolumeStats {
  totalVolume: number;       // USDC nocional total
  totalTrades: number;       // número de fills
  totalPnL: number;          // P&L realizado acumulado
  spreadCycles: number;      // ciclos spread completados (ambos lados)
  scalpTrades: number;       // trades de scalp
  startTime: number;         // timestamp de inicio
  sessionPnL: number;        // P&L desde último reset
}

export function createVolumeStats(): VolumeStats {
  return {
    totalVolume: 0,
    totalTrades: 0,
    totalPnL: 0,
    spreadCycles: 0,
    scalpTrades: 0,
    startTime: Date.now(),
    sessionPnL: 0,
  };
}

/**
 * Registra un fill en las estadísticas de volumen.
 */
export function recordFill(
  stats: VolumeStats,
  fillPrice: number,
  fillSize: string,
  pnl: number
): VolumeStats {
  const notional = fillPrice * parseFloat(fillSize);
  return {
    ...stats,
    totalVolume: stats.totalVolume + notional,
    totalTrades: stats.totalTrades + 1,
    totalPnL: stats.totalPnL + pnl,
    sessionPnL: stats.sessionPnL + pnl,
  };
}

// ─── Métricas de Rendimiento ────────────────────────────────────────────────

export interface PerformanceMetrics {
  volumePerHour: number;
  volumePerDay: number;
  volumePerWeek: number;
  tradesPerHour: number;
  avgPnLPerTrade: number;
  capitalEfficiency: number;  // volume / capital invested
  uptimeHours: number;
}

export function calculatePerformanceMetrics(
  stats: VolumeStats,
  capital: number
): PerformanceMetrics {
  const uptimeMs = Date.now() - stats.startTime;
  const uptimeHours = Math.max(uptimeMs / 3_600_000, 0.001); // min 1 sec to avoid division by 0

  const volumePerHour = stats.totalVolume / uptimeHours;
  const tradesPerHour = stats.totalTrades / uptimeHours;

  return {
    volumePerHour,
    volumePerDay: volumePerHour * 24,
    volumePerWeek: volumePerHour * 24 * 7,
    tradesPerHour,
    avgPnLPerTrade: stats.totalTrades > 0 ? stats.totalPnL / stats.totalTrades : 0,
    capitalEfficiency: capital > 0 ? stats.totalVolume / capital : 0,
    uptimeHours,
  };
}

// ─── Order Staleness ────────────────────────────────────────────────────────

/**
 * Determina si las órdenes actuales deben cancelarse y replantearse
 * porque el precio se movió significativamente desde que se colocaron.
 *
 * Criterio: si el mid price actual está fuera del rango medio del grid,
 * o si las órdenes llevan más de orderStalenessMs sin llenarse.
 */
export function shouldRecenterGrid(
  currentMidPrice: number,
  gridCenter: number,
  gridHalfWidth: number,
  oldestOrderTime: number,
  stalenessMs: number
): boolean {
  // Precio se movió más del 50% del ancho del grid → recentrar
  const drift = Math.abs(currentMidPrice - gridCenter);
  if (drift > gridHalfWidth * 0.5) return true;

  // Órdenes demasiado viejas sin llenarse → refrescar
  if (Date.now() - oldestOrderTime > stalenessMs) return true;

  return false;
}

// ─── Estimaciones de Volumen ────────────────────────────────────────────────

/**
 * Estimación teórica de volumen con capital dado.
 *
 * Modelo conservador:
 *   - Cada ciclo spread genera 2x el nocional (buy + sell)
 *   - Con mercado lateral, ~2-4 ciclos/hora por par
 *   - Con $50 @ 10x, nocional por par = $167 (3 pares)
 *   - Volumen por ciclo = $167 * 2 = $334
 *   - 3 ciclos/hora * 3 pares = 9 ciclos/hora
 *   - $334 * 9 = ~$3,000/hora = ~$72,000/día
 *
 * Modelo realista (50% fill rate):
 *   - ~$36,000/día = ~$252,000/semana
 *
 * Con scalp adicional durante tendencias:
 *   - +$5,000-10,000/día extra
 */
export function estimateVolume(
  capital: number,
  leverage: number,
  spreadPairs: number,
  cyclesPerHourPerPair = 3,
  fillRatePct = 50
): {
  nocionalPerPair: number;
  volumePerCyclePerPair: number;
  cyclesPerHour: number;
  volumePerHour: number;
  volumePerDay: number;
  volumePerWeek: number;
  tradesPerDay: number;
} {
  const nocionalPerPair = (capital * leverage) / spreadPairs;
  const volumePerCyclePerPair = nocionalPerPair * 2; // buy + sell
  const totalCyclesPerHour = cyclesPerHourPerPair * spreadPairs;
  const effectiveCycles = totalCyclesPerHour * (fillRatePct / 100);
  const volumePerHour = volumePerCyclePerPair * effectiveCycles;

  return {
    nocionalPerPair,
    volumePerCyclePerPair,
    cyclesPerHour: effectiveCycles,
    volumePerHour,
    volumePerDay: volumePerHour * 24,
    volumePerWeek: volumePerHour * 24 * 7,
    tradesPerDay: effectiveCycles * 2 * 24, // 2 fills per cycle
  };
}
