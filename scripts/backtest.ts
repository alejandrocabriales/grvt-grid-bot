/**
 * Backtest Mejorado — Versión con todas las protecciones
 *
 * Simula la estrategia completa incluyendo:
 * - Filtro de tendencia (EMA200)
 * - Operaciones LONG y SHORT
 * - Trailing Stop dinámico basado en ATR
 * - Max Drawdown Kill Switch
 * - Cooldown entre señales
 * - Filtro de volatilidad extrema
 * - Comparación con buy & hold
 *
 * Uso: npx tsx scripts/backtest.ts
 */

import {
  calculateIndicators,
  Kline,
  isHighVolatility,
  isOverbought,
  isOversold,
  rsiCrossUp,
  macdCrossDown,
  macdCrossUp,
} from "../lib/indicators";

import {
  detectMarketBiasLegacy,
  calculateTrailingStop,
  calculateDrawdown,
  shouldKillSwitch,
  canEmitSignal,
  SIGNAL_COOLDOWN_MS,
} from "../lib/grid-bot";

// ─── Fetch de datos históricos ─────────────────────────────────────────────

async function fetchKlines(symbol: string, interval: string, limit: number): Promise<Kline[]> {
  let allKlines: Kline[] = [];
  let endTime: number | undefined = undefined;

  while (allKlines.length < limit) {
    const fetchLimit = Math.min(1000, limit - allKlines.length);
    const url = new URL("https://api.binance.com/api/v3/klines");
    url.searchParams.append("symbol", symbol);
    url.searchParams.append("interval", interval);
    url.searchParams.append("limit", fetchLimit.toString());
    if (endTime) {
      url.searchParams.append("endTime", endTime.toString());
    }

    const res = await fetch(url.toString());
    const data = await res.json();

    const klines: Kline[] = data.map((d: any) => ({
      timestamp: d[0],
      open: parseFloat(d[1]),
      high: parseFloat(d[2]),
      low: parseFloat(d[3]),
      close: parseFloat(d[4]),
      volume: parseFloat(d[5]),
    }));

    allKlines = [...klines, ...allKlines];
    endTime = klines[0].timestamp - 1;

    if (klines.length < fetchLimit) break;
  }
  return allKlines;
}

// ─── Tipos internos del backtest ──────────────────────────────────────────

interface BacktestPosition {
  side: "LONG" | "SHORT";
  entryPrice: number;
  slPrice: number;
  size: number;
  peakPrice: number;     // Para trailing stop (long)
  troughPrice: number;   // Para trailing stop (short)
  trailingStop: number;
  entryTimestamp: number;
}

interface BacktestResult {
  initialCapital: number;
  finalBalance: number;
  totalTrades: number;
  wins: number;
  losses: number;
  maxDrawdown: number;
  tradesIgnoredByFilter: number;
  trailingStopHits: number;
  drawdownKills: number;
  buyAndHoldReturn: number;
}

// ─── Estrategia Principal ──────────────────────────────────────────────────

