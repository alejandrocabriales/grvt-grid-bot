/**
 * lib/grid-bot.ts — Motor de Estrategia Grid (Versión Institucional)
 *
 * Mejoras principales sobre la versión anterior:
 * - Grid GEOMÉTRICO: profit % uniforme por nivel (precio_i = L * (U/L)^(i/N))
 * - Rango automático basado en ATR: el rango se calcula a partir de la volatilidad real
 * - Sesgo de mercado mejorado: usa marketScore/marketPhase de indicators en lugar de EMA simple
 * - Filtro de freefall integrado: bloquea compras cuando el mercado está en caída libre
 * - Repositionamiento inteligente: solo si marketPhase NO es COLLAPSE
 * - Soporte completo LONG/SHORT/NEUTRAL con contra-órdenes correctas
 */

import type { IndicatorsResult } from "./indicators";

// ─── Tipos de Configuración ─────────────────────────────────────────────────

export interface GridConfig {
  pair: string;                // ej: "ETH_USDT_Perp"
  strategyMode: "NEUTRAL_GRID" | "LONG_GRID" | "SHORT_GRID" | "AUTO_GRID" | "BULL_MOMENTUM" | "BEAR_BREAKDOWN";
  upperPrice: number;
  lowerPrice: number;
  gridCount: number;           // número de niveles de grilla
  gridType: "ARITHMETIC" | "GEOMETRIC"; // tipo de espaciado (GEOMETRIC = % uniforme)
  totalInvestment: number;     // capital real en USDC (margen)
  leverage: number;            // ej: 5 → capital efectivo = totalInvestment * leverage
  stopLoss?: number;           // precio absoluto de SL
  takeProfit?: number;         // precio absoluto de TP
  atrMultiplier?: number;      // multiplicador ATR para SL dinámico (default 1.5)
  riskPerTrade?: number;       // % de riesgo por trade direccional (default 1.5)
  maxDrawdownPct?: number;     // % máximo de drawdown antes de kill switch (default 15)
  enableTrailingStop?: boolean; // activar trailing stop dinámico
  trailingAtrMult?: number;    // multiplicador ATR para trailing (default 2.0)
  autoReposition?: boolean;    // reposicionar grilla automáticamente si precio sale del rango
  trendFilterEnabled?: boolean; // usar marketScore como filtro de tendencia (default true)
  autoRange?: boolean;         // calcular rango automáticamente desde ATR50
  // ─── Módulos dinámicos avanzados ─────────────────────────────────────────
  atrStepMult?: number;        // ATR * atrStepMult = distancia entre niveles (default 0.5)
  marginGuardPct?: number;     // % de margin usado que pausa nuevas compras (default 15)
  macroRsiExit?: boolean;      // activar salida parcial al RSI diario > 80
}

// ─── Tipos de Niveles y Estado ────────────────────────────────────────────────

export interface GridLevel {
  price: number;
  type: "buy" | "sell";
  orderId?: string;
  clientOrderId?: string;
  filled: boolean;
  profit: number;
}

/** Dirección detectada del mercado basada en indicadores compuestos */
export type MarketBias = "BULLISH" | "BEARISH" | "NEUTRAL";

export interface GridState {
  config: GridConfig;
  levels: GridLevel[];
  currentPrice: number;
  totalPnL: number;
  totalVolume: number;
  filledOrders: number;
  startTime: number;
  isRunning: boolean;
  logs: LogEntry[];
  position: import("./grvt-api").Position | null;
  indicators: IndicatorsResult | null;
  // Campos de gestión de riesgo
  marketBias: MarketBias;
  trailingStopPrice: number | null;
  peakPrice: number | null;       // precio máximo alcanzado (para trailing long)
  troughPrice: number | null;     // precio mínimo alcanzado (para trailing short)
  maxEquity: number;
  currentDrawdownPct: number;
  gridRepositionCount: number;
  lastSignalTime: number;
}

export interface LogEntry {
  timestamp: number;
  level: "info" | "warn" | "error" | "success";
  message: string;
}

// ─── Grid Aritmético ─────────────────────────────────────────────────────────

/**
 * Precios de grilla con espaciado aritmético uniforme (paso constante en $).
 * Adecuado para rangos estrechos donde el precio varía poco en términos %.
 */
