/**
 * lib/indicators.ts — Motor de Análisis Técnico (Versión Institucional)
 *
 * Nuevos indicadores añadidos:
 * - Supertrend (filtro de tendencia macro superior a EMA sola)
 * - Bollinger Bands (detección de rango y compresión de volatilidad)
 * - ADX + DI+/DI- (fuerza y dirección de tendencia)
 * - StochasticRSI (señales de momentum más reactivas)
 * - Score de sesgo multi-factor (0-100, reemplaza la detección binaria anterior)
 * - Detección de "freefall" (cuchillo cayendo — no comprar)
 * - Análisis de volumen (confirmar dirección con volumen)
 */

import { EMA, RSI, MACD, ATR, BollingerBands, Stochastic } from "technicalindicators";

// ─── Interfaces de datos ─────────────────────────────────────────────────────

export interface Kline {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BollingerBandsResult {
  upper: number;
  middle: number;  // EMA20
  lower: number;
  width: number;   // (upper - lower) / middle — volatilidad normalizada
  percentB: number; // dónde está el precio dentro de las bandas (0-1, >1 fuera arriba, <0 fuera abajo)
}

export interface SupertrendResult {
  value: number;       // nivel del Supertrend
  isBullish: boolean;  // true = precio sobre el Supertrend → alcista
}

export interface ADXResult {
  adx: number;    // fuerza de tendencia (>25 = tendencia fuerte, >40 = muy fuerte)
  diPlus: number; // presión compradora
  diMinus: number; // presión vendedora
  trending: boolean; // ADX > 25
  bullishTrend: boolean; // ADX > 25 AND DI+ > DI-
}

export interface IndicatorsResult {
  // ─── EMAs ─────────────────────────────────────────────────────────────────
  ema21: number | null;
  ema50: number | null;
  ema100: number | null;
  ema200: number | null;

  // ─── Osciladores ──────────────────────────────────────────────────────────
  rsi: number[];  // últimos 5 valores
  stochRsi: number | null;  // StochasticRSI %K (0-100)
  macd: Array<{ MACD?: number; signal?: number; histogram?: number }>;

  // ─── Volatilidad ──────────────────────────────────────────────────────────
  atr: number | null;
  atr14: number | null;    // ATR período 14 (para stops)
  atr50: number | null;    // ATR período 50 (para rangos macro)
  bollinger: BollingerBandsResult | null;
  volatilityRatio: number | null;  // atr14 / precio (normalizado)
  isHighVolatility: boolean;

  // ─── Tendencia ────────────────────────────────────────────────────────────
  supertrend: SupertrendResult | null;
  adx: ADXResult | null;
  emaCrossState: "GOLDEN" | "DEATH" | "NONE";
  trendStrength: number | null;    // % distancia precio a EMA200

  // ─── Score de Mercado (nuevo) ─────────────────────────────────────────────
  // 0-100: score compuesto de todos los factores
  // 0-25: COLAPSO — no operar
  // 26-45: BAJISTA — solo SHORT_GRID o pausa
  // 46-65: NEUTRAL — grid neutro
  // 66-80: ALCISTA — LONG_GRID
  // 81-100: FUERTEMENTE ALCISTA — LONG_GRID agresivo
  marketScore: number;
  marketPhase: "COLLAPSE" | "BEARISH" | "NEUTRAL" | "BULLISH" | "STRONG_BULL";

