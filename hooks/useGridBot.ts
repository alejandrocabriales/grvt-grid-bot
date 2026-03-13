"use client";

/**
 * useGridBot — Hook principal del bot de grilla.
 *
 * Arquitectura de seguridad:
 *   Browser → /api/bot/* (Next.js server) → GRVT API
 *
 * Las credenciales (.env) nunca tocan el cliente.
 * La firma EIP-712 ocurre en el servidor (/api/bot/orders/create).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  GridConfig,
  GridState,
  addLog,
  calculateGridLevels,
  calculateMaxGrids,
  calculateOrderSize,
  createGridState,
  getCounterOrder,
  getInitialOrders,
} from "@/lib/grid-bot";

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

async function apiGetPrice(instrument: string): Promise<{ price: number; sizeDecimals: number; priceDecimals: number; minSize: string }> {
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

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useGridBot(): UseGridBotReturn {
  const [state, setState] = useState<GridState | null>(null);
  const [currentPrice, setCurrentPrice] = useState(0);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const configRef = useRef<GridConfig | null>(null);
  const isRunningRef = useRef(false);
  const currentPriceRef = useRef(0); // para callbacks del WS sin stale closure
  const sizeDecimalsRef = useRef(2); // from min_size (e.g. "0.01" → 2)
  const priceDecimalsRef = useRef(2); // from tick_size (e.g. "0.01" → 2)
  const minSizeRef = useRef(0.01);   // minimum order size from instrument

  // ─── Cleanup ───────────────────────────────────────────────────────────────

  const cleanup = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    isRunningRef.current = false;
  }, []);

  // ─── Colocar una orden (llama API interna del servidor) ───────────────────

  const placeLimitOrder = useCallback(
    async (price: number, type: "buy" | "sell", size: string): Promise<string | null> => {
      const config = configRef.current;
      if (!config || !isRunningRef.current) return null;

      try {
        // Format price to match tick_size precision
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
                logs: addLog(
                  prev.logs,
                  "success",
                  `✓ ${type.toUpperCase()} @ $${price.toFixed(2)} | size: ${size} | id: ${orderId.slice(0, 8)}...`
                ),
              }
            : prev
        );
        return orderId;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setState((prev) =>
          prev
            ? { ...prev, logs: addLog(prev.logs, "error", `Order failed: ${msg}`) }
            : prev
        );
        return null;
      }
    },
    []
  );

  // ─── Inicializar grilla ────────────────────────────────────────────────────

  const initializeGrid = useCallback(
    async (config: GridConfig, price: number) => {
      const levels = calculateGridLevels(
        config.lowerPrice,
        config.upperPrice,
        config.gridCount
      );
      const orders = getInitialOrders(
        levels,
        price,
        config.totalInvestment,
        config.gridCount,
        sizeDecimalsRef.current,
        config.leverage
      );

      // Log each order's details for debugging
      const orderSummary = orders.map((o) => `${o.type} ${o.size}@$${o.price.toFixed(2)}`).join(", ");
      setState((prev) =>
        prev
          ? { ...prev, logs: addLog(prev.logs, "info", `Colocando ${orders.length} órdenes: ${orderSummary}`) }
          : prev
      );

      for (const order of orders) {
        if (!isRunningRef.current) break;
        await placeLimitOrder(order.price, order.type, order.size);
        await delay(220); // respeta rate limiting de GRVT (~5 órdenes/seg)
      }
    },
    [placeLimitOrder]
  );

  // ─── Manejo de fill ────────────────────────────────────────────────────────

  const handleFill = useCallback(
    async (filledPrice: number, filledType: "buy" | "sell", size: string) => {
      const config = configRef.current;
      if (!config || !isRunningRef.current) return;

      // Calcular PnL estimado por ciclo de grilla
      const step =
        (config.upperPrice - config.lowerPrice) / config.gridCount;
      const profit =
        filledType === "sell"
          ? step * parseFloat(size) * 0.998 // descontar fee ~0.2%
          : 0;

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
                `✅ ${filledType.toUpperCase()} filled @ $${filledPrice.toFixed(2)} | PnL ciclo: +$${profit.toFixed(4)}`
              ),
            }
          : prev
      );

      // Colocar contra-orden
      const levels = calculateGridLevels(
        config.lowerPrice,
        config.upperPrice,
        config.gridCount
      );
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
        await delay(300);
        await placeLimitOrder(counter.price, counter.type, counter.size);
      }
    },
    [placeLimitOrder]
  );

  // ─── WebSocket (precio en tiempo real) ────────────────────────────────────

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
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "subscribe",
            params: { stream: "trade", selectors: [config.pair] },
            id: 2,
          })
        );
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);

          // Actualización de precio (mini ticker)
          if (msg?.result?.channel?.includes("mini")) {
            const feed = msg.result.feed;
            const p = parseFloat(
              feed?.mark_price ?? feed?.oracle_price ?? feed?.last ?? "0"
            );
            if (p > 0) {
              setCurrentPrice(p);
              currentPriceRef.current = p;
              setState((prev) => (prev ? { ...prev, currentPrice: p } : prev));
            }
          }

          // Trades públicos — detectar fills propios por proximidad de precio
          if (msg?.result?.channel?.includes("trade")) {
            const trades = Array.isArray(msg.result.feed)
              ? msg.result.feed
              : [msg.result.feed];

            for (const trade of trades) {
              if (!trade?.price || !trade?.size) continue;
              const tp = parseFloat(trade.price);
              const levels = calculateGridLevels(
                config.lowerPrice,
                config.upperPrice,
                config.gridCount
              );
              const halfStep =
                (config.upperPrice - config.lowerPrice) /
                config.gridCount /
                2;
              const matched = levels.find(
                (l) => Math.abs(l - tp) < halfStep
              );
              if (matched) {
                const type =
                  tp <= currentPriceRef.current ? "buy" : "sell";
                const size = calculateOrderSize(
                  config.totalInvestment,
                  config.gridCount,
                  tp,
                  sizeDecimalsRef.current,
                  config.leverage
                );
                handleFill(tp, type, size);
              }
            }
          }
        } catch {
          // ignorar mensajes malformados
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
            ? { ...prev, logs: addLog(prev.logs, "warn", "WebSocket desconectado. Reconectando en 3s...") }
            : prev
        );
        setTimeout(() => {
          if (isRunningRef.current && configRef.current) {
            connectWebSocket(configRef.current);
          }
        }, 3000);
      };
    },
    [handleFill]
  );

  // ─── Polling de órdenes abiertas ───────────────────────────────────────────

  const startPolling = useCallback((config: GridConfig) => {
    const poll = async () => {
      if (!isRunningRef.current) return;
      try {
        const orders = await apiGetOpenOrders(config.pair);
        setState((prev) =>
          prev
            ? {
                ...prev,
                levels: prev.levels.map((l) => ({
                  ...l,
                  orderId: orders.find(
                    (o) => Math.abs(parseFloat(o.limit_price) - l.price) < 0.01
                  )?.id,
                })),
              }
            : prev
        );
      } catch {
        // silently continue
      }
      if (isRunningRef.current) setTimeout(poll, 10_000);
    };
    setTimeout(poll, 5_000);
  }, []);

  // ─── Iniciar bot ───────────────────────────────────────────────────────────

  const startBot = useCallback(
    async (config: GridConfig) => {
      setError(null);
      setIsConnecting(true);

      try {
        setState(createGridState(config));
        configRef.current = config;

        // 1. Autenticar (usa GRVT_API_KEY del .env en el servidor)
        setState((prev) =>
          prev ? { ...prev, logs: addLog(prev.logs, "info", "Autenticando con GRVT...") } : prev
        );
        await apiAuth();
        setState((prev) =>
          prev ? { ...prev, logs: addLog(prev.logs, "success", "Autenticación exitosa") } : prev
        );

        // 2. Verificar balance de la sub-cuenta
        const bal = await apiGetBalance();
        if (bal <= 0) {
          throw new Error(
            "Balance de sub-cuenta: $0. Transfiere USDT desde tu cuenta principal en grvt.io → Transfer → Sub-account"
          );
        }
        setState((prev) =>
          prev ? { ...prev, logs: addLog(prev.logs, "info", `Balance sub-cuenta: $${bal.toFixed(2)}`) } : prev
        );

        // 3. Configurar leverage en GRVT
        if (config.leverage > 1) {
          setState((prev) =>
            prev ? { ...prev, logs: addLog(prev.logs, "info", `Configurando leverage ${config.leverage}x...`) } : prev
          );
          await apiSetLeverage(config.pair, config.leverage);
          setState((prev) =>
            prev ? { ...prev, logs: addLog(prev.logs, "success", `Leverage ${config.leverage}x configurado`) } : prev
          );
        }

        // 3. Obtener precio actual e info del instrumento
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

        if (initPrice < config.lowerPrice || initPrice > config.upperPrice) {
          throw new Error(
            `Precio actual $${initPrice.toFixed(2)} fuera del rango de la grilla [$${config.lowerPrice} – $${config.upperPrice}]`
          );
        }

        // Auto-reduce grid count if order sizes would be below min_size
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
                    `Grids reducidos a ${maxGrids} para cumplir min_size (${minSizeRef.current}) con leverage ${config.leverage}x`
                  ),
                }
              : prev
          );
        }

        setState((prev) =>
          prev
            ? {
                ...prev,
                currentPrice: initPrice,
                isRunning: true,
                logs: addLog(
                  prev.logs,
                  "info",
                  `Precio: $${initPrice.toFixed(2)} | Leverage: ${config.leverage}x | Capital efectivo: $${(config.totalInvestment * config.leverage).toFixed(2)} | Grids: ${config.gridCount}`
                ),
              }
            : prev
        );

        isRunningRef.current = true;

        // 3. WebSocket para precio en tiempo real
        connectWebSocket(config);

        // 4. Colocar órdenes iniciales
        await initializeGrid(config, initPrice);

        // 5. Polling de estado de órdenes
        startPolling(config);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setState((prev) =>
          prev
            ? { ...prev, isRunning: false, logs: addLog(prev.logs, "error", `Error al iniciar: ${msg}`) }
            : prev
        );
        cleanup();
      } finally {
        setIsConnecting(false);
      }
    },
    [cleanup, connectWebSocket, initializeGrid, startPolling]
  );

  // ─── Detener bot ───────────────────────────────────────────────────────────

  const stopBot = useCallback(async () => {
    isRunningRef.current = false;
    cleanup();

    const config = configRef.current;
    if (config) {
      try {
        await apiCancelAll(config.pair);
        setState((prev) =>
          prev
            ? { ...prev, isRunning: false, logs: addLog(prev.logs, "warn", "Bot detenido. Todas las órdenes canceladas.") }
            : prev
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setState((prev) =>
          prev
            ? { ...prev, isRunning: false, logs: addLog(prev.logs, "error", `Error al cancelar: ${msg}`) }
            : prev
        );
      }
    }
  }, [cleanup]);

  useEffect(() => () => cleanup(), [cleanup]);

  return { state, currentPrice, isConnecting, error, startBot, stopBot };
}
