"use client";

/**
 * useGridBot — Hook principal del bot de grilla (Versión Institucional).
 *
 * Mejoras sobre la versión anterior:
 * 1. Multi-timeframe: 1h macro (sesgo) + 5m micro (entradas) — visión completa del mercado
 * 2. Grid geométrico: profit % uniforme por nivel (hereda gridType de config)
 * 3. Rango automático basado en ATR50: el rango se dimensiona según volatilidad real
 * 4. Confirmación técnica por nivel: hasBuyConfirmation() antes de cada orden de compra
 * 5. Guardia anti-freefall: no se colocan compras si isFreefalling
 * 6. Repositionamiento inteligente: solo si marketPhase !== "COLLAPSE"
 * 7. Sesgo de mercado compuesto: usa marketScore 0-100 (no solo EMA)
 * 8. Polling de indicadores cada 30s (era 60s)
 * 9. Kill switch, trailing stop, cooldown y LONG/SHORT/AUTO heredados
 *
 * Arquitectura: Browser → /api/bot/* (Next.js server) → GRVT API
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  GridConfig,
  GridState,
  MarketBias,
  addLog,
  calculateGridLevels,
  calculateAutoRange,
  calculateMaxGrids,
  calculateOrderSize,
  calculateDirectionalSize,
  calculateTrailingStop,
  calculateDrawdown,
  shouldKillSwitch,
  needsRepositioning,
  calculateRepositionedRange,
  canEmitSignal,
  createGridState,
  detectMarketBias,
  getGridDirection,
  getCounterOrder,
  getInitialOrders,
} from "@/lib/grid-bot";
import {
  calculateIndicators,
  IndicatorsResult,
  isSafeToGrid,
  hasBuyConfirmation,
  isHighVolatility,
  isOverbought,
  isOversold,
  rsiCrossUp,
  macdCrossDown,
  macdCrossUp,
} from "@/lib/indicators";

const WS_URL =
  process.env.NEXT_PUBLIC_GRVT_USE_TESTNET === "true"
    ? "wss://market-data.testnet.grvt.io/ws/full"
    : "wss://market-data.grvt.io/ws/full";

export interface UseGridBotReturn {
  state: GridState | null;
  currentPrice: number;
  isConnecting: boolean;
  error: string | null;
  startBot: (config: GridConfig) => Promise<void>;
  stopBot: () => Promise<void>;
}

// ─── Helpers de API interna ───────────────────────────────────────────────────

async function apiAuth(): Promise<void> {
  const res = await fetch("/api/bot/auth", { method: "POST" });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error ?? "Auth failed");
}

async function apiCreateOrder(
  instrument: string,
  size: string,
  limitPrice: string,
  isBuying: boolean
): Promise<string> {
  const res = await fetch("/api/bot/orders/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instrument, size, limitPrice, isBuying }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error ?? "Create order failed");
  return data.order_id as string;
}

async function apiCancelAll(instrument: string): Promise<void> {
  const res = await fetch("/api/bot/orders/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instrument }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error ?? "Cancel failed");
}

async function apiGetOpenOrders(
  instrument: string
): Promise<Array<{ limit_price: string; id: string }>> {
  const res = await fetch(`/api/bot/orders/open?instrument=${instrument}`);
  const data = await res.json();
  return data.orders ?? [];
}

async function apiGetPositions(instrument: string): Promise<import("@/lib/grvt-api").Position | null> {
  const res = await fetch(`/api/bot/positions?instrument=${instrument}`);
  const data = await res.json();
  if (!data.ok) return null;
  const pos = data.positions?.find((p: import("@/lib/grvt-api").Position) => p.instrument === instrument);
  return pos || null;
}

async function apiClosePosition(instrument: string): Promise<void> {
  const res = await fetch("/api/bot/orders/close-position", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instrument }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error ?? "Close position failed");
}

async function apiGetPrice(instrument: string): Promise<{
  price: number;
  sizeDecimals: number;
  priceDecimals: number;
  minSize: string;
}> {
  const res = await fetch(`/api/bot/price?instrument=${instrument}`);
  const data = await res.json();
  return {
    price: data.price ?? 0,
    sizeDecimals: data.sizeDecimals ?? 2,
    priceDecimals: data.priceDecimals ?? 2,
    minSize: data.minSize ?? "0.01",
  };
}

async function apiGetBalance(): Promise<number> {
  const res = await fetch("/api/bot/balance");
  const data = await res.json();
  return parseFloat(data.equity) || 0;
}

async function apiGetKlines(
  instrument: string,
  interval: string = "5m",
  limit: number = 250
) {
  const res = await fetch(
    `/api/bot/klines?instrument=${instrument}&interval=${interval}&limit=${limit}`
  );
  const data = await res.json();
  return data.ok ? data.klines : [];
}

async function apiSetLeverage(instrument: string, leverage: number): Promise<void> {
  const res = await fetch("/api/bot/leverage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instrument, leverage }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error ?? "Set leverage failed");
}

function delay(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

// ─── Hook Principal ──────────────────────────────────────────────────────────

export function useGridBot(): UseGridBotReturn {
  const [state, setState] = useState<GridState | null>(null);
  const [currentPrice, setCurrentPrice] = useState(0);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const configRef = useRef<GridConfig | null>(null);
  const isRunningRef = useRef(false);
  const currentPriceRef = useRef(0);
  const sizeDecimalsRef = useRef(2);
  const priceDecimalsRef = useRef(2);
  const minSizeRef = useRef(0.01);

  // Indicadores en ref para acceso sin setState en callbacks de WS
  const indicatorsRef = useRef<IndicatorsResult | null>(null);

  // ─── Cleanup ──────────────────────────────────────────────────────────

  const cleanup = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    isRunningRef.current = false;
  }, []);

  // ─── Colocar una orden límite ─────────────────────────────────────────

  const placeLimitOrder = useCallback(
    async (price: number, type: "buy" | "sell", size: string): Promise<string | null> => {
      const config = configRef.current;
      if (!config || !isRunningRef.current) return null;

      try {
        const formattedPrice = price.toFixed(priceDecimalsRef.current);
        const orderId = await apiCreateOrder(
          config.pair,
          size,
          formattedPrice,
          type === "buy"
        );

        setState((prev) =>
          prev
            ? {
                ...prev,
                levels: prev.levels.map((l) =>
                  Math.abs(l.price - price) / price < 0.0005 ? { ...l, orderId, type } : l
                ),
                logs: addLog(
                  prev.logs,
                  "success",
                  `${type.toUpperCase()} @ $${price.toFixed(2)} | size: ${size} | id: ${orderId.slice(0, 8)}...`
                ),
              }
            : prev
        );
        return orderId;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setState((prev) =>
          prev
            ? { ...prev, logs: addLog(prev.logs, "error", `Orden fallida @ $${price.toFixed(2)}: ${msg}`) }
            : prev
        );
        return null;
      }
    },
    []
  );

  // ─── Inicializar grilla ───────────────────────────────────────────────

  /**
   * Coloca las órdenes iniciales de la grilla.
   *
   * Mejoras institucionales:
   * - Usa gridType (GEOMETRIC/ARITHMETIC) de la config
   * - Aplica hasBuyConfirmation() antes de cada orden de compra
   * - Bloquea BUYs si isFreefalling o no isSafeToGrid
   * - SHORT sells no necesitan confirmación de compra
   */
  const initializeGrid = useCallback(
    async (
      config: GridConfig,
      price: number,
      gridDirection: "LONG" | "SHORT" | "NEUTRAL" = "NEUTRAL"
    ) => {
      const gridType = config.gridType ?? "GEOMETRIC";
      const levels = calculateGridLevels(
        config.lowerPrice,
        config.upperPrice,
        config.gridCount,
        gridType
      );

      const orders = getInitialOrders(
        levels,
        price,
        config.totalInvestment,
        config.gridCount,
        sizeDecimalsRef.current,
        config.leverage,
        gridDirection
      );

      const indicators = indicatorsRef.current;
      const marketSafe = !indicators || isSafeToGrid(indicators);

      const dirLabel =
        gridDirection === "SHORT" ? "[SHORT GRID]" :
        gridDirection === "LONG" ? "[LONG GRID]" :
        "[NEUTRAL GRID]";

      const typeLabel = gridType === "GEOMETRIC" ? "geométrica" : "aritmética";
      setState((prev) =>
        prev
          ? {
              ...prev,
              logs: addLog(
                prev.logs,
                "info",
                `${dirLabel} Grilla ${typeLabel}: ${orders.length} órdenes iniciales`
              ),
            }
          : prev
      );

      // Advertir si el mercado no es seguro para compras
      if (!marketSafe) {
        setState((prev) =>
          prev
            ? {
                ...prev,
                logs: addLog(
                  prev.logs,
                  "warn",
                  "[GUARDIA] Mercado en COLLAPSE o freefall — órdenes BUY bloqueadas temporalmente"
                ),
              }
            : prev
        );
      }

      for (const order of orders) {
        if (!isRunningRef.current) break;

        // ─── Filtro por nivel: solo BUYs necesitan confirmación ───
        if (order.type === "buy") {
          // Bloquear en colapso o caída libre
          if (!marketSafe) {
            setState((prev) =>
              prev
                ? {
                    ...prev,
                    logs: addLog(
                      prev.logs,
                      "warn",
                      `[FILTRO] BUY @ $${order.price.toFixed(2)} omitido — mercado en caída libre`
                    ),
                  }
                : prev
            );
            continue;
          }

          // Confirmación técnica: STRICT en mercado bajista, NORMAL en neutral, LOOSE en alcista
          if (indicators) {
            const bias = detectMarketBias(indicators);
            const confirmMode =
              bias === "BEARISH" ? "STRICT" :
              bias === "NEUTRAL" ? "NORMAL" :
              "LOOSE";

            if (!hasBuyConfirmation(indicators, confirmMode)) {
              setState((prev) =>
                prev
                  ? {
                      ...prev,
                      logs: addLog(
                        prev.logs,
                        "warn",
                        `[FILTRO] BUY @ $${order.price.toFixed(2)} omitido — sin confirmación técnica (${confirmMode})`
                      ),
                    }
                  : prev
              );
              continue;
            }
          }
        }

        await placeLimitOrder(order.price, order.type, order.size);
        await delay(220); // Respetar rate limiting de GRVT (~5 órdenes/seg)
      }
    },
    [placeLimitOrder]
  );

  // ─── Manejo de Fill ───────────────────────────────────────────────────

  const handleFill = useCallback(
    async (filledPrice: number, filledType: "buy" | "sell", size: string) => {
      const config = configRef.current;
      if (!config || !isRunningRef.current) return;

      const gridType = config.gridType ?? "GEOMETRIC";
      const isShortGrid = config.strategyMode === "SHORT_GRID";

      // Para grilla geométrica, el profit por ciclo = precio_venta - precio_compra
      // La estimación usa el step geométrico entre niveles adyacentes
      const levels = calculateGridLevels(
        config.lowerPrice, config.upperPrice, config.gridCount, gridType
      );
      const sortedLevels = [...levels].sort((a, b) => a - b);
      const idx = sortedLevels.findIndex(
        (p) => Math.abs(p - filledPrice) / filledPrice < 0.001
      );

      let estimatedStep = (config.upperPrice - config.lowerPrice) / config.gridCount;
      if (idx >= 0 && idx < sortedLevels.length - 1) {
        // Usar el step real del nivel siguiente
        estimatedStep = sortedLevels[idx + 1] - sortedLevels[idx];
      }

      let profit = 0;
      if (isShortGrid) {
        profit = filledType === "buy" ? estimatedStep * parseFloat(size) * 0.998 : 0;
      } else {
        profit = filledType === "sell" ? estimatedStep * parseFloat(size) * 0.998 : 0;
      }

      setState((prev) =>
        prev
          ? {
              ...prev,
              totalPnL: prev.totalPnL + profit,
              totalVolume: prev.totalVolume + filledPrice * parseFloat(size),
              filledOrders: prev.filledOrders + 1,
              logs: addLog(
                prev.logs,
                "success",
                `${filledType.toUpperCase()} filled @ $${filledPrice.toFixed(2)} | PnL ciclo: ${profit > 0 ? "+" : ""}$${profit.toFixed(4)}`
              ),
            }
          : prev
      );

      // Colocar contra-orden
      const counter = getCounterOrder(
        filledPrice,
        filledType,
        levels,
        config.totalInvestment,
        config.gridCount,
        sizeDecimalsRef.current,
        config.leverage
      );

      if (counter && isRunningRef.current) {
        // Para contra-órdenes de compra, también aplicar confirmación técnica
        if (counter.type === "buy") {
          const indicators = indicatorsRef.current;
          if (indicators && !isSafeToGrid(indicators)) {
            setState((prev) =>
              prev
                ? {
                    ...prev,
                    logs: addLog(
                      prev.logs,
                      "warn",
                      `[FILTRO] Contra-orden BUY @ $${counter.price.toFixed(2)} diferida — mercado no seguro`
                    ),
                  }
                : prev
            );
            return; // No colocar la contra-orden ahora; se recolocará en el próximo ciclo
          }
        }

        await delay(300);
        await placeLimitOrder(counter.price, counter.type, counter.size);
      }
    },
    [placeLimitOrder]
  );

  // ─── Cierre de Posición ───────────────────────────────────────────────

  const triggerClosePosition = useCallback(
    async (reason: string) => {
      if (!isRunningRef.current) return;
      const config = configRef.current;
      if (!config) return;

      isRunningRef.current = false;

      setState((prev) =>
        prev
          ? {
              ...prev,
              isRunning: false,
              logs: addLog(
                prev.logs,
                "warn",
                `[PROTECCION] ${reason}. Cerrando posición y cancelando órdenes...`
              ),
            }
          : prev
      );

      try {
        await apiCancelAll(config.pair);
        await apiClosePosition(config.pair);
        setState((prev) =>
          prev
            ? {
                ...prev,
                logs: addLog(prev.logs, "success", "Posición cerrada y órdenes canceladas."),
                position: null,
                trailingStopPrice: null,
              }
            : prev
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setState((prev) =>
          prev
            ? {
                ...prev,
                logs: addLog(prev.logs, "error", `Error al cerrar posición: ${msg}`),
              }
            : prev
        );
      }

      cleanup();
    },
    [cleanup]
  );

  // ─── Auto-Repositionamiento ───────────────────────────────────────────

  /**
   * Reposiciona la grilla centrada en el nuevo precio.
   *
   * Guardia: solo se ejecuta si marketPhase !== "COLLAPSE".
   * Si hay ATR50, el rango se recalcula según volatilidad actual.
   */
  const repositionGrid = useCallback(
    async (config: GridConfig, newPrice: number) => {
      if (!isRunningRef.current) return;

      const indicators = indicatorsRef.current;

      // Guardia anti-colapso: no reposicionar en colapso (comprar cuchillo)
      if (indicators?.marketPhase === "COLLAPSE") {
        setState((prev) =>
          prev
            ? {
                ...prev,
                logs: addLog(
                  prev.logs,
                  "warn",
                  "[REPOSITION] Bloqueado — mercado en COLLAPSE. Esperando recuperación..."
                ),
              }
            : prev
        );
        return;
      }

      const originalRange = config.upperPrice - config.lowerPrice;
      const bias = indicators ? detectMarketBias(indicators) : "NEUTRAL";
      const direction = getGridDirection(config.strategyMode, bias);
      const { newLower, newUpper } = calculateRepositionedRange(
        newPrice,
        originalRange,
        indicators?.atr50 ?? null,
        direction
      );

      setState((prev) =>
        prev
          ? {
              ...prev,
              logs: addLog(
                prev.logs,
                "warn",
                `[REPOSITION] Nueva grilla: [$${newLower.toFixed(2)} – $${newUpper.toFixed(2)}] | Dirección: ${direction}`
              ),
              gridRepositionCount: prev.gridRepositionCount + 1,
            }
          : prev
      );

      try {
        await apiCancelAll(config.pair);
      } catch {
        // Continuar si falla la cancelación
      }

      const newConfig: GridConfig = { ...config, lowerPrice: newLower, upperPrice: newUpper };
      configRef.current = newConfig;
      setState((prev) => (prev ? { ...prev, config: newConfig } : prev));

      await delay(500);
      await initializeGrid(newConfig, newPrice, direction);
    },
    [initializeGrid]
  );

  // ─── WebSocket (precio en tiempo real + protecciones) ─────────────────

  const connectWebSocket = useCallback(
    (config: GridConfig) => {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        setState((prev) =>
          prev ? { ...prev, logs: addLog(prev.logs, "info", "WebSocket conectado") } : prev
        );
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "subscribe",
            params: { stream: "mini.s", selectors: [config.pair] },
            id: 1,
          })
        );
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);

          if (msg?.result?.channel?.includes("mini")) {
            const feed = msg.result.feed;
            const p = parseFloat(
              feed?.mark_price ?? feed?.oracle_price ?? feed?.last ?? "0"
            );
            if (p <= 0) return;

            setCurrentPrice(p);
            currentPriceRef.current = p;

            setState((prev) => {
              if (!prev) return prev;
              const newState = { ...prev, currentPrice: p };

              const position = prev.position;
              if (!position) return newState;

              const size = parseFloat(position.size || "0");
              if (size === 0) return newState;

              const side: "long" | "short" = size > 0 ? "long" : "short";

              // SL / TP estático
              const sl = prev.config.stopLoss;
              const tp = prev.config.takeProfit;
              if (sl || tp) {
                let triggered = "";
                if (side === "long") {
                  if (sl && p <= sl) triggered = "Stop Loss (LONG)";
                  if (tp && p >= tp) triggered = "Take Profit (LONG)";
                } else {
                  if (sl && p >= sl) triggered = "Stop Loss (SHORT)";
                  if (tp && p <= tp) triggered = "Take Profit (SHORT)";
                }
                if (triggered) {
                  setTimeout(() => triggerClosePosition(triggered), 0);
                  return newState;
                }
              }

              // Trailing Stop dinámico
              if (prev.config.enableTrailingStop && prev.trailingStopPrice !== null) {
                if (side === "long" && p <= prev.trailingStopPrice) {
                  setTimeout(() => triggerClosePosition(
                    `Trailing Stop (LONG) @ $${prev.trailingStopPrice!.toFixed(2)}`
                  ), 0);
                  return newState;
                }
                if (side === "short" && p >= prev.trailingStopPrice) {
                  setTimeout(() => triggerClosePosition(
                    `Trailing Stop (SHORT) @ $${prev.trailingStopPrice!.toFixed(2)}`
                  ), 0);
                  return newState;
                }
              }

              return newState;
            });
          }
        } catch {
          // Ignorar mensajes malformados
        }
      };

      ws.onerror = () => {
        setState((prev) =>
          prev ? { ...prev, logs: addLog(prev.logs, "error", "WebSocket error") } : prev
        );
      };

      ws.onclose = () => {
        if (!isRunningRef.current) return;
        setState((prev) =>
          prev
            ? {
                ...prev,
                logs: addLog(prev.logs, "warn", "WebSocket desconectado. Reconectando en 3s..."),
              }
            : prev
        );
        setTimeout(() => {
          if (isRunningRef.current && configRef.current) {
            connectWebSocket(configRef.current);
          }
        }, 3000);
      };
    },
    [triggerClosePosition]
  );

  // ─── Polling de órdenes (detección de fills) ─────────────────────────

  const startOrderPolling = useCallback(
    (config: GridConfig) => {
      const poll = async () => {
        if (!isRunningRef.current) return;
        try {
          const orders = await apiGetOpenOrders(config.pair);
          const openOrderIds = new Set(orders.map((o) => o.id));

          setState((prev) => {
            if (!prev) return prev;

            const filledLevels = prev.levels.filter(
              (l) => l.orderId && !openOrderIds.has(l.orderId) && !l.filled
            );

            if (filledLevels.length > 0) {
              setTimeout(() => {
                filledLevels.forEach((l) => {
                  const size = calculateOrderSize(
                    config.totalInvestment,
                    config.gridCount,
                    l.price,
                    sizeDecimalsRef.current,
                    config.leverage
                  );
                  handleFill(l.price, l.type, size);
                });
              }, 0);

              const newLevels = prev.levels.map((l) => {
                if (l.orderId && !openOrderIds.has(l.orderId)) {
                  return { ...l, filled: true, orderId: undefined };
                }
                return l;
              });
              return { ...prev, levels: newLevels };
            }
            return prev;
          });
        } catch {
          // Silenciosamente continuar
        }
        if (isRunningRef.current) setTimeout(poll, 3_000);
      };
      setTimeout(poll, 3_000);
    },
    [handleFill]
  );

  // ─── Polling de posición + trailing stop + drawdown ───────────────────

  const startPositionPolling = useCallback(
    (config: GridConfig) => {
      const poll = async () => {
        if (!isRunningRef.current) return;
        try {
          const position = await apiGetPositions(config.pair);

          setState((prev) => {
            if (!prev) return prev;
            let newState = { ...prev, position };

            if (position) {
              const size = parseFloat(position.size || "0");
              const side: "long" | "short" = size > 0 ? "long" : "short";
              const price = currentPriceRef.current;
              const atr = indicatorsRef.current?.atr14 ?? indicatorsRef.current?.atr ?? null;

              // Actualizar Trailing Stop
              if (config.enableTrailingStop && atr !== null && size !== 0) {
                const mult = config.trailingAtrMult ?? 2.0;
                const peakOrTrough =
                  side === "long"
                    ? (prev.peakPrice ?? price)
                    : (prev.troughPrice ?? price);

                const result = calculateTrailingStop(
                  side, price, peakOrTrough, atr, mult, prev.trailingStopPrice
                );

                newState = {
                  ...newState,
                  trailingStopPrice: result.newTrailingStop,
                  peakPrice: side === "long" ? result.newPeakOrTrough : prev.peakPrice,
                  troughPrice: side === "short" ? result.newPeakOrTrough : prev.troughPrice,
                };
              }

              // Calcular Drawdown
              const unrealizedPnl = parseFloat(position.unrealized_pnl || "0");
              const equity = config.totalInvestment + unrealizedPnl + prev.totalPnL;
              const maxEquity = Math.max(prev.maxEquity, equity);
              const drawdown = calculateDrawdown(equity, maxEquity);

              newState = { ...newState, maxEquity, currentDrawdownPct: drawdown };

              // Kill Switch
              const maxDD = config.maxDrawdownPct ?? 15;
              if (shouldKillSwitch(drawdown, maxDD)) {
                setTimeout(() => triggerClosePosition(
                  `Max Drawdown alcanzado (${drawdown.toFixed(1)}% >= ${maxDD}%)`
                ), 0);
              }
            } else {
              newState = {
                ...newState,
                trailingStopPrice: null,
                peakPrice: null,
                troughPrice: null,
              };
            }

            return newState;
          });
        } catch {
          // Ignorar
        }
        if (isRunningRef.current) setTimeout(poll, 5_000);
      };
      setTimeout(poll, 2_000);
    },
    [triggerClosePosition]
  );

  // ─── Estrategias Direccionales ────────────────────────────────────────

  const evaluateDirectionalStrategy = useCallback(
    async (config: GridConfig, indicators: IndicatorsResult) => {
      if (
        config.strategyMode !== "BULL_MOMENTUM" &&
        config.strategyMode !== "BEAR_BREAKDOWN"
      ) return;

      if (
        !indicators.ema50 ||
        !indicators.ema200 ||
        !indicators.atr14 ||
        indicators.rsi.length < 2 ||
        indicators.macd.length < 2
      ) return;

      const lastSignalState = await new Promise<number>((resolve) => {
        setState((prev) => {
          resolve(prev?.lastSignalTime ?? 0);
          return prev;
        });
      });
      if (!canEmitSignal(lastSignalState)) return;

      // Volatilidad extrema → no operar
      if (isHighVolatility(indicators.volatilityRatio, 0.04)) {
        setState((prev) =>
          prev
            ? {
                ...prev,
                logs: addLog(
                  prev.logs,
                  "warn",
                  `[FILTRO] Volatilidad extrema (${((indicators.volatilityRatio ?? 0) * 100).toFixed(2)}%). Señal ignorada.`
                ),
              }
            : prev
        );
        return;
      }

      // Freefall → no nuevas compras (BULL_MOMENTUM)
      if (config.strategyMode === "BULL_MOMENTUM" && indicators.isFreefalling) {
        setState((prev) =>
          prev
            ? {
                ...prev,
                logs: addLog(
                  prev.logs,
                  "warn",
                  `[GUARDIA] Freefall detectado (severidad: ${indicators.freefallSeverity}). Señal BULL ignorada.`
                ),
              }
            : prev
        );
        return;
      }

      try {
        const position = await apiGetPositions(config.pair);
        const hasPosition =
          position !== null && parseFloat(position.size || "0") !== 0;
        const price = currentPriceRef.current;
        const atr = indicators.atr14!;
        const riskPct = config.riskPerTrade ?? 1.5;
        const atrMult = config.atrMultiplier ?? 1.5;

        if (!hasPosition) {
          if (config.strategyMode === "BULL_MOMENTUM") {
            const trendUp =
              price > indicators.ema50! && price > indicators.ema200!;
            const rsiSignal = rsiCrossUp(indicators.rsi, 40);
            const lastMacd = indicators.macd[indicators.macd.length - 1];
            const macdConfirm = (lastMacd.histogram ?? 0) > 0;

            // Confirmación técnica adicional (modo NORMAL para entradas direccionales)
            const hasConfirm = hasBuyConfirmation(indicators, "NORMAL");

            if (trendUp && rsiSignal && macdConfirm && hasConfirm) {
              const slPrice = price - atr * atrMult;
              const size = calculateDirectionalSize(
                config.totalInvestment, riskPct, price, slPrice,
                sizeDecimalsRef.current, config.leverage
              );

              if (parseFloat(size) > 0) {
                setState((prev) =>
                  prev
                    ? {
                        ...prev,
                        lastSignalTime: Date.now(),
                        logs: addLog(
                          prev.logs,
                          "success",
                          `[BULL] Señal COMPRA. Precio: $${price.toFixed(2)} | SL: $${slPrice.toFixed(2)} | Size: ${size}`
                        ),
                      }
                    : prev
                );
                await apiCreateOrder(
                  config.pair,
                  size,
                  price.toFixed(priceDecimalsRef.current),
                  true
                );
              }
            }
          } else if (config.strategyMode === "BEAR_BREAKDOWN") {
            const trendDown = price < indicators.ema100!;
            const macdSignal = macdCrossDown(indicators.macd);
            const rsiNotOversold = !isOversold(indicators.rsi, 25);

            if (trendDown && macdSignal && rsiNotOversold) {
              const slPrice = price + atr * atrMult;
              const size = calculateDirectionalSize(
                config.totalInvestment, riskPct, price, slPrice,
                sizeDecimalsRef.current, config.leverage
              );

              if (parseFloat(size) > 0) {
                setState((prev) =>
                  prev
                    ? {
                        ...prev,
                        lastSignalTime: Date.now(),
                        logs: addLog(
                          prev.logs,
                          "success",
                          `[BEAR] Señal SHORT. Precio: $${price.toFixed(2)} | SL: $${slPrice.toFixed(2)} | Size: ${size}`
                        ),
                      }
                    : prev
                );
                await apiCreateOrder(
                  config.pair,
                  size,
                  price.toFixed(priceDecimalsRef.current),
                  false
                );
              }
            }
          }
        } else {
          // Lógica de salida
          const posSize = parseFloat(position!.size || "0");
          const side = posSize > 0 ? "long" : "short";

          if (config.strategyMode === "BULL_MOMENTUM" && side === "long") {
            if (isOverbought(indicators.rsi, 75) || indicators.emaCrossState === "DEATH") {
              const reason =
                isOverbought(indicators.rsi, 75)
                  ? `RSI sobrecomprado (${indicators.rsi.at(-1)?.toFixed(1)})`
                  : "Death Cross EMA50/200";
              setState((prev) =>
                prev
                  ? {
                      ...prev,
                      lastSignalTime: Date.now(),
                      logs: addLog(prev.logs, "warn", `[BULL] ${reason}. Cerrando LONG.`),
                    }
                  : prev
              );
              await apiClosePosition(config.pair);
            }
          } else if (config.strategyMode === "BEAR_BREAKDOWN" && side === "short") {
            if (
              isOversold(indicators.rsi, 25) ||
              indicators.emaCrossState === "GOLDEN" ||
              macdCrossUp(indicators.macd)
            ) {
              const lastRsi = indicators.rsi.at(-1) ?? 0;
              const reason =
                isOversold(indicators.rsi, 25)
                  ? `RSI sobrevendido (${lastRsi.toFixed(1)})`
                  : indicators.emaCrossState === "GOLDEN"
                  ? "Golden Cross EMA50/200"
                  : "MACD cruce alcista";
              setState((prev) =>
                prev
                  ? {
                      ...prev,
                      lastSignalTime: Date.now(),
                      logs: addLog(prev.logs, "warn", `[BEAR] ${reason}. Cerrando SHORT.`),
                    }
                  : prev
              );
              await apiClosePosition(config.pair);
            }
          }
        }
      } catch (err) {
        console.error("[Estrategia direccional] Error:", err);
      }
    },
    []
  );

  // ─── Polling de indicadores (multi-timeframe, 30s) ────────────────────

  /**
   * Estrategia de análisis multi-timeframe:
   *   - 1h (macro): detectar sesgo/tendencia principal (fase de mercado)
   *   - 5m (micro): señales de entrada y confirmación técnica por nivel
   *
   * Se usan los indicadores de 1h para marketScore/marketPhase/marketBias.
   * Los indicadores de 5m se usan para señales de entrada y hasBuyConfirmation.
   * Los indicadores micro (5m) son los que se guardan en state para la UI y para
   * hasBuyConfirmation, pero el marketBias se calcula sobre los de 1h.
   */
  const startIndicatorsPolling = useCallback(
    (config: GridConfig) => {
      const poll = async () => {
        if (!isRunningRef.current) return;
        try {
          // Fetch paralelo: 1h macro + 5m micro
          const [klines1h, klines5m] = await Promise.all([
            apiGetKlines(config.pair, "1h", 250),
            apiGetKlines(config.pair, "5m", 250),
          ]);

          const hasMacro = klines1h && klines1h.length > 50;
          const hasMicro = klines5m && klines5m.length > 50;

          if (!hasMicro) {
            if (isRunningRef.current) setTimeout(poll, 30_000);
            return;
          }

          // Calcular indicadores en ambos timeframes
          const indicators5m = calculateIndicators(klines5m);
          const indicators1h = hasMacro ? calculateIndicators(klines1h) : null;

          // El sesgo macro usa 1h si disponible; sino, cae a 5m
          const macroIndicators = indicators1h ?? indicators5m;
          const marketBias = detectMarketBias(macroIndicators);

          // Los indicadores micro (5m) van al estado y a hasBuyConfirmation
          indicatorsRef.current = indicators5m;

          setState((prev) => {
            if (!prev) return prev;
            const prevBias = prev.marketBias;
            const newState = {
              ...prev,
              indicators: indicators5m,
              marketBias,
              logs:
                prevBias !== marketBias
                  ? addLog(
                      prev.logs,
                      "info",
                      `[TENDENCIA] ${hasMacro ? "1h" : "5m"}: ${prevBias} → ${marketBias} | Score: ${macroIndicators.marketScore}/100 | Fase: ${macroIndicators.marketPhase}`
                    )
                  : prev.logs,
            };
            return newState;
          });

          // Loguear estado de freefall si es relevante
          if (indicators5m.isFreefalling && indicators5m.freefallSeverity >= 2) {
            setState((prev) =>
              prev
                ? {
                    ...prev,
                    logs: addLog(
                      prev.logs,
                      "warn",
                      `[FREEFALL] Severidad ${indicators5m.freefallSeverity}/3 — compras bloqueadas`
                    ),
                  }
                : prev
            );
          }

          // Evaluar estrategia direccional con indicadores 5m
          await evaluateDirectionalStrategy(config, indicators5m);

          // Auto-Repositionamiento (modos grid)
          const isGridMode = [
            "NEUTRAL_GRID",
            "LONG_GRID",
            "SHORT_GRID",
            "AUTO_GRID",
          ].includes(config.strategyMode);

          if (isGridMode && config.autoReposition && currentPriceRef.current > 0) {
            const price = currentPriceRef.current;
            // Usar step geométrico del primer nivel para el umbral
            const levels = calculateGridLevels(
              config.lowerPrice,
              config.upperPrice,
              config.gridCount,
              config.gridType ?? "GEOMETRIC"
            );
            const gridStep =
              levels.length >= 2
                ? levels[1] - levels[0]
                : (config.upperPrice - config.lowerPrice) / config.gridCount;

            if (
              needsRepositioning(
                price,
                config.lowerPrice,
                config.upperPrice,
                gridStep,
                macroIndicators.marketPhase  // guardia anti-COLLAPSE
              )
            ) {
              setState((prev) =>
                prev
                  ? {
                      ...prev,
                      logs: addLog(
                        prev.logs,
                        "warn",
                        `[AUTO] Precio $${price.toFixed(2)} fuera del rango. Reposicionando...`
                      ),
                    }
                  : prev
              );
              await repositionGrid(config, price);
            }
          }
        } catch {
          // Silenciosamente continuar
        }
        if (isRunningRef.current) setTimeout(poll, 30_000); // 30s (era 60s)
      };
      poll(); // Primera ejecución inmediata
    },
    [evaluateDirectionalStrategy, repositionGrid]
  );

  // ─── Iniciar Bot ──────────────────────────────────────────────────────

  const startBot = useCallback(
    async (config: GridConfig) => {
      setError(null);
      setIsConnecting(true);

      try {
        setState(createGridState(config));
        configRef.current = config;
        indicatorsRef.current = null;

        // 1. Autenticar
        setState((prev) =>
          prev ? { ...prev, logs: addLog(prev.logs, "info", "Autenticando con GRVT...") } : prev
        );
        await apiAuth();
        setState((prev) =>
          prev ? { ...prev, logs: addLog(prev.logs, "success", "Autenticación exitosa") } : prev
        );

        // 2. Verificar balance
        const bal = await apiGetBalance();
        if (bal <= 0) {
          throw new Error(
            "Balance de sub-cuenta: $0. Transfiere USDT desde grvt.io → Transfer → Sub-account"
          );
        }
        setState((prev) =>
          prev ? { ...prev, logs: addLog(prev.logs, "info", `Balance sub-cuenta: $${bal.toFixed(2)}`) } : prev
        );

        // 3. Configurar leverage
        if (config.leverage > 1) {
          setState((prev) =>
            prev
              ? { ...prev, logs: addLog(prev.logs, "info", `Configurando leverage ${config.leverage}x...`) }
              : prev
          );
          await apiSetLeverage(config.pair, config.leverage);
          setState((prev) =>
            prev
              ? { ...prev, logs: addLog(prev.logs, "success", `Leverage ${config.leverage}x configurado`) }
              : prev
          );
        }

        // 4. Precio e info del instrumento
        const priceData = await apiGetPrice(config.pair);
        sizeDecimalsRef.current = priceData.sizeDecimals;
        priceDecimalsRef.current = priceData.priceDecimals;
        minSizeRef.current = parseFloat(priceData.minSize);
        let initPrice = priceData.price;
        if (initPrice <= 0) {
          initPrice = (config.upperPrice + config.lowerPrice) / 2;
          setState((prev) =>
            prev
              ? { ...prev, logs: addLog(prev.logs, "warn", "No se pudo obtener precio. Usando punto medio.") }
              : prev
          );
        }

        setCurrentPrice(initPrice);
        currentPriceRef.current = initPrice;

        const isGridMode = [
          "NEUTRAL_GRID",
          "LONG_GRID",
          "SHORT_GRID",
          "AUTO_GRID",
        ].includes(config.strategyMode);

        // 5. Análisis inicial multi-timeframe
        let initialBias: MarketBias = "NEUTRAL";
        let initialIndicators5m: IndicatorsResult | null = null;

        try {
          setState((prev) =>
            prev
              ? { ...prev, logs: addLog(prev.logs, "info", "Analizando mercado (1h + 5m)...") }
              : prev
          );

          const [klines1h, klines5m] = await Promise.all([
            apiGetKlines(config.pair, "1h", 250),
            apiGetKlines(config.pair, "5m", 250),
          ]);

          const hasMacro = klines1h && klines1h.length > 50;
          const hasMicro = klines5m && klines5m.length > 50;

          if (hasMicro) {
            initialIndicators5m = calculateIndicators(klines5m);
            indicatorsRef.current = initialIndicators5m;
          }

          const macroIndic = hasMacro
            ? calculateIndicators(klines1h)
            : initialIndicators5m;

          if (macroIndic) {
            initialBias = detectMarketBias(macroIndic);

            // Si config.autoRange, recalcular límites de grilla con ATR50
            if (isGridMode && config.autoRange && macroIndic.atr50) {
              const direction = getGridDirection(config.strategyMode, initialBias);
              const { lowerPrice, upperPrice } = calculateAutoRange(
                initPrice,
                macroIndic.atr50,
                2.0,
                direction
              );
              config = { ...config, lowerPrice, upperPrice };
              configRef.current = config;
              setState((prev) =>
                prev
                  ? { ...prev, config }
                  : prev
              );
            }

            setState((prev) =>
              prev
                ? {
                    ...prev,
                    indicators: initialIndicators5m,
                    marketBias: initialBias,
                    logs: addLog(
                      prev.logs,
                      "info",
                      `[ANALISIS] Sesgo ${hasMacro ? "1h" : "5m"}: ${initialBias} | Score: ${macroIndic.marketScore}/100 | Fase: ${macroIndic.marketPhase} | RSI5m: ${initialIndicators5m?.rsi?.at(-1)?.toFixed(1) ?? "N/A"}`
                    ),
                  }
                : prev
            );

            // Advertencias de riesgo
            if (isGridMode && config.trendFilterEnabled !== false) {
              if (config.strategyMode === "NEUTRAL_GRID" && initialBias === "BEARISH") {
                setState((prev) =>
                  prev
                    ? {
                        ...prev,
                        logs: addLog(
                          prev.logs,
                          "warn",
                          "[RIESGO] Mercado BAJISTA. Grid neutral puede acumular pérdidas. Considera AUTO_GRID o SHORT_GRID."
                        ),
                      }
                    : prev
                );
              }
              if (config.strategyMode === "LONG_GRID" && initialBias === "BEARISH") {
                setState((prev) =>
                  prev
                    ? {
                        ...prev,
                        logs: addLog(
                          prev.logs,
                          "warn",
                          "[RIESGO] Grid LONG en mercado BAJISTA. Alto riesgo de pérdida."
                        ),
                      }
                    : prev
                );
              }
              if (
                macroIndic.marketPhase === "COLLAPSE" ||
                (initialIndicators5m?.isFreefalling && (initialIndicators5m?.freefallSeverity ?? 0) >= 3)
              ) {
                setState((prev) =>
                  prev
                    ? {
                        ...prev,
                        logs: addLog(
                          prev.logs,
                          "error",
                          "[ALERTA CRITICA] Mercado en COLAPSO. Las órdenes de compra serán bloqueadas hasta recuperación."
                        ),
                      }
                    : prev
                );
              }
            }
          }
        } catch {
          setState((prev) =>
            prev
              ? {
                  ...prev,
                  logs: addLog(
                    prev.logs,
                    "warn",
                    "No se pudo completar el análisis inicial. Usando sesgo NEUTRAL."
                  ),
                }
              : prev
          );
        }

        // 6. Validar rango (modos grid)
        if (isGridMode) {
          if (initPrice < config.lowerPrice || initPrice > config.upperPrice) {
            throw new Error(
              `Precio actual $${initPrice.toFixed(2)} fuera del rango [$${config.lowerPrice} – $${config.upperPrice}]`
            );
          }

          // Auto-reducir grids si el tamaño de orden sería menor al mínimo
          const maxGrids = calculateMaxGrids(
            config.totalInvestment,
            config.gridCount,
            initPrice,
            minSizeRef.current,
            config.leverage
          );
          if (maxGrids < config.gridCount) {
            config = { ...config, gridCount: maxGrids };
            configRef.current = config;
            setState((prev) =>
              prev
                ? {
                    ...prev,
                    config,
                    logs: addLog(
                      prev.logs,
                      "warn",
                      `Grids reducidos a ${maxGrids} para cumplir min_size (${minSizeRef.current})`
                    ),
                  }
                : prev
            );
          }
        }

        const gridDirection = isGridMode
          ? getGridDirection(config.strategyMode, initialBias)
          : "NEUTRAL";

        const gridType = config.gridType ?? "GEOMETRIC";
        const profitPct = isGridMode
          ? (
              gridType === "GEOMETRIC"
                ? ((Math.pow(config.upperPrice / config.lowerPrice, 1 / config.gridCount) - 1) * 100).toFixed(3)
                : ((config.upperPrice - config.lowerPrice) / config.gridCount / ((config.upperPrice + config.lowerPrice) / 2) * 100).toFixed(3)
            )
          : "N/A";

        setState((prev) =>
          prev
            ? {
                ...prev,
                currentPrice: initPrice,
                isRunning: true,
                maxEquity: config.totalInvestment,
                logs: addLog(
                  prev.logs,
                  "info",
                  `Bot iniciado | Precio: $${initPrice.toFixed(2)} | ${config.gridCount} grids ${gridType} | Profit/ciclo: ~${profitPct}% | Leverage: ${config.leverage}x | Dir: ${gridDirection} | MaxDD: ${config.maxDrawdownPct ?? 15}%`
                ),
              }
            : prev
        );

        isRunningRef.current = true;

        // 7. WebSocket
        connectWebSocket(config);

        // 8. Órdenes iniciales (modos grid)
        if (isGridMode) {
          await initializeGrid(config, initPrice, gridDirection);
        }

        // 9. Iniciar pollings
        startOrderPolling(config);
        startPositionPolling(config);
        startIndicatorsPolling(config);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setState((prev) =>
          prev
            ? {
                ...prev,
                isRunning: false,
                logs: addLog(prev.logs, "error", `Error al iniciar: ${msg}`),
              }
            : prev
        );
        cleanup();
      } finally {
        setIsConnecting(false);
      }
    },
    [
      cleanup,
      connectWebSocket,
      initializeGrid,
      startOrderPolling,
      startPositionPolling,
      startIndicatorsPolling,
    ]
  );

  // ─── Detener Bot ──────────────────────────────────────────────────────

  const stopBot = useCallback(async () => {
    isRunningRef.current = false;
    cleanup();

    const config = configRef.current;
    if (config) {
      try {
        await apiCancelAll(config.pair);
        setState((prev) =>
          prev
            ? {
                ...prev,
                isRunning: false,
                logs: addLog(prev.logs, "warn", "Bot detenido. Todas las órdenes canceladas."),
              }
            : prev
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setState((prev) =>
          prev
            ? {
                ...prev,
                isRunning: false,
                logs: addLog(prev.logs, "error", `Error al cancelar: ${msg}`),
              }
            : prev
        );
      }
    }
  }, [cleanup]);

  useEffect(() => () => cleanup(), [cleanup]);

  return { state, currentPrice, isConnecting, error, startBot, stopBot };
}