export function calculateGridLevelsArithmetic(
  lowerPrice: number,
  upperPrice: number,
  gridCount: number
): number[] {
  if (gridCount < 2) throw new Error("Se necesitan al menos 2 grids");
  if (lowerPrice >= upperPrice) throw new Error("Precio inferior debe ser < precio superior");

  const step = (upperPrice - lowerPrice) / gridCount;
  const levels: number[] = [];
  for (let i = 0; i <= gridCount; i++) {
    levels.push(parseFloat((lowerPrice + step * i).toFixed(8)));
  }
  return levels;
}

// ─── Grid Geométrico ──────────────────────────────────────────────────────────

/**
 * Precios de grilla con espaciado geométrico (% constante entre niveles).
 *
 * Fórmula: precio_i = L * (U / L) ^ (i / N)
 *
 * Ventajas sobre aritmético:
 *   - Profit % uniforme en cada ciclo independientemente del nivel de precio
 *   - Mejor distribución del capital en rangos amplios
 *   - Más capital en niveles bajos (donde el precio pasa más tiempo en bear market)
 *
 * Ejemplo: L=$1000, U=$2000, N=5
 *   ratio = (2000/1000)^(1/5) = 1.1487 → ~14.87% entre niveles
 *   Niveles: 1000, 1149, 1320, 1516, 1741, 2000
 */
export function calculateGridLevelsGeometric(
  lowerPrice: number,
  upperPrice: number,
  gridCount: number
): number[] {
  if (gridCount < 2) throw new Error("Se necesitan al menos 2 grids");
  if (lowerPrice <= 0 || upperPrice <= lowerPrice) {
    throw new Error("Precios inválidos para grilla geométrica");
  }

  const ratio = Math.pow(upperPrice / lowerPrice, 1 / gridCount);
  const levels: number[] = [];
  for (let i = 0; i <= gridCount; i++) {
    levels.push(parseFloat((lowerPrice * Math.pow(ratio, i)).toFixed(8)));
  }
  return levels;
}

/**
 * Dispatcher: calcula niveles según el tipo de grilla configurado.
 * Defecto: GEOMETRIC (Pionex-style, profit % uniforme).
 */
export function calculateGridLevels(
  lowerPrice: number,
  upperPrice: number,
  gridCount: number,
  gridType: GridConfig["gridType"] = "GEOMETRIC"
): number[] {
  if (gridType === "ARITHMETIC") {
    return calculateGridLevelsArithmetic(lowerPrice, upperPrice, gridCount);
  }
  return calculateGridLevelsGeometric(lowerPrice, upperPrice, gridCount);
}

// ─── Rango Automático basado en ATR ──────────────────────────────────────────

/**
 * Calcula el rango de la grilla automáticamente usando ATR50 (volatilidad macro).
 *
 * Lógica:
 *   - Se usa ATR50 para capturar la volatilidad de los últimos ~50 períodos
 *   - El rango total = precio ± (atrMult * ATR50)
 *   - atrMult típico: 2.0 para 5m, 1.5 para 1h
 *
 * Esto garantiza que la grilla cubre exactamente el rango esperado de movimiento
 * basado en la volatilidad histórica reciente, sin sobredimensionar ni subdimensionar.
 */
export function calculateAutoRange(
  currentPrice: number,
  atr50: number | null,
  atrMult = 2.0,
  gridDirection: "LONG" | "SHORT" | "NEUTRAL" = "NEUTRAL"
): { lowerPrice: number; upperPrice: number } {
  // Fallback: ±3% si no hay ATR
  const range = atr50 ? atr50 * atrMult : currentPrice * 0.03;

  let lowerPrice: number;
  let upperPrice: number;

  if (gridDirection === "LONG") {
    // Grid LONG: más espacio abajo para acumular en caídas
    lowerPrice = currentPrice - range * 1.5;
    upperPrice = currentPrice + range * 0.8;
  } else if (gridDirection === "SHORT") {
    // Grid SHORT: más espacio arriba para vender en subidas
    lowerPrice = currentPrice - range * 0.8;
    upperPrice = currentPrice + range * 1.5;
  } else {
    // Neutral: simétrico
    lowerPrice = currentPrice - range;
    upperPrice = currentPrice + range;
  }

  return {
    lowerPrice: parseFloat(Math.max(lowerPrice, currentPrice * 0.5).toFixed(2)),
    upperPrice: parseFloat(upperPrice.toFixed(2)),
  };
}