  // ─── Señales de peligro ───────────────────────────────────────────────────
  isFreefalling: boolean;  // cuchillo cayendo — NO comprar
  freefallSeverity: number; // 0-3 (0=normal, 1=cuidado, 2=peligro, 3=colapso)
  volumeTrend: "UP" | "DOWN" | "FLAT";  // volumen respaldando movimiento
}

// ─── Cálculo de Supertrend ────────────────────────────────────────────────────

/**
 * Supertrend — Indicador de tendencia basado en ATR.
 *
 * Matemática:
 *   HL2 = (High + Low) / 2
 *   Upper Band = HL2 + (multiplier * ATR)
 *   Lower Band = HL2 - (multiplier * ATR)
 *
 * Reglas de señal:
 *   - Si Close > Upper Band anterior → ALCISTA (usar Lower Band como soporte)
 *   - Si Close < Lower Band anterior → BAJISTA (usar Upper Band como resistencia)
 *
 * Parámetros típicos Pionex/TradingView: period=10, multiplier=3
 */
function calculateSupertrend(
  klines: Kline[],
  period = 10,
  multiplier = 3.0
): SupertrendResult | null {
  if (klines.length < period + 1) return null;

  const atrValues = ATR.calculate({
    high: klines.map(k => k.high),
    low: klines.map(k => k.low),
    close: klines.map(k => k.close),
    period,
  });

  if (atrValues.length === 0) return null;

  // Alinear ATR con klines (ATR tiene menos valores que klines por el período)
  const offset = klines.length - atrValues.length;
  const alignedKlines = klines.slice(offset);

  let upperBand = 0;
  let lowerBand = 0;
  let isBullish = true;

  for (let i = 0; i < alignedKlines.length; i++) {
    const k = alignedKlines[i];
    const hl2 = (k.high + k.low) / 2;
    const atr = atrValues[i];

    const rawUpper = hl2 + multiplier * atr;
    const rawLower = hl2 - multiplier * atr;

    // Ajustar bandas: solo se mueven en una dirección para evitar whipsaws
    if (i === 0) {
      upperBand = rawUpper;
      lowerBand = rawLower;
    } else {
      // La banda superior solo baja si es más baja que la anterior
      upperBand = rawUpper < upperBand || alignedKlines[i - 1].close > upperBand
        ? rawUpper
        : upperBand;
      // La banda inferior solo sube si es más alta que la anterior
      lowerBand = rawLower > lowerBand || alignedKlines[i - 1].close < lowerBand
        ? rawLower
        : lowerBand;
    }

    // Determinar dirección
    if (i > 0) {
      if (isBullish) {
        // Bajista si el precio cierra bajo la banda inferior
        isBullish = k.close >= lowerBand;
      } else {
        // Alcista si el precio cierra sobre la banda superior
        isBullish = k.close > upperBand;
      }
    }
  }

  return {
    value: isBullish ? lowerBand : upperBand,
    isBullish,
  };
}

// ─── Cálculo de ADX ──────────────────────────────────────────────────────────

/**
 * ADX (Average Directional Index) + DI+/DI-
 *
 * Matemática:
 *   +DM = High - PreviousHigh (solo si > 0 y > -DM)
 *   -DM = PreviousLow - Low (solo si > 0 y > +DM)
 *   ATR = Wilder's ATR
 *   +DI = 100 * EMA(+DM, period) / ATR
 *   -DI = 100 * EMA(-DM, period) / ATR
 *   DX  = 100 * |+DI - -DI| / (+DI + -DI)
 *   ADX = Wilder's EMA(DX, period)
 *
 * Interpretación:
 *   ADX < 20: sin tendencia (lateralización — ideal para grid)
 *   ADX 20-40: tendencia moderada
 *   ADX > 40: tendencia fuerte
 *   +DI > -DI: presión compradora dominante
 *   -DI > +DI: presión vendedora dominante
 */
function calculateADX(klines: Kline[], period = 14): ADXResult | null {
  if (klines.length < period * 2) return null;

  const highs = klines.map(k => k.high);
  const lows = klines.map(k => k.low);
  const closes = klines.map(k => k.close);

  const atrValues = ATR.calculate({ high: highs, low: lows, close: closes, period });
  if (atrValues.length < period) return null;

  // Calcular +DM y -DM
  const plusDM: number[] = [];
  const minusDM: number[] = [];

  for (let i = 1; i < klines.length; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];

    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  // Wilder's smoothing (EMA con alpha = 1/period)
  const smooth = (data: number[]): number[] => {
    const result: number[] = [];
    let sum = data.slice(0, period).reduce((a, b) => a + b, 0);
    result.push(sum);
    for (let i = period; i < data.length; i++) {
      sum = sum - sum / period + data[i];
      result.push(sum);
    }
    return result;
  };

  const smoothedPlus = smooth(plusDM);
  const smoothedMinus = smooth(minusDM);
  const smoothedATR = smooth(atrValues.slice(0, plusDM.length));

  const len = Math.min(smoothedPlus.length, smoothedMinus.length, smoothedATR.length);
  if (len < period) return null;

  // Calcular DI+ y DI-
  const diPlus: number[] = [];
  const diMinus: number[] = [];
  const dx: number[] = [];

  for (let i = 0; i < len; i++) {
    const p = smoothedATR[i] > 0 ? (100 * smoothedPlus[i]) / smoothedATR[i] : 0;
    const m = smoothedATR[i] > 0 ? (100 * smoothedMinus[i]) / smoothedATR[i] : 0;
    diPlus.push(p);
    diMinus.push(m);
    const sum = p + m;
    dx.push(sum > 0 ? (100 * Math.abs(p - m)) / sum : 0);
  }

  // ADX = EMA suavizada de DX
  const smoothedDX = smooth(dx);
  if (smoothedDX.length === 0) return null;

  const adx = smoothedDX[smoothedDX.length - 1] / period; // normalizar
  const lastDiPlus = diPlus[diPlus.length - 1];
  const lastDiMinus = diMinus[diMinus.length - 1];

  return {
    adx: Math.min(adx, 100), // capping at 100
    diPlus: lastDiPlus,
    diMinus: lastDiMinus,
    trending: adx > 20,
    bullishTrend: adx > 20 && lastDiPlus > lastDiMinus,
  };
}

// ─── Detección de Freefall ────────────────────────────────────────────────────

/**
 * Detecta si el precio está en caída libre ("catching a falling knife").
 *
 * Algoritmo de scoring:
 *   - Punto 1: Las últimas N velas son todas bajistas (close < open)
 *   - Punto 2: El rango total de caída > 1.5 * ATR
 *   - Punto 3: El volumen está aumentando en la caída (distribución activa)
 *   - Punto 4: El precio está debajo de todas las EMAs
 *   - Punto 5: RSI < 25 (sobrevendido extremo, sin señal de giro)
 *
 * severidad:
 *   0 = Normal — operar normalmente
 *   1 = Cuidado — reducir tamaño o esperar
 *   2 = Peligro — no nuevas compras
 *   3 = Colapso — cancelar compras pendientes
 */
function detectFreefall(
  klines: Kline[],
  atr: number | null,
  rsi: number[],
  ema50: number | null
): { isFreefalling: boolean; severity: number } {
  if (klines.length < 6 || !atr || atr <= 0) {
    return { isFreefalling: false, severity: 0 };
  }

  const recent = klines.slice(-6); // últimas 6 velas
  const lastPrice = recent[recent.length - 1].close;
  let score = 0;

  // Factor 1: Velas bajistas consecutivas (últimas 4)
  const last4 = recent.slice(-4);
  const bearishBars = last4.filter(k => k.close < k.open).length;
  if (bearishBars >= 4) score += 2;       // todas bajistas
  else if (bearishBars >= 3) score += 1;  // 3/4 bajistas

  // Factor 2: Magnitud de caída vs ATR
  const highOfPeriod = Math.max(...recent.map(k => k.high));
  const totalDrop = highOfPeriod - lastPrice;
  if (totalDrop > atr * 2.5) score += 3;       // caída severa (>2.5 ATR)
  else if (totalDrop > atr * 1.5) score += 2;  // caída moderada (>1.5 ATR)
  else if (totalDrop > atr) score += 1;        // caída leve (>1 ATR)

  // Factor 3: Volumen creciente en caída (distribución activa — muy peligroso)
  const avgVolume = recent.slice(0, -3).reduce((sum, k) => sum + k.volume, 0) / 3;
  const recentVolume = recent.slice(-3).reduce((sum, k) => sum + k.volume, 0) / 3;
  if (recentVolume > avgVolume * 1.5 && bearishBars >= 3) score += 2; // volumen confirma caída

  // Factor 4: Precio por debajo de EMA50
  if (ema50 && lastPrice < ema50 * 0.98) score += 1; // más del 2% bajo EMA50

  // Factor 5: RSI extremo sin divergencia (no hay señal de giro)
  const lastRsi = rsi.length > 0 ? rsi[rsi.length - 1] : 50;
  if (lastRsi < 20) score += 2;       // RSI extremo
  else if (lastRsi < 30) score += 1;  // RSI sobrevendido

  // Calcular severidad
  const severity = score >= 8 ? 3 : score >= 5 ? 2 : score >= 3 ? 1 : 0;

  return {
    isFreefalling: severity >= 2,
    severity,
  };
}

// ─── Score de Mercado Multi-Factor ───────────────────────────────────────────

/**
 * Calcula el score compuesto del mercado (0-100).
 *
 * Factores ponderados:
 *   1. Precio vs EMA200 (25 pts) — ¿Estamos en bull o bear market?
 *   2. EMA50 vs EMA200 (20 pts) — ¿Alineación de medias? (Golden/Death Cross)
 *   3. Supertrend (20 pts) — ¿Tendencia a corto plazo confirmada?
 *   4. ADX + DI (15 pts) — ¿La tendencia tiene fuerza?
 *   5. RSI zona (10 pts) — ¿Momentum saludable?
 *   6. Bollinger Position (10 pts) — ¿Precio en zona de compra?
 *
 * Total: 100 pts
 */
function calculateMarketScore(
  price: number,
  ema50: number | null,
  ema200: number | null,
  supertrend: SupertrendResult | null,
  adxResult: ADXResult | null,
  rsi: number[],
  bollinger: BollingerBandsResult | null
): number {
  let score = 50; // Partir de neutral

  // 1. Precio vs EMA200 (±25 pts)
  if (ema200) {
    const distPct = ((price - ema200) / ema200) * 100;
    if (distPct > 5) score += 25;        // fuertemente por encima
    else if (distPct > 1) score += 15;   // ligeramente por encima
    else if (distPct > -1) score += 0;   // zona de contacto (neutral)
    else if (distPct > -5) score -= 15;  // ligeramente por debajo
    else score -= 25;                    // fuertemente por debajo
  }

  // 2. EMA50 vs EMA200 (±20 pts)
  if (ema50 && ema200) {
    if (ema50 > ema200 * 1.02) score += 20;      // Golden Cross confirmado (+2%)
    else if (ema50 > ema200) score += 10;         // Golden Cross reciente
    else if (ema50 < ema200 * 0.98) score -= 20; // Death Cross confirmado (-2%)
    else score -= 10;                             // Death Cross reciente
  }

  // 3. Supertrend (±20 pts)
  if (supertrend) {
    if (supertrend.isBullish) {
      const distFromSupport = ((price - supertrend.value) / price) * 100;
      if (distFromSupport > 2) score += 20;  // bien separado del soporte
      else score += 10;                      // cerca del soporte (cuidado)
    } else {
      const distFromResist = ((supertrend.value - price) / price) * 100;
      if (distFromResist > 2) score -= 20;  // bien bajo la resistencia
      else score -= 10;                      // cerca de la resistencia
    }
  }

  // 4. ADX + DI (±15 pts)
  if (adxResult) {
    if (adxResult.bullishTrend) {
      score += adxResult.adx > 40 ? 15 : 8; // tendencia alcista fuerte / moderada
    } else if (adxResult.trending && adxResult.diMinus > adxResult.diPlus) {
      score -= adxResult.adx > 40 ? 15 : 8; // tendencia bajista fuerte / moderada
    }
    // ADX bajo (sin tendencia) → neutral → no sumar ni restar (favorable para grid)
  }

  // 5. RSI zona (±10 pts)
  if (rsi.length > 0) {
    const lastRsi = rsi[rsi.length - 1];
    if (lastRsi > 60 && lastRsi < 80) score += 10;  // momentum alcista sano
    else if (lastRsi >= 80) score -= 5;              // sobrecomprado — riesgo de corrección
    else if (lastRsi < 35 && lastRsi > 20) score -= 5; // presión bajista
    else if (lastRsi <= 20) score -= 10;             // pánico extremo
  }

  // 6. Bollinger Bands (±10 pts)
  if (bollinger) {
    if (bollinger.percentB > 1.0) score -= 10;       // precio fuera de banda superior (sobreextendido)
    else if (bollinger.percentB > 0.8) score += 5;   // momentum alcista sano
    else if (bollinger.percentB < 0.0) score -= 10;  // precio fuera de banda inferior (colapso)
    else if (bollinger.percentB < 0.2) score -= 3;   // presión bajista
  }

  return Math.max(0, Math.min(100, score));
}

/**
 * Convierte el score numérico a una fase de mercado nominal.
 */
function scoreToPhase(score: number): IndicatorsResult["marketPhase"] {
  if (score <= 25) return "COLLAPSE";
  if (score <= 45) return "BEARISH";
  if (score <= 65) return "NEUTRAL";
  if (score <= 80) return "BULLISH";
  return "STRONG_BULL";
}

// ─── Función Principal ────────────────────────────────────────────────────────

/**
 * Calcula todos los indicadores técnicos a partir de las velas.
 *
 * Requiere mínimo ~220 velas para EMA200 + ATR50 + ADX.
 * Funciona con 5m (micro) o 1h (macro) indistintamente.
 */
export function calculateIndicators(klines: Kline[]): IndicatorsResult {
  const empty: IndicatorsResult = {
    ema21: null, ema50: null, ema100: null, ema200: null,
    rsi: [], stochRsi: null, macd: [],
    atr: null, atr14: null, atr50: null,
    bollinger: null, volatilityRatio: null, isHighVolatility: false,
    supertrend: null, adx: null,
    emaCrossState: "NONE", trendStrength: null,
    marketScore: 50, marketPhase: "NEUTRAL",
    isFreefalling: false, freefallSeverity: 0, volumeTrend: "FLAT",
  };

  if (klines.length < 20) return empty;

  const closes = klines.map(k => k.close);
  const highs = klines.map(k => k.high);
  const lows = klines.map(k => k.low);
  const volumes = klines.map(k => k.volume);
  const lastPrice = closes[closes.length - 1];

  // ─── EMAs ──────────────────────────────────────────────────────────────────
  const ema21Raw = EMA.calculate({ period: 21, values: closes });
  const ema50Raw = EMA.calculate({ period: 50, values: closes });
  const ema100Raw = EMA.calculate({ period: 100, values: closes });
  const ema200Raw = EMA.calculate({ period: 200, values: closes });

  const ema21 = ema21Raw.at(-1) ?? null;
  const ema50 = ema50Raw.at(-1) ?? null;
  const ema100 = ema100Raw.at(-1) ?? null;
  const ema200 = ema200Raw.at(-1) ?? null;

  // ─── RSI ───────────────────────────────────────────────────────────────────
  const rsiRaw = RSI.calculate({ period: 14, values: closes });
  const rsi = rsiRaw.slice(-5);

  // ─── StochasticRSI ─────────────────────────────────────────────────────────
  // Calculado manualmente sobre los valores de RSI
  let stochRsi: number | null = null;
  if (rsiRaw.length >= 14) {
    const rsiWindow = rsiRaw.slice(-14);
    const rsiMin = Math.min(...rsiWindow);
    const rsiMax = Math.max(...rsiWindow);
    const lastRsi = rsiWindow[rsiWindow.length - 1];
    stochRsi = rsiMax !== rsiMin ? ((lastRsi - rsiMin) / (rsiMax - rsiMin)) * 100 : 50;
  }

  // ─── MACD ──────────────────────────────────────────────────────────────────
  const macdRaw = MACD.calculate({
    values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
    SimpleMAOscillator: false, SimpleMASignal: false,
  });
  const macd = macdRaw.slice(-5);

  // ─── ATR (dos períodos) ────────────────────────────────────────────────────
  const atr14Raw = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const atr14 = atr14Raw.at(-1) ?? null;

  const atr50Raw = klines.length >= 50
    ? ATR.calculate({ high: highs, low: lows, close: closes, period: 50 })
    : [];
  const atr50 = atr50Raw.at(-1) ?? null;

  // ─── Bollinger Bands ───────────────────────────────────────────────────────
  let bollinger: BollingerBandsResult | null = null;
  if (closes.length >= 20) {
    const bbRaw = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });
    const lastBB = bbRaw.at(-1);
    if (lastBB) {
      const width = lastBB.middle > 0 ? (lastBB.upper - lastBB.lower) / lastBB.middle : 0;
      const bandRange = lastBB.upper - lastBB.lower;
      const percentB = bandRange > 0 ? (lastPrice - lastBB.lower) / bandRange : 0.5;
      bollinger = { upper: lastBB.upper, middle: lastBB.middle, lower: lastBB.lower, width, percentB };
    }
  }

  // ─── Volatilidad ───────────────────────────────────────────────────────────
  const volatilityRatio = atr14 && lastPrice > 0 ? atr14 / lastPrice : null;
  const isHighVol = (volatilityRatio ?? 0) > 0.03; // ATR > 3% del precio

  // ─── Supertrend ─────────────────────────────────────────────────────────────
  const supertrend = klines.length >= 15 ? calculateSupertrend(klines, 10, 3.0) : null;

  // ─── ADX ────────────────────────────────────────────────────────────────────
  const adx = klines.length >= 40 ? calculateADX(klines, 14) : null;

  // ─── Estado del cruce EMA50/EMA200 ─────────────────────────────────────────
  let emaCrossState: IndicatorsResult["emaCrossState"] = "NONE";
  if (ema50 && ema200) {
    const prevEma50 = ema50Raw.at(-2) ?? null;
    const prevEma200 = ema200Raw.at(-2) ?? null;
    if (prevEma50 && prevEma200) {
      if (prevEma50 <= prevEma200 && ema50 > ema200) emaCrossState = "GOLDEN";
      else if (prevEma50 >= prevEma200 && ema50 < ema200) emaCrossState = "DEATH";
      else emaCrossState = ema50 > ema200 ? "GOLDEN" : "DEATH";
    } else {
      emaCrossState = ema50 > ema200 ? "GOLDEN" : "DEATH";
    }
  }

  // ─── Fuerza de tendencia ────────────────────────────────────────────────────
  const trendStrength = ema200 && ema200 > 0 ? ((lastPrice - ema200) / ema200) * 100 : null;

  // ─── Detección de Freefall ─────────────────────────────────────────────────
  const { isFreefalling, severity: freefallSeverity } = detectFreefall(klines, atr14, rsi, ema50);

  // ─── Tendencia de Volumen ───────────────────────────────────────────────────
  let volumeTrend: IndicatorsResult["volumeTrend"] = "FLAT";
  if (volumes.length >= 10) {
    const recentAvgVol = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const prevAvgVol = volumes.slice(-10, -5).reduce((a, b) => a + b, 0) / 5;
    if (prevAvgVol > 0) {
      const volRatio = recentAvgVol / prevAvgVol;
      volumeTrend = volRatio > 1.2 ? "UP" : volRatio < 0.8 ? "DOWN" : "FLAT";
    }
  }

  // ─── Score de Mercado Compuesto ─────────────────────────────────────────────
  const marketScore = calculateMarketScore(lastPrice, ema50, ema200, supertrend, adx, rsi, bollinger);
  const marketPhase = scoreToPhase(marketScore);

  return {
    ema21, ema50, ema100, ema200,
    rsi, stochRsi, macd,
    atr: atr14, atr14, atr50,
    bollinger, volatilityRatio, isHighVolatility: isHighVol,
    supertrend, adx,
    emaCrossState, trendStrength,
    marketScore, marketPhase,
    isFreefalling, freefallSeverity, volumeTrend,
  };
}

