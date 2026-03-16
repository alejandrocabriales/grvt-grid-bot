"use client";

/**
 * VolumeOptimizerPanel — UI simple para el Volume Optimizer.
 *
 * Controles: par, inversión, leverage → Start/Stop.
 * Muestra métricas en vivo: volumen, trades, PnL, régimen, logs.
 */

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useVolumeBot } from "@/hooks/useVolumeBot";
import { defaultVolumeConfig, estimateVolume } from "@/lib/volume-optimizer";
import {
  Activity,
  Loader2,
  Play,
  Square,
  TrendingUp,
  Zap,
  BarChart3,
  RefreshCw,
  Shield,
} from "lucide-react";

const SUPPORTED_PAIRS = [
  "ETH_USDT_Perp",
  "BTC_USDT_Perp",
  "SOL_USDT_Perp",
  "ARB_USDT_Perp",
  "OP_USDT_Perp",
  "XRP_USDT_Perp",
];

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function formatUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

export function VolumeOptimizerPanel() {
  const { status, isConnecting, error, startBot, stopBot } = useVolumeBot();

  const [pair, setPair] = useState("ETH_USDT_Perp");
  const [investment, setInvestment] = useState("50");
  const [leverage, setLeverage] = useState("10");
  const [maxDrawdown, setMaxDrawdown] = useState("3");
  const [spreadPairs, setSpreadPairs] = useState("3");
  const [sessionTp, setSessionTp] = useState("5");   // % sobre capital
  const [spreadSl, setSpreadSl] = useState("0.2");   // % desde entry (0.2% = 20 bps)

  const isRunning = status?.isRunning ?? false;

  const handleStart = async () => {
    const config = defaultVolumeConfig(
      pair,
      parseFloat(investment),
      parseInt(leverage)
    );
    config.maxDrawdownPct = parseFloat(maxDrawdown);
    config.spreadPairs = parseInt(spreadPairs);
    config.maxSessionLossUsdc = parseFloat(investment) * 0.05;
    config.sessionTpPct = parseFloat(sessionTp) || 0;
    config.spreadSlBps = Math.round((parseFloat(spreadSl) || 0) * 100); // % → bps
    await startBot(config);
  };

  // Volume estimates
  const est = estimateVolume(
    parseFloat(investment) || 50,
    parseInt(leverage) || 10,
    parseInt(spreadPairs) || 3
  );

  // Uptime
  const uptime = status?.startTime
    ? formatDuration(Date.now() - status.startTime)
    : "—";

  // Live metrics
  const volumePerHour =
    status && status.startTime > 0
      ? status.totalVolume / Math.max((Date.now() - status.startTime) / 3_600_000, 0.01)
      : 0;

  return (
    <Card className="bg-zinc-900 border-zinc-700">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2 text-zinc-300">
          <Activity className="h-4 w-4 text-cyan-400" />
          Volume Optimizer
          {isRunning && (
            <Badge
              variant="outline"
              className="ml-auto border-cyan-500 text-cyan-400 text-[10px] animate-pulse"
            >
              <RefreshCw className="h-2.5 w-2.5 mr-1 animate-spin" />
              Activo
            </Badge>
          )}
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* ── Config (disabled while running) ─────────────────────────────── */}

        {/* Pair */}
        <div>
          <label className="text-xs text-zinc-500 mb-1 block">Par</label>
          <Select
            value={pair}
            onValueChange={(v) => setPair(v ?? pair)}
            disabled={isRunning}
          >
            <SelectTrigger className="bg-zinc-800 border-zinc-600 text-zinc-200 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-zinc-800 border-zinc-700">
              {SUPPORTED_PAIRS.map((p) => (
                <SelectItem key={p} value={p} className="text-zinc-200 text-xs">
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Investment + Leverage */}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs text-zinc-500 mb-1 block">
              Inversión (USDC)
            </label>
            <Input
              type="number"
              value={investment}
              onChange={(e) => setInvestment(e.target.value)}
              className="bg-zinc-800 border-zinc-600 text-zinc-200 text-xs"
              disabled={isRunning}
            />
          </div>
          <div>
            <label className="text-xs text-zinc-500 mb-1 block">Leverage</label>
            <Select
              value={leverage}
              onValueChange={(v) => setLeverage(v ?? leverage)}
              disabled={isRunning}
            >
              <SelectTrigger className="bg-zinc-800 border-zinc-600 text-zinc-200 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-zinc-800 border-zinc-700">
                {["1", "2", "3", "5", "10", "20"].map((l) => (
                  <SelectItem key={l} value={l} className="text-zinc-200 text-xs">
                    {l}x
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Spread Pairs + Max Drawdown */}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs text-zinc-500 mb-1 block">
              Pares Spread
            </label>
            <Select
              value={spreadPairs}
              onValueChange={(v) => setSpreadPairs(v ?? spreadPairs)}
              disabled={isRunning}
            >
              <SelectTrigger className="bg-zinc-800 border-zinc-600 text-zinc-200 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-zinc-800 border-zinc-700">
                {["1", "2", "3", "4", "5"].map((n) => (
                  <SelectItem key={n} value={n} className="text-zinc-200 text-xs">
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs text-zinc-500 mb-1 block">
              Max Drawdown (%)
            </label>
            <Input
              type="number"
              step="0.5"
              min="1"
              max="10"
              value={maxDrawdown}
              onChange={(e) => setMaxDrawdown(e.target.value)}
              className="bg-zinc-800 border-zinc-600 text-zinc-200 text-xs"
              disabled={isRunning}
            />
          </div>
        </div>

        {/* Take Profit + Stop Loss */}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs text-zinc-500 mb-1 block">
              Take Profit (%)
            </label>
            <Input
              type="number"
              step="0.5"
              min="0"
              max="50"
              placeholder="0 = off"
              value={sessionTp}
              onChange={(e) => setSessionTp(e.target.value)}
              className="bg-zinc-800 border-zinc-600 text-zinc-200 text-xs"
              disabled={isRunning}
            />
            <p className="text-[10px] text-zinc-600 mt-0.5">
              Detiene al +{sessionTp || "0"}% de ganancia
            </p>
          </div>
          <div>
            <label className="text-xs text-zinc-500 mb-1 block">
              Stop Loss posición (%)
            </label>
            <Input
              type="number"
              step="0.05"
              min="0"
              max="5"
              placeholder="0 = off"
              value={spreadSl}
              onChange={(e) => setSpreadSl(e.target.value)}
              className="bg-zinc-800 border-zinc-600 text-zinc-200 text-xs"
              disabled={isRunning}
            />
            <p className="text-[10px] text-zinc-600 mt-0.5">
              Cierra si cae {spreadSl || "0"}% desde entry
            </p>
          </div>
        </div>

        {/* ── Estimates (before start) ────────────────────────────────────── */}
        {!isRunning && (
          <div className="rounded-lg bg-zinc-800/30 border border-zinc-700/40 p-2.5 space-y-1.5">
            <p className="text-[10px] text-zinc-600 uppercase font-medium tracking-wide">
              Estimaciones (50% fill rate)
            </p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
              <div className="flex justify-between">
                <span className="text-zinc-500">Capital efectivo</span>
                <span className="font-mono text-zinc-300">
                  ${(parseFloat(investment) * parseInt(leverage)).toFixed(0)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Vol/ciclo</span>
                <span className="font-mono text-zinc-300">
                  ${est.volumePerCyclePerPair.toFixed(0)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Vol/hora</span>
                <span className="font-mono text-cyan-400">
                  {formatUsd(est.volumePerHour)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Vol/día</span>
                <span className="font-mono text-cyan-400">
                  {formatUsd(est.volumePerDay)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Vol/semana</span>
                <span className="font-mono text-cyan-300 font-semibold">
                  {formatUsd(est.volumePerWeek)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Trades/día</span>
                <span className="font-mono text-zinc-300">
                  ~{est.tradesPerDay.toFixed(0)}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* ── Live Metrics (while running) ────────────────────────────────── */}
        {isRunning && status && (
          <div className="space-y-2">
            {/* Main stats */}
            <div className="rounded-lg bg-cyan-500/5 border border-cyan-500/20 p-2.5 space-y-1.5">
              <div className="flex items-center gap-1.5 mb-1">
                <BarChart3 className="h-3 w-3 text-cyan-400" />
                <span className="text-[10px] text-cyan-400 uppercase font-medium tracking-wide">
                  Métricas en vivo
                </span>
                <span className="text-[10px] text-zinc-600 ml-auto">{uptime}</span>
              </div>

              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                <div className="flex justify-between">
                  <span className="text-zinc-500">Volumen total</span>
                  <span className="font-mono text-cyan-300 font-semibold">
                    {formatUsd(status.totalVolume)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Vol/hora</span>
                  <span className="font-mono text-cyan-400">
                    {formatUsd(volumePerHour)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Trades</span>
                  <span className="font-mono text-zinc-300">
                    {status.totalTrades}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Ciclos spread</span>
                  <span className="font-mono text-zinc-300">
                    {status.spreadCycles}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Scalp trades</span>
                  <span className="font-mono text-zinc-300">
                    {status.scalpTrades}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">PnL</span>
                  <span
                    className={`font-mono font-semibold ${
                      status.totalPnL >= 0 ? "text-emerald-400" : "text-red-400"
                    }`}
                  >
                    {status.totalPnL >= 0 ? "+" : ""}${status.totalPnL.toFixed(4)}
                  </span>
                </div>
              </div>
            </div>

            {/* Protection info */}
            <div className="rounded-lg bg-zinc-800/30 border border-zinc-700/40 p-2 space-y-1">
              <div className="flex items-center gap-1.5 mb-0.5">
                <Shield className="h-3 w-3 text-zinc-500" />
                <span className="text-[10px] text-zinc-500 uppercase font-medium tracking-wide">Protección de capital</span>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px]">
                <div className="flex justify-between">
                  <span className="text-zinc-500">Drawdown máx</span>
                  <span className="font-mono text-red-400">{maxDrawdown}%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Pérdida máx</span>
                  <span className="font-mono text-red-400">
                    ${(parseFloat(investment) * 0.05).toFixed(2)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Take Profit</span>
                  <span className="font-mono text-emerald-400">
                    {parseFloat(sessionTp) > 0 ? `+${sessionTp}%` : "—"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">SL posición</span>
                  <span className="font-mono text-yellow-400">
                    {parseFloat(spreadSl) > 0 ? `-${spreadSl}%` : "—"}
                  </span>
                </div>
              </div>
            </div>

            {/* Recent logs */}
            {status.logs.length > 0 && (
              <div className="rounded-lg bg-zinc-800/30 border border-zinc-700/40 p-2 max-h-32 overflow-y-auto">
                <p className="text-[10px] text-zinc-600 uppercase font-medium tracking-wide mb-1">
                  Logs recientes
                </p>
                {status.logs.slice(0, 8).map((log, i) => (
                  <div key={i} className="text-[10px] font-mono leading-relaxed truncate">
                    <span
                      className={
                        log.level === "error"
                          ? "text-red-400"
                          : log.level === "warn"
                          ? "text-yellow-400"
                          : log.level === "success"
                          ? "text-emerald-400"
                          : "text-zinc-500"
                      }
                    >
                      {log.level === "error"
                        ? "x"
                        : log.level === "warn"
                        ? "!"
                        : log.level === "success"
                        ? "+"
                        : "i"}
                    </span>{" "}
                    <span className="text-zinc-400">{log.message}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Error ───────────────────────────────────────────────────────── */}
        {error && (
          <div className="flex items-start gap-1.5 text-xs p-2 rounded border bg-red-500/10 border-red-500/20 text-red-300">
            {error}
          </div>
        )}

        {/* ── Start / Stop Button ─────────────────────────────────────────── */}
        {!isRunning ? (
          <Button
            size="sm"
            className="w-full bg-cyan-600 hover:bg-cyan-500 text-white text-xs gap-1.5"
            disabled={isConnecting}
            onClick={handleStart}
          >
            {isConnecting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            Iniciar Volume Optimizer
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="w-full border-red-500/50 text-red-400 hover:bg-red-500/10 text-xs gap-1.5"
            onClick={stopBot}
          >
            <Square className="h-3.5 w-3.5" />
            Detener
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