// ─── Grid Count Dinámico basado en ATR ───────────────────────────────────────

/**
 * Deriva el número óptimo de niveles de grilla a partir del ATR.
 *
 * Lógica:
 *   gridStep = atr14 * atrStepMult   (distancia entre cada nivel)
 *   gridCount = totalRange / gridStep
 *
 * Con atrStepMult=0.5: en alta volatilidad el bot automáticamente
 * separa más los niveles (menos órdenes, mayor margen de seguridad).
 * En baja volatilidad los niveles se comprimen para capturar micro-movimientos.
 *
 * Ejemplo: rango=$400, ATR14=$50, mult=0.5 → step=$25 → 16 niveles
 */
export function calculateAtrGridCount(
  totalRange: number,
  atr14: number,
  atrStepMult = 0.5,
  minGrids = 3,
  maxGrids = 50
): number {
  const step = atr14 * atrStepMult;
  if (step <= 0) return minGrids;
  const count = Math.floor(totalRange / step);
  return Math.max(minGrids, Math.min(maxGrids, count));
}

// ─── Tamaño de Orden ─────────────────────────────────────────────────────────

/**
 * Tamaño de orden por nivel de grilla.
 *
 * totalInvestment = margen REAL del usuario.
 * Con leverage, cada dólar controla `leverage` dólares de nocional.
 *
 * Ejemplo: $500 balance, 5x leverage, 10 grids, BTC @ $60,000
 *   margen_por_grid = $500 / 10 = $50
 *   nocional_por_grid = $50 * 5 = $250
 *   tamaño = $250 / $60,000 = 0.0041 BTC
 */
export function calculateOrderSize(
  totalInvestment: number,
  gridCount: number,
  priceAtLevel: number,
  baseDecimals = 2,
  leverage = 1
): string {
  const marginPerGrid = totalInvestment / gridCount;
  const notionalPerGrid = marginPerGrid * leverage;
  const baseAmount = notionalPerGrid / priceAtLevel;
  const factor = 10 ** baseDecimals;
  const floored = Math.floor(baseAmount * factor) / factor;
  return floored.toFixed(baseDecimals);
}

/**
 * Tamaño de posición para estrategias direccionales basado en riesgo fijo por trade.
 * Fórmula: Tamaño = (Capital * RiskPct%) / DistanciaAlSL
 */
export function calculateDirectionalSize(
  totalInvestment: number,
  riskPerTradePct: number,
  entryPrice: number,
  slPrice: number,
  baseDecimals = 2,
  leverage = 1
): string {
  const riskAmount = totalInvestment * (riskPerTradePct / 100);
  const distance = Math.abs(entryPrice - slPrice);
  if (distance === 0) return "0";

  const baseAmount = riskAmount / distance;
  // Verificar que el margen requerido no exceda el capital disponible
  const requiredMargin = (baseAmount * entryPrice) / leverage;
  const adjustedBase = requiredMargin > totalInvestment
    ? (totalInvestment * leverage) / entryPrice
    : baseAmount;

  const factor = 10 ** baseDecimals;
  const floored = Math.floor(adjustedBase * factor) / factor;
  return floored.toFixed(baseDecimals);
}

/**
 * Número máximo de grids que respetan el tamaño mínimo del instrumento.
 */
export function calculateMaxGrids(
  totalInvestment: number,
  gridCount: number,
  referencePrice: number,
  minSize: number,
  leverage = 1
): number {
  const sizePerGrid = (totalInvestment * leverage) / gridCount / referencePrice;
  if (sizePerGrid >= minSize) return gridCount;
  const maxGrids = Math.floor((totalInvestment * leverage) / (minSize * referencePrice));
  return Math.max(maxGrids, 2);
}

// ─── Profit por Ciclo ─────────────────────────────────────────────────────────

/**
 * Profit real por ciclo completado de grilla.
 * Un ciclo = buy en nivel N + sell en nivel N+1 (o viceversa para short).
 */
export function calculateGridProfit(
  buyPrice: number,
  sellPrice: number,
  size: string
): number {
  return (sellPrice - buyPrice) * parseFloat(size);
}

/**
 * Profit % por ciclo en grilla geométrica (uniforme en todos los niveles).
 * profitPct = (U/L)^(1/N) - 1
 */
