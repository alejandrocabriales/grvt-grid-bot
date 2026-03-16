"use client";

/**
 * useVolumeBot — Hook for the Volume Optimizer engine.
 *
 * Connects to /api/volume-engine/* routes and polls status every 3s.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { VolumeConfig } from "@/lib/volume-optimizer";

const STATUS_POLL_MS = 3_000;

export interface VolumeStatus {
  isRunning: boolean;
  totalVolume: number;
  totalTrades: number;
  totalPnL: number;
  spreadCycles: number;
  scalpTrades: number;
  sessionPnL: number;
  maxEquity: number;
  startTime: number;
  logs: { level: string; message: string; timestamp: number }[];
}

export interface UseVolumeBotReturn {
  status: VolumeStatus | null;
  isConnecting: boolean;
  error: string | null;
  startBot: (config: VolumeConfig) => Promise<void>;
  stopBot: () => Promise<void>;
}

export function useVolumeBot(): UseVolumeBotReturn {
  const [status, setStatus] = useState<VolumeStatus | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const schedulePoll = useCallback(() => {
    pollTimerRef.current = setTimeout(async () => {
      try {
        const res = await fetch("/api/volume-engine/status");
        const data = await res.json();

        if (data.ok) {
          setStatus({
            isRunning: data.isRunning,
            totalVolume: data.totalVolume ?? 0,
            totalTrades: data.totalTrades ?? 0,
            totalPnL: data.totalPnL ?? 0,
            spreadCycles: data.spreadCycles ?? 0,
            scalpTrades: data.scalpTrades ?? 0,
            sessionPnL: data.sessionPnL ?? 0,
            maxEquity: data.maxEquity ?? 0,
            startTime: data.startTime ?? 0,
            logs: data.logs ?? [],
          });
        }
      } catch {
        // ignore
      }
      schedulePoll();
    }, STATUS_POLL_MS);
  }, []);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const startBot = useCallback(
    async (config: VolumeConfig) => {
      setIsConnecting(true);
      setError(null);
      try {
        const res = await fetch("/api/volume-engine/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ config }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error ?? "Failed to start volume engine");

        stopPolling();
        schedulePoll();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      } finally {
        setIsConnecting(false);
      }
    },
    [schedulePoll, stopPolling]
  );

  const stopBot = useCallback(async () => {
    try {
      await fetch("/api/volume-engine/stop", { method: "POST" });
    } catch {
      // best-effort
    }
    stopPolling();
    setStatus((prev) => (prev ? { ...prev, isRunning: false } : prev));
  }, [stopPolling]);

  // Bootstrap: check if already running
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch("/api/volume-engine/status");
        const data = await res.json();
        if (!mounted) return;

        if (data.ok && data.isRunning) {
          setStatus({
            isRunning: data.isRunning,
            totalVolume: data.totalVolume ?? 0,
            totalTrades: data.totalTrades ?? 0,
            totalPnL: data.totalPnL ?? 0,
            spreadCycles: data.spreadCycles ?? 0,
            scalpTrades: data.scalpTrades ?? 0,
            sessionPnL: data.sessionPnL ?? 0,
            maxEquity: data.maxEquity ?? 0,
            startTime: data.startTime ?? 0,
            logs: data.logs ?? [],
          });
          schedulePoll();
        }
      } catch {
        // ignore on mount
      }
    })();
    return () => {
      mounted = false;
      stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { status, isConnecting, error, startBot, stopBot };
}
