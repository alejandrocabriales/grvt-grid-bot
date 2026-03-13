/**
 * Grid Bot Strategy Logic
 * Arithmetic Grid: uniform price spacing between lower and upper bounds
 */

export interface GridConfig {
  pair: string;           // e.g. "ETH_USDT_Perp"
  upperPrice: number;
  lowerPrice: number;
  gridCount: number;      // number of grid lines
  totalInvestment: number; // in USDC (real balance)
  leverage: number;        // e.g. 5 → effective capital = totalInvestment * leverage
  // Las credenciales (apiKey, privateKey, subAccountId) viven exclusivamente
  // en el servidor (.env) y nunca se incluyen en este objeto del cliente.
}

export interface GridLevel {
  price: number;
  type: "buy" | "sell";
  orderId?: string;
  clientOrderId?: string;
  filled: boolean;
  profit: number;
}

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
}

export interface LogEntry {
  timestamp: number;
  level: "info" | "warn" | "error" | "success";
  message: string;
}

/**
 * Calculate all grid price levels (arithmetic)
 * Returns an array of prices from lower to upper, evenly spaced
 */
export function calculateGridLevels(
  lowerPrice: number,
  upperPrice: number,
  gridCount: number
): number[] {
  if (gridCount < 2) throw new Error("Need at least 2 grids");
  if (lowerPrice >= upperPrice) throw new Error("Lower price must be < upper price");

  const step = (upperPrice - lowerPrice) / gridCount;
  const levels: number[] = [];

  for (let i = 0; i <= gridCount; i++) {
    levels.push(parseFloat((lowerPrice + step * i).toFixed(8)));
  }

  return levels;
}

/**
 * Calculate order size per grid level.
 *
 * Key insight: totalInvestment is the user's REAL margin/balance.
 * With leverage, each dollar of margin controls `leverage` dollars of notional.
 * We divide the real balance across all grid levels, and each level's
 * order size = (margin_per_grid * leverage) / price.
 *
 * Example: $49 balance, 10x leverage, 3 grids, ETH @ $2100
 *   margin_per_grid = $49 / 3 = $16.33
 *   notional_per_grid = $16.33 * 10 = $163.33
 *   size = $163.33 / $2100 = 0.0778 ETH
 *   required margin = 0.0778 * $2100 / 10 = $16.33 ✓ (fits in balance)
 */
export function calculateOrderSize(
  totalInvestment: number,
  gridCount: number,
  priceAtLevel: number,
  baseDecimals = 2,
  leverage = 1
): string {
  // margin allocated per grid level (from real balance)
  const marginPerGrid = totalInvestment / gridCount;
  // notional value per grid (amplified by leverage)
  const notionalPerGrid = marginPerGrid * leverage;
  // convert to base asset amount
  const baseAmount = notionalPerGrid / priceAtLevel;
  // Floor to the instrument's allowed decimals to avoid "Order size too granular"
  const factor = 10 ** baseDecimals;
  const floored = Math.floor(baseAmount * factor) / factor;
  return floored.toFixed(baseDecimals);
}

/**
 * Calculate the maximum number of grid levels that can be placed
 * given the min_size constraint. Returns the original gridCount if all fit,
 * or a reduced count so each order meets the minimum.
 */
export function calculateMaxGrids(
  totalInvestment: number,
  gridCount: number,
  referencePrice: number,
  minSize: number,
  leverage = 1
): number {
  // Size per grid at referencePrice
  const sizePerGrid = (totalInvestment * leverage) / gridCount / referencePrice;
  if (sizePerGrid >= minSize) return gridCount;

  // Max grids where each order >= minSize
  const maxGrids = Math.floor((totalInvestment * leverage) / (minSize * referencePrice));
  return Math.max(maxGrids, 2); // minimum 2 grids
}

/**
 * Calculate grid profit per grid cycle
 * Profit = (sell price - buy price) × size
 */
export function calculateGridProfit(
  buyPrice: number,
  sellPrice: number,
  size: string
): number {
  return (sellPrice - buyPrice) * parseFloat(size);
}

/**
 * Determine initial orders to place based on current price
 * - Below current price: place BUY orders
 * - Above current price: place SELL orders
 */
export function getInitialOrders(
  levels: number[],
  currentPrice: number,
  totalInvestment: number,
  gridCount: number,
  baseDecimals = 2,
  leverage = 1
): Array<{ price: number; type: "buy" | "sell"; size: string }> {
  const orders: Array<{ price: number; type: "buy" | "sell"; size: string }> = [];
  for (const price of levels) {
    if (price === currentPrice) continue;
    const type: "buy" | "sell" = price < currentPrice ? "buy" : "sell";
    const size = calculateOrderSize(totalInvestment, gridCount, price, baseDecimals, leverage);
    if (parseFloat(size) > 0) {
      orders.push({ price, type, size });
    }
  }
  return orders;
}

/**
 * When a BUY order fills at 'price', place SELL at next level above
 * When a SELL order fills at 'price', place BUY at next level below
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
    (p) => Math.abs(p - filledPrice) < 0.0001
  );

  if (idx === -1) return null;

  if (filledType === "buy") {
    // Place SELL one level above
    const sellPrice = sortedLevels[idx + 1];
    if (!sellPrice) return null;
    const size = calculateOrderSize(totalInvestment, gridCount, sellPrice, baseDecimals, leverage);
    return { price: sellPrice, type: "sell", size };
  } else {
    // Place BUY one level below
    const buyPrice = sortedLevels[idx - 1];
    if (!buyPrice) return null;
    const size = calculateOrderSize(totalInvestment, gridCount, buyPrice, baseDecimals, leverage);
    return { price: buyPrice, type: "buy", size };
  }
}

/**
 * Format price for display
 */
export function formatPrice(price: number): string {
  if (price >= 1000) return price.toFixed(2);
  if (price >= 1) return price.toFixed(4);
  return price.toFixed(8);
}

/**
 * Format PnL with sign and color class
 */
export function formatPnL(pnl: number): {
  text: string;
  colorClass: string;
} {
  const sign = pnl >= 0 ? "+" : "";
  return {
    text: `${sign}$${pnl.toFixed(4)}`,
    colorClass: pnl >= 0 ? "text-emerald-400" : "text-red-400",
  };
}

/**
 * Create initial grid state
 */
export function createGridState(config: GridConfig): GridState {
  const levels = calculateGridLevels(
    config.lowerPrice,
    config.upperPrice,
    config.gridCount
  );

  return {
    config,
    levels: levels.map((price) => ({
      price,
      type: "buy",
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
  };
}

export function addLog(
  logs: LogEntry[],
  level: LogEntry["level"],
  message: string
): LogEntry[] {
  const entry: LogEntry = { timestamp: Date.now(), level, message };
  return [entry, ...logs].slice(0, 200); // keep last 200 logs
}