export function calculateGeometricProfitPct(
  lowerPrice: number,
  upperPrice: number,
  gridCount: number
): number {
  if (lowerPrice <= 0 || gridCount <= 0) return 0;
  return (Math.pow(upperPrice / lowerPrice, 1 / gridCount) - 1) * 100;
}

// ─── Órdenes Iniciales ───────────────────────────────────────────────────────

/**
 * Órdenes iniciales según precio actual y dirección del grid.
 *
 * LONG_GRID / NEUTRAL:
 *   - Precio debajo del actual: BUY (acumular long)
 *   - Precio encima del actual: SELL (tomar profit)
 *
 * SHORT_GRID:
 *   - Precio encima del actual: SELL (abrir short)
 *   - Precio debajo del actual: BUY (cerrar short / tomar profit)
 */
export function getInitialOrders(
  levels: number[],
  currentPrice: number,
  totalInvestment: number,
  gridCount: number,
  baseDecimals = 2,
  leverage = 1,
  gridDirection: "LONG" | "SHORT" | "NEUTRAL" = "NEUTRAL"
): Array<{ price: number; type: "buy" | "sell"; size: string }> {
  const orders: Array<{ price: number; type: "buy" | "sell"; size: string }> = [];

  for (const price of levels) {
    // Saltar el nivel más cercano al precio actual (evitar fill inmediato)
    if (Math.abs(price - currentPrice) / currentPrice < 0.0005) continue;

    let type: "buy" | "sell";
    if (gridDirection === "SHORT") {
      type = price > currentPrice ? "sell" : "buy";
    } else {
      type = price < currentPrice ? "buy" : "sell";
    }

    const size = calculateOrderSize(totalInvestment, gridCount, price, baseDecimals, leverage);
    if (parseFloat(size) > 0) {
      orders.push({ price, type, size });
    }
  }
  return orders;
}

// ─── Contra-Órdenes ──────────────────────────────────────────────────────────

/**
 * Cuando una orden se llena, coloca la contra-orden en el nivel opuesto.
 *   BUY filled → SELL en el nivel superior inmediato
 *   SELL filled → BUY en el nivel inferior inmediato
 */
export function getCounterOrder(
  filledPrice: number,
  filledType: "buy" | "sell",
  levels: number[],
  totalInvestment: number,
  gridCount: number,
  baseDecimals = 2,
  leverage = 1
): { price: number; type: "buy" | "sell"; size: string } | null {
  const sortedLevels = [...levels].sort((a, b) => a - b);
  const idx = sortedLevels.findIndex(
    (p) => Math.abs(p - filledPrice) / filledPrice < 0.0001
  );

  if (idx === -1) return null;

  if (filledType === "buy") {
    const sellPrice = sortedLevels[idx + 1];
    if (!sellPrice) return null;
    const size = calculateOrderSize(totalInvestment, gridCount, sellPrice, baseDecimals, leverage);
    return { price: sellPrice, type: "sell", size };
  } else {
    const buyPrice = sortedLevels[idx - 1];
    if (!buyPrice) return null;
    const size = calculateOrderSize(totalInvestment, gridCount, buyPrice, baseDecimals, leverage);
    return { price: buyPrice, type: "buy", size };
  }
}

// ─── Detección de Sesgo de Mercado ────────────────────────────────────────────

/**
 * Determina el sesgo del mercado usando el marketScore compuesto (0-100).
 *
 * Ventaja sobre la versión anterior (solo EMA):
 *   El marketScore integra EMA200, EMA50/200 cruce, Supertrend, ADX, RSI y Bollinger.
 *   Es mucho más robusto ante ruido y falsos cruces.
 *
 * Umbrales calibrados para evitar sobretrading en zonas de transición:
 *   >65 → BULLISH  (grilla LONG o momentum largo)
 *   <40 → BEARISH  (grilla SHORT o pausa / cobertura)
 *   40-65 → NEUTRAL (grilla neutra)
 *
 * Seguridades adicionales:
 *   - isFreefalling → fuerza BEARISH independientemente del score
 *   - freefallSeverity >= 3 → BEARISH extremo (colapso)
 */