// ─── Helpers de señal (exports) ────────────────────────────────────────────────

/** ¿El mercado está en una fase operativa segura para grid? */
export function isSafeToGrid(indicators: IndicatorsResult): boolean {
  return indicators.marketPhase !== "COLLAPSE" && !indicators.isFreefalling;
}

/** ¿El nivel de compra específico tiene confirmación técnica? */
export function hasBuyConfirmation(
  indicators: IndicatorsResult,
  mode: "STRICT" | "NORMAL" | "LOOSE" = "NORMAL"
): boolean {
  const { rsi, bollinger, isFreefalling, freefallSeverity, stochRsi } = indicators;
  const lastRsi = rsi.at(-1) ?? 50;

  // En cualquier modo, si está en freefall severo → NO comprar
  if (isFreefalling) return false;
  if (freefallSeverity >= 2) return false;

  if (mode === "STRICT") {
    // Estricto: exigir múltiples confirmaciones
    const rsiOk = lastRsi > 25 && lastRsi < 75;
    const bollingerOk = !bollinger || bollinger.percentB > -0.1; // no muy fuera de banda inferior
    const stochOk = stochRsi === null || stochRsi > 20; // StochRSI no en mínimos extremos
    return rsiOk && bollingerOk && stochOk;
  } else if (mode === "NORMAL") {
    // Normal: solo rechazar si RSI < 20 o freefall
    return lastRsi > 20;
  } else {
    // Loose: solo rechazar en colapso absoluto
    return lastRsi > 15 && freefallSeverity < 3;
  }
}