async function run() {
  console.log("=== BACKTEST MEJORADO ===");
  console.log("Descargando datos históricos...\n");

  // 30 días de velas de 5m = 8640 velas
  const klines = await fetchKlines("BTCUSDT", "5m", 8640);
  console.log(`Datos: ${klines.length} velas de 5m (${(klines.length * 5 / 60 / 24).toFixed(1)} días)`);
  console.log(`Rango: $${klines[0].close.toFixed(0)} → $${klines[klines.length - 1].close.toFixed(0)}\n`);

  // ─── Parámetros ──────────────────────────────────────────────────────

  const initialCapital = 1000;
  const riskPct = 1.5;         // % de riesgo por trade
  const atrMult = 1.5;         // multiplicador ATR para SL
  const trailingMult = 2.0;    // multiplicador ATR para trailing
  const maxDrawdownPct = 15;   // kill switch al 15%
  const cooldownBars = 60;     // 60 barras de 5m = 5 horas de cooldown

  // ─── Estado ──────────────────────────────────────────────────────────

  let balance = initialCapital;
  let maxEquity = initialCapital;
  let position: BacktestPosition | null = null;
  let trades = 0;
  let wins = 0;
  let losses = 0;
  let maxDrawdown = 0;
  let tradesIgnoredByFilter = 0;
  let trailingStopHits = 0;
  let drawdownKills = 0;
  let lastTradeBar = -cooldownBars; // Permitir trade inmediato al inicio
  let killed = false;

  // Buy & Hold para comparar
  const buyAndHoldStartPrice = klines[250].close;

  // ─── Loop Principal ──────────────────────────────────────────────────

  for (let i = 250; i < klines.length; i++) {
    if (killed) break;

    const window = klines.slice(0, i + 1);
    const currentKline = window[window.length - 1];
    const price = currentKline.close;
    const indicators = calculateIndicators(window);

    // Verificar datos suficientes
    if (!indicators.ema50 || !indicators.ema100 || !indicators.ema200 || !indicators.atr || indicators.rsi.length < 2 || indicators.macd.length < 2) {
      continue;
    }

    const atr = indicators.atr;
    const marketBias = detectMarketBiasLegacy(price, indicators.ema50, indicators.ema200, indicators.rsi);

    // ─── GESTIÓN DE POSICIÓN ABIERTA ─────────────────────────────────

    if (position) {
      // Actualizar trailing stop
      if (position.side === "LONG") {
        const result = calculateTrailingStop(
          "long", price, position.peakPrice, atr, trailingMult, position.trailingStop
        );
        position.peakPrice = result.newPeakOrTrough;
        position.trailingStop = result.newTrailingStop;

        // Stop Loss fijo
        if (currentKline.low <= position.slPrice) {
          const loss = (position.slPrice - position.entryPrice) * position.size;
          balance += loss;
          losses++;
          position = null;
          continue;
        }

        // Trailing Stop
        if (currentKline.low <= position.trailingStop && position.trailingStop > position.slPrice) {
          const pnl = (position.trailingStop - position.entryPrice) * position.size;
          balance += pnl;
          if (pnl > 0) wins++; else losses++;
          trailingStopHits++;
          position = null;
          continue;
        }

        // Salida por RSI sobrecomprado o cambio de tendencia
        if (isOverbought(indicators.rsi, 75) || indicators.emaCrossState === "DEATH") {
          const pnl = (price - position.entryPrice) * position.size;
          balance += pnl;
          if (pnl > 0) wins++; else losses++;
          position = null;
          lastTradeBar = i;
          continue;
        }
      } else if (position.side === "SHORT") {
        const result = calculateTrailingStop(
          "short", price, position.troughPrice, atr, trailingMult, position.trailingStop
        );
        position.troughPrice = result.newPeakOrTrough;
        position.trailingStop = result.newTrailingStop;

        // Stop Loss fijo
        if (currentKline.high >= position.slPrice) {
          const loss = (position.entryPrice - position.slPrice) * position.size;
          balance += loss;
          losses++;
          position = null;
          continue;
        }

        // Trailing Stop
        if (currentKline.high >= position.trailingStop && position.trailingStop < position.slPrice) {
          const pnl = (position.entryPrice - position.trailingStop) * position.size;
          balance += pnl;
          if (pnl > 0) wins++; else losses++;
          trailingStopHits++;
          position = null;
          continue;
        }

        // Salida por RSI sobrevendido, golden cross o MACD alcista
        if (isOversold(indicators.rsi, 25) || indicators.emaCrossState === "GOLDEN" || macdCrossUp(indicators.macd)) {
          const pnl = (position.entryPrice - price) * position.size;
          balance += pnl;
          if (pnl > 0) wins++; else losses++;
          position = null;
          lastTradeBar = i;
          continue;
        }
      }

      // ─── Drawdown Kill Switch ──────────────────────────────────────
      const unrealizedPnl = position.side === "LONG"
        ? (price - position.entryPrice) * position.size
        : (position.entryPrice - price) * position.size;
      const currentEquity = balance + unrealizedPnl;
      maxEquity = Math.max(maxEquity, currentEquity);
      const currentDD = calculateDrawdown(currentEquity, maxEquity);
      maxDrawdown = Math.max(maxDrawdown, currentDD);

      if (shouldKillSwitch(currentDD, maxDrawdownPct)) {
        balance += unrealizedPnl;
        if (unrealizedPnl > 0) wins++; else losses++;
        position = null;
        drawdownKills++;
        killed = true;
        continue;
      }
    }

    // ─── LÓGICA DE ENTRADA (sin posición) ────────────────────────────

    if (!position && !killed) {
      // Cooldown entre trades
      if (i - lastTradeBar < cooldownBars) continue;

      // Filtro de volatilidad extrema
      if (isHighVolatility(indicators.volatilityRatio, 0.04)) {
        tradesIgnoredByFilter++;
        continue;
      }

      // ─── SEÑAL LONG ─────────────────────────────────────────────
      const trendUp = price > indicators.ema50 && price > indicators.ema200;
      const rsiSignalUp = rsiCrossUp(indicators.rsi, 40);
      const lastMacd = indicators.macd[indicators.macd.length - 1];
      const macdConfirm = (lastMacd.histogram ?? 0) > 0;

      if (trendUp && rsiSignalUp && macdConfirm) {
        // Filtro de tendencia: no abrir long si sesgo es bajista
        if (marketBias === "BEARISH") {
          tradesIgnoredByFilter++;
          continue;
        }

        const slPrice = price - (atr * atrMult);
        const riskAmount = balance * (riskPct / 100);
        const distance = price - slPrice;
        const size = distance > 0 ? riskAmount / distance : 0;

        if (size > 0) {
          position = {
            side: "LONG",
            entryPrice: price,
            slPrice,
            size,
            peakPrice: price,
            troughPrice: price,
            trailingStop: slPrice, // Inicia en SL
            entryTimestamp: currentKline.timestamp,
          };
          trades++;
          lastTradeBar = i;
        }
        continue;
      }

      // ─── SEÑAL SHORT ────────────────────────────────────────────
      const trendDown = price < indicators.ema100;
      const macdSignalDown = macdCrossDown(indicators.macd);
      const rsiNotOversold = !isOversold(indicators.rsi, 25);

      if (trendDown && macdSignalDown && rsiNotOversold) {
        // Filtro de tendencia: no abrir short si sesgo es alcista
        if (marketBias === "BULLISH") {
          tradesIgnoredByFilter++;
          continue;
        }

        const slPrice = price + (atr * atrMult);
        const riskAmount = balance * (riskPct / 100);
        const distance = slPrice - price;
        const size = distance > 0 ? riskAmount / distance : 0;

        if (size > 0) {
          position = {
            side: "SHORT",
            entryPrice: price,
            slPrice,
            size,
            peakPrice: price,
            troughPrice: price,
            trailingStop: slPrice, // Inicia en SL
            entryTimestamp: currentKline.timestamp,
          };
          trades++;
          lastTradeBar = i;
        }
      }
    }
  }

  // ─── Cerrar posición abierta al final ──────────────────────────────

  if (position && !killed) {
    const lastPrice = klines[klines.length - 1].close;
    const pnl = position.side === "LONG"
      ? (lastPrice - position.entryPrice) * position.size
      : (position.entryPrice - lastPrice) * position.size;
    balance += pnl;
    if (pnl > 0) wins++; else losses++;
  }

  // ─── Buy & Hold comparación ────────────────────────────────────────

  const buyAndHoldEndPrice = klines[klines.length - 1].close;
  const buyAndHoldReturn = ((buyAndHoldEndPrice - buyAndHoldStartPrice) / buyAndHoldStartPrice) * 100;

  // ─── Resultados ────────────────────────────────────────────────────

  const netProfit = balance - initialCapital;
  const netProfitPct = (netProfit / initialCapital) * 100;
  const winRate = trades > 0 ? (wins / trades) * 100 : 0;

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  RESULTADOS DEL BACKTEST MEJORADO");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Capital Inicial:     $${initialCapital.toFixed(2)}`);
  console.log(`  Balance Final:       $${balance.toFixed(2)}`);
  console.log(`  Profit Neto:         $${netProfit.toFixed(2)} (${netProfitPct >= 0 ? "+" : ""}${netProfitPct.toFixed(2)}%)`);
  console.log("───────────────────────────────────────────────────────────");
  console.log(`  Total Trades:        ${trades}`);
  console.log(`  Wins:                ${wins}`);
  console.log(`  Losses:              ${losses}`);
  console.log(`  Win Rate:            ${winRate.toFixed(1)}%`);
  console.log("───────────────────────────────────────────────────────────");
  console.log(`  Max Drawdown:        ${maxDrawdown.toFixed(1)}%`);
  console.log(`  Trailing Stop Hits:  ${trailingStopHits}`);
  console.log(`  Drawdown Kills:      ${drawdownKills}`);
  console.log(`  Señales Filtradas:   ${tradesIgnoredByFilter}`);
  console.log("───────────────────────────────────────────────────────────");
  console.log(`  Buy & Hold Return:   ${buyAndHoldReturn >= 0 ? "+" : ""}${buyAndHoldReturn.toFixed(2)}%`);
  console.log(`  Alpha vs B&H:        ${(netProfitPct - buyAndHoldReturn) >= 0 ? "+" : ""}${(netProfitPct - buyAndHoldReturn).toFixed(2)}%`);
  console.log("═══════════════════════════════════════════════════════════");

  if (killed) {
    console.log("\n  ⚠ Bot terminado por Kill Switch de Drawdown.");
  }
}

run().catch(console.error);
