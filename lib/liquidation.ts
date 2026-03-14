/**
 * Liquidation Price Calculations for Perpetual Futures
 *
 * For isolated margin positions:
 *   Long:  liqPrice = entryPrice * (1 - (1 - MMR) / leverage)
 *   Short: liqPrice = entryPrice * (1 + (1 - MMR) / leverage)
 *
 * MMR = Maintenance Margin Rate (typically 0.5% = 0.005 for most perps)
 */

export interface LiquidationInfo {
  liquidationPrice: number;
  distancePercent: number; // how far current price is from liquidation (positive = safe)
  isDanger: boolean;       // true when distance < 5%
}

/**
 * Calculate liquidation price for a perpetual futures position.
 * @param entryPrice - Average entry price
 * @param leverage - Position leverage (e.g. 20)
 * @param side - "long" or "short"
 * @param mmr - Maintenance margin rate (default 0.005 = 0.5%)
 */
export function calculateLiquidationPrice(
  entryPrice: number,
  leverage: number,
  side: "long" | "short",
  mmr = 0.005
): number {
  if (leverage <= 0 || entryPrice <= 0) return 0;

  if (side === "long") {
    // Price drops → liquidation
    return entryPrice * (1 - (1 - mmr) / leverage);
  } else {
    // Price rises → liquidation
    return entryPrice * (1 + (1 - mmr) / leverage);
  }
}

/**
 * Calculate how far the current price is from liquidation.
 * Returns positive percentage when safe, negative when past liquidation.
 */
export function calculateDistanceToLiquidation(
  currentPrice: number,
  liquidationPrice: number,
  side: "long" | "short"
): number {
  if (liquidationPrice <= 0 || currentPrice <= 0) return 100;

  if (side === "long") {
    // For longs, we want currentPrice > liqPrice
    return ((currentPrice - liquidationPrice) / currentPrice) * 100;
  } else {
    // For shorts, we want currentPrice < liqPrice
    return ((liquidationPrice - currentPrice) / currentPrice) * 100;
  }
}

/**
 * Get full liquidation info for display.
 */
export function getLiquidationInfo(
  entryPrice: number,
  leverage: number,
  side: "long" | "short",
  currentPrice: number,
  mmr = 0.005
): LiquidationInfo {
  const liquidationPrice = calculateLiquidationPrice(entryPrice, leverage, side, mmr);
  const distancePercent = calculateDistanceToLiquidation(currentPrice, liquidationPrice, side);

  return {
    liquidationPrice,
    distancePercent,
    isDanger: distancePercent < 5,
  };
}