export function detectMarketBias(indicators: IndicatorsResult): MarketBias {
  const { marketScore, marketPhase, isFreefalling, freefallSeverity } = indicators;

  // Colapso activo → siempre bajista
  if (isFreefalling || freefallSeverity >= 2 || marketPhase === "COLLAPSE") {
    return "BEARISH";
  }

  if (marketScore >= 66) return "BULLISH";
  if (marketScore <= 40) return "BEARISH";
  return "NEUTRAL";
}

/**
 * Sobrecarga para compatibilidad con backtest (usa parámetros individuales).
 * El backtest actual usa la firma antigua con price/ema50/ema200/rsi.
 */
export function detectMarketBiasLegacy(
  currentPrice: number,
  ema50: number | null,
  ema200: number | null,
  rsi: number[],
): MarketBias {
  if (!ema50 || !ema200) return "NEUTRAL";
  const priceAboveEma200 = currentPrice > ema200;
  const ema50AboveEma200 = ema50 > ema200;
  if (priceAboveEma200 && ema50AboveEma200) return "BULLISH";
  if (!priceAboveEma200 && !ema50AboveEma200) return "BEARISH";
  if (rsi.length > 0) {
    const lastRsi = rsi[rsi.length - 1];
    if (lastRsi > 65 && priceAboveEma200) return "BULLISH";
    if (lastRsi < 35 && !priceAboveEma200) return "BEARISH";
  }
  return "NEUTRAL";
}

/**
 * Dirección del grid según modo de estrategia y sesgo detectado.
 */
export function getGridDirection(
  strategyMode: GridConfig["strategyMode"],
  marketBias: MarketBias
): "LONG" | "SHORT" | "NEUTRAL" {
  switch (strategyMode) {
    case "LONG_GRID":
    case "BULL_MOMENTUM":
      return "LONG";
    case "SHORT_GRID":
    case "BEAR_BREAKDOWN":
      return "SHORT";
    case "AUTO_GRID":
      if (marketBias === "BULLISH") return "LONG";
      if (marketBias === "BEARISH") return "SHORT";
      return "NEUTRAL";
    case "NEUTRAL_GRID":
    default:
      return "NEUTRAL";
  }
}

// ─── Trailing Stop ───────────────────────────────────────────────────────────

/**
 * Trailing stop dinámico basado en ATR.
 *
 * Para LONG: trailingStop = peakPrice - (ATR * mult)
 *   Solo sube (se asegura la ganancia progresivamente).
 *
 * Para SHORT: trailingStop = troughPrice + (ATR * mult)
 *   Solo baja (se asegura la ganancia progresivamente).
 */
export function calculateTrailingStop(
  side: "long" | "short",
  currentPrice: number,
  peakOrTrough: number,
  atr: number,
  multiplier: number,
  previousTrailingStop: number | null
): { newTrailingStop: number; newPeakOrTrough: number } {
  if (side === "long") {
    const newPeak = Math.max(peakOrTrough, currentPrice);
    const newStop = newPeak - atr * multiplier;
    const finalStop = previousTrailingStop !== null
      ? Math.max(previousTrailingStop, newStop)
      : newStop;
    return { newTrailingStop: finalStop, newPeakOrTrough: newPeak };
  } else {
    const newTrough = Math.min(peakOrTrough, currentPrice);
    const newStop = newTrough + atr * multiplier;
    const finalStop = previousTrailingStop !== null
      ? Math.min(previousTrailingStop, newStop)
      : newStop;
    return { newTrailingStop: finalStop, newPeakOrTrough: newTrough };
  }
}

// ─── Drawdown y Kill Switch ───────────────────────────────────────────────────

/**
 * Drawdown actual como % del equity máximo histórico.
 * Valor positivo (ej: 10 = 10% de caída desde el pico).
 */
export function calculateDrawdown(
  currentEquity: number,
  maxEquity: number
): number {
  if (maxEquity <= 0) return 0;
  return ((maxEquity - currentEquity) / maxEquity) * 100;
}

/**
 * ¿El drawdown excede el límite máximo?
 * Si true → cerrar todo y pausar el bot.
 */
export function shouldKillSwitch(
  currentDrawdownPct: number,
  maxDrawdownPct: number
): boolean {
  return currentDrawdownPct >= maxDrawdownPct;
}

// ─── Auto-Repositionamiento ─────────────────────────────────────────────────