/** ¿El mercado tiene tendencia lateral (ADX bajo) — ideal para grid? */
export function isRanging(indicators: IndicatorsResult): boolean {
  if (!indicators.adx) return true; // Sin datos, asumir ranging
  return !indicators.adx.trending; // ADX < 20
}

export function isOverbought(rsi: number[], threshold = 70): boolean {
  return rsi.length > 0 && rsi[rsi.length - 1] > threshold;
}

export function isOversold(rsi: number[], threshold = 30): boolean {
  return rsi.length > 0 && rsi[rsi.length - 1] < threshold;
}

export function rsiCrossUp(rsi: number[], threshold = 40): boolean {
  if (rsi.length < 2) return false;
  return rsi[rsi.length - 2] <= threshold && rsi[rsi.length - 1] > threshold;
}

export function rsiCrossDown(rsi: number[], threshold = 60): boolean {
  if (rsi.length < 2) return false;
  return rsi[rsi.length - 2] >= threshold && rsi[rsi.length - 1] < threshold;
}

export function macdCrossDown(macd: Array<{ MACD?: number; signal?: number }>): boolean {
  if (macd.length < 2) return false;
  const prev = macd[macd.length - 2];
  const curr = macd[macd.length - 1];
  return (prev.MACD ?? 0) >= (prev.signal ?? 0) && (curr.MACD ?? 0) < (curr.signal ?? 0);
}

export function macdCrossUp(macd: Array<{ MACD?: number; signal?: number }>): boolean {
  if (macd.length < 2) return false;
  const prev = macd[macd.length - 2];
  const curr = macd[macd.length - 1];
  return (prev.MACD ?? 0) <= (prev.signal ?? 0) && (curr.MACD ?? 0) > (curr.signal ?? 0);
}

export function isHighVolatility(volatilityRatio: number | null, threshold = 0.03): boolean {
  return (volatilityRatio ?? 0) > threshold;
}
