"use client";

/**
 * useGridBot — Hook de UI para el motor servidor 24/7.
 *
 * El bot ya NO corre en el navegador. Este hook:
 *   1. startBot(config) → POST /api/engine/start  (arranca GridEngine en el servidor)
 *   2. stopBot()        → POST /api/engine/stop
 *   3. Polling c/3s de GET /api/engine/status → actualiza GridState para la UI
 *   4. Mantiene WebSocket de GRVT para precio en tiempo real
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  GridConfig,
  GridState,
  GridLevel,
  LogEntry,
} from "@/lib/grid-bot";
import type { DbOrder } from "@/scripts/db";

const WS_URL =
  process.env.NEXT_PUBLIC_GRVT_USE_TESTNET === "true"
    ? "wss://market-data.testnet.grvt.io/ws/full"
    : "wss://market-data.grvt.io/ws/full";

const STATUS_POLL_MS = 3_000;

export interface UseGridBotReturn {
  state: GridState | null;
  currentPrice: number;
  isConnecting: boolean;
  error: string | null;
  startBot: (config: GridConfig) => Promise<void>;
  stopBot: () => Promise<void>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface EngineStatus {
  ok: boolean;
  isRunning: boolean;
  config: GridConfig | null;
  totalPnL: number;
  filledOrders: number;
  maxEquity: number;
  startTime: number;
  trailingStopPrice: number | null;
  peakPrice: number | null;
  logs: { level: string; message: string; timestamp: number }[];
  orders: DbOrder[];
  error?: string;
}

/** Reconstruye GridLevel[] a partir de las órdenes recientes en DB */
function levelsFromOrders(orders: DbOrder[]): GridLevel[] {
  return orders.map((o) => ({
    price: o.price,
    type: o.side,
    orderId: o.order_id ?? undefined,
    clientOrderId: o.client_order_id ?? undefined,
    filled: o.status === "filled",
    profit: 0,
  }));
}

function mapStatusToState(status: EngineStatus, prevState: GridState | null): GridState {
  const config = status.config!;
  const logs: LogEntry[] = status.logs.map((l) => ({
    timestamp: l.timestamp,
    level: l.level as LogEntry["level"],
    message: l.message,
  }));

  return {
    config,
    levels: levelsFromOrders(status.orders),
    currentPrice: prevState?.currentPrice ?? 0,
    totalPnL: status.totalPnL,
    totalVolume: 0,
    filledOrders: status.filledOrders,
    startTime: status.startTime,
    isRunning: status.isRunning,
    logs,
    position: prevState?.position ?? null,
    indicators: prevState?.indicators ?? null,
    marketBias: prevState?.marketBias ?? "NEUTRAL",
    trailingStopPrice: status.trailingStopPrice,
    peakPrice: status.peakPrice,
    troughPrice: prevState?.troughPrice ?? null,
    maxEquity: status.maxEquity,
    currentDrawdownPct: prevState?.currentDrawdownPct ?? 0,
    gridRepositionCount: prevState?.gridRepositionCount ?? 0,
    lastSignalTime: prevState?.lastSignalTime ?? 0,
  };
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useGridBot(): UseGridBotReturn {
  const [state, setState] = useState<GridState | null>(null);
  const [currentPrice, setCurrentPrice] = useState(0);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateRef = useRef<GridState | null>(null);
  const pairRef = useRef<string>("");

  // Keep stateRef in sync for use inside callbacks
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // ─── WebSocket (precio en tiempo real) ──────────────────────────────────

  const connectWebSocket = useCallback((pair: string) => {
    if (wsRef.current) wsRef.current.close();

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;
    pairRef.current = pair;

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "subscribe",
          params: { stream: `mini.s`, selectors: [pair] },
          id: 1,
        })
      );
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        const price = parseFloat(msg?.result?.mark_price ?? msg?.feed?.mark_price ?? "0");
        if (price > 0) {
          setCurrentPrice(price);
          setState((prev) =>
            prev ? { ...prev, currentPrice: price } : prev
          );
        }
      } catch {
        // ignore parse errors
      }
    };

    ws.onerror = () => ws.close();

    ws.onclose = () => {
      // Reconnect after 5s if bot is still running
      if (stateRef.current?.isRunning) {
        setTimeout(() => connectWebSocket(pairRef.current), 5_000);
      }
    };
  }, []);

  // ─── Status Polling ──────────────────────────────────────────────────────

  const schedulePoll = useCallback(() => {
    pollTimerRef.current = setTimeout(async () => {
      try {
        const res = await fetch("/api/engine/status");
        const status: EngineStatus = await res.json();

        if (status.ok && status.config) {
          setState((prev) => mapStatusToState(status, prev));

          // Si el bot se detuvo en el servidor, limpiar WS
          if (!status.isRunning) {
            wsRef.current?.close();
          }

          // Seguir polling
          schedulePoll();
        } else {
          // Sin config aún — seguir polling de todas formas si había estado
          setState((prev) => {
            if (!prev) return null;
            return { ...prev, isRunning: false };
          });
          schedulePoll();
        }
      } catch {
        schedulePoll();
      }
    }, STATUS_POLL_MS);
  }, []);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  // ─── startBot ────────────────────────────────────────────────────────────

  const startBot = useCallback(
    async (config: GridConfig) => {
      setIsConnecting(true);
      setError(null);
      try {
        const res = await fetch("/api/engine/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ config }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error ?? "Failed to start engine");

        // Conectar WS para precio en tiempo real
        connectWebSocket(config.pair);

        // Arrancar polling de estado
        stopPolling();
        schedulePoll();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      } finally {
        setIsConnecting(false);
      }
    },
    [connectWebSocket, schedulePoll, stopPolling]
  );

  // ─── stopBot ─────────────────────────────────────────────────────────────

  const stopBot = useCallback(async () => {
    try {
      await fetch("/api/engine/stop", { method: "POST" });
    } catch {
      // best-effort
    }
    wsRef.current?.close();
    wsRef.current = null;
    stopPolling();
    setState((prev) => (prev ? { ...prev, isRunning: false } : prev));
  }, [stopPolling]);

  // ─── Bootstrap: si el bot ya estaba corriendo, arrancar polling ──────────

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch("/api/engine/status");
        const status: EngineStatus = await res.json();
        if (!mounted) return;

        if (status.ok && status.isRunning && status.config) {
          setState(mapStatusToState(status, null));
          connectWebSocket(status.config.pair);
          schedulePoll();
        }
      } catch {
        // ignore on mount
      }
    })();
    return () => {
      mounted = false;
      stopPolling();
      wsRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { state, currentPrice, isConnecting, error, startBot, stopBot };
}