/**
 * ¿La grilla necesita reposicionarse?
 * Se activa cuando el precio sale del rango por más de 1 step.
 *
 * Guardia: solo reposicionar si el mercado NO está en COLLAPSE.
 * Reposicionar en colapso = comprar cuchillo cayendo.
 */
export function needsRepositioning(
  currentPrice: number,
  lowerPrice: number,
  upperPrice: number,
  gridStep: number,
  marketPhase?: IndicatorsResult["marketPhase"]
): boolean {
  // Nunca reposicionar en colapso — es trampa de liquidez
  if (marketPhase === "COLLAPSE") return false;

  return (
    currentPrice < (lowerPrice - gridStep) ||
    currentPrice > (upperPrice + gridStep)
  );
}

/**
 * Nuevos límites de grilla centrados en el precio actual.
 * Mantiene el rango total original para coherencia de capital.
 *
 * Si tenemos ATR50, el rango se recalcula basado en volatilidad actual.
 */
export function calculateRepositionedRange(
  currentPrice: number,
  originalRange: number,
  atr50?: number | null,
  gridDirection: "LONG" | "SHORT" | "NEUTRAL" = "NEUTRAL"
): { newLower: number; newUpper: number } {
  // Si hay ATR50 disponible, usarlo para dimensionar el nuevo rango
  if (atr50 && atr50 > 0) {
    const autoRangeResult = calculateAutoRange(currentPrice, atr50, 2.0, gridDirection);
    return { newLower: autoRangeResult.lowerPrice, newUpper: autoRangeResult.upperPrice };
  }

  // Fallback: mantener el rango original centrado en el nuevo precio
  const halfRange = originalRange / 2;
  return {
    newLower: parseFloat((currentPrice - halfRange).toFixed(2)),
    newUpper: parseFloat((currentPrice + halfRange).toFixed(2)),
  };
}

// ─── Cooldown de Señales ─────────────────────────────────────────────────────

/** Período mínimo entre señales direccionales: 5 minutos */
export const SIGNAL_COOLDOWN_MS = 5 * 60 * 1000;

/** ¿Ha pasado suficiente tiempo desde la última señal? */
export function canEmitSignal(lastSignalTime: number): boolean {
  return Date.now() - lastSignalTime >= SIGNAL_COOLDOWN_MS;
}

// ─── Formateo ────────────────────────────────────────────────────────────────

export function formatPrice(price: number): string {
  if (price >= 1000) return price.toFixed(2);
  if (price >= 1) return price.toFixed(4);
  return price.toFixed(8);
}

export function formatPnL(pnl: number): { text: string; colorClass: string } {
  const sign = pnl >= 0 ? "+" : "";
  return {
    text: `${sign}$${pnl.toFixed(4)}`,
    colorClass: pnl >= 0 ? "text-emerald-400" : "text-red-400",
  };
}

// ─── Estado Inicial ──────────────────────────────────────────────────────────

/**
 * Crea el estado inicial del grid bot.
 * Para modos de grilla calcula los niveles con el tipo correcto (GEOMETRIC/ARITHMETIC).
 */
export function createGridState(config: GridConfig): GridState {
  const isGridMode = ["NEUTRAL_GRID", "LONG_GRID", "SHORT_GRID", "AUTO_GRID"].includes(config.strategyMode);
  const levels = isGridMode
    ? calculateGridLevels(config.lowerPrice, config.upperPrice, config.gridCount, config.gridType ?? "GEOMETRIC")
    : [];

  return {
    config,
    levels: levels.map((price) => ({
      price,
      type: "buy" as const,
      filled: false,
      profit: 0,
    })),
    currentPrice: 0,
    totalPnL: 0,
    totalVolume: 0,
    filledOrders: 0,
    startTime: Date.now(),
    isRunning: false,
    logs: [],
    position: null,
    indicators: null,
    marketBias: "NEUTRAL",
    trailingStopPrice: null,
    peakPrice: null,
    troughPrice: null,
    maxEquity: config.totalInvestment,
    currentDrawdownPct: 0,
    gridRepositionCount: 0,
    lastSignalTime: 0,
  };
}

export function addLog(
  logs: LogEntry[],
  level: LogEntry["level"],
  message: string
): LogEntry[] {
  const entry: LogEntry = { timestamp: Date.now(), level, message };
  return [entry, ...logs].slice(0, 200);
}
