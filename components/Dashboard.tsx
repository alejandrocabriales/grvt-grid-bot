"use client";

import { GridState, MarketBias, formatPrice, formatPnL } from "@/lib/grid-bot";
import { getLiquidationInfo } from "@/lib/liquidation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Activity,
  BarChart2,
  DollarSign,
  Shield,
  TrendingDown,
  TrendingUp,
  Zap,
} from "lucide-react";
import {
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useMemo, useState, useEffect } from "react";

interface Props {
  state: GridState;
  currentPrice: number;
}

// Color y texto según sesgo del mercado
function biasDisplay(bias: MarketBias) {
  switch (bias) {
    case "BULLISH": return { label: "ALCISTA", color: "text-emerald-400", border: "border-emerald-500/50" };
    case "BEARISH": return { label: "BAJISTA", color: "text-red-400", border: "border-red-500/50" };
    default: return { label: "NEUTRAL", color: "text-zinc-400", border: "border-zinc-500/50" };
  }
}

export function Dashboard({ state, currentPrice }: Props) {
  const { totalPnL, colorClass } = useMemo(() => {
    const { text, colorClass } = formatPnL(state.totalPnL);
    return { totalPnL: text, colorClass };
  }, [state.totalPnL]);

  const [uptimeStr, setUptimeStr] = useState("0h 0m 0s");

  useEffect(() => {
    if (!state.isRunning) {
      setUptimeStr("0h 0m 0s");
      return;
    }
    const update = () => {
      const ms = Date.now() - state.startTime;
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      setUptimeStr(`${h}h ${m}m ${s}s`);
    };
    update();
    const int = setInterval(update, 1000);
    return () => clearInterval(int);
  }, [state.isRunning, state.startTime]);

  const gridData = useMemo(() => {
    return state.levels
      .map((level) => ({
        price: level.price,
        type: level.type,
        active: Math.abs(level.price - currentPrice) < state.config.gridCount,
        filled: level.filled,
      }))
      .reverse();
  }, [state.levels, currentPrice, state.config.gridCount]);

  const pnlChartData = useMemo(() => {
    const data = [];
    let cumulative = 0;
    const filteredLogs = state.logs
      .filter((l) => l.message.includes("PnL"))
      .reverse();

    for (let i = 0; i < filteredLogs.length; i++) {
      const match = filteredLogs[i].message.match(/[+-]?\$([0-9.]+)/);
      if (match) {
        const sign = filteredLogs[i].message.includes("-$") ? -1 : 1;
        cumulative += sign * parseFloat(match[1]);
      }
      data.push({ t: i, pnl: cumulative });
    }
    return data;
  }, [state.logs]);

  const bias = biasDisplay(state.marketBias);

  return (
    <div className="space-y-4">
      {/* Stat Cards */}
      <div className="grid grid-cols-2 gap-3">
        <StatCard
          icon={<DollarSign className="h-4 w-4 text-emerald-400" />}
          label="Total PnL"
          value={totalPnL}
          valueClass={colorClass}
        />
        <StatCard
          icon={<BarChart2 className="h-4 w-4 text-blue-400" />}
          label="Volume"
          value={`$${state.totalVolume.toFixed(2)}`}
          valueClass="text-blue-400"
        />
        <StatCard
          icon={<Zap className="h-4 w-4 text-amber-400" />}
          label="Filled Orders"
          value={String(state.filledOrders)}
          valueClass="text-amber-400"
        />
        <StatCard
          icon={<Activity className="h-4 w-4 text-purple-400" />}
          label="Uptime"
          value={uptimeStr}
          valueClass="text-purple-400"
        />
      </div>

      {/* Protección y Sesgo del Mercado */}
      <Card className="bg-zinc-900 border-zinc-700">
        <CardHeader className="pb-2 pt-3">
          <CardTitle className="text-sm text-zinc-300 flex items-center gap-2">
            <Shield className="h-4 w-4 text-blue-400" />
            Protección y Tendencia
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0 space-y-2">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-zinc-500 block mb-1">Sesgo Mercado</span>
              <Badge variant="outline" className={`${bias.border} ${bias.color}`}>
                {state.marketBias === "BULLISH" && <TrendingUp className="h-3 w-3 mr-1" />}
                {state.marketBias === "BEARISH" && <TrendingDown className="h-3 w-3 mr-1" />}
                {bias.label}
              </Badge>
            </div>
            <div>
              <span className="text-zinc-500 block mb-1">Drawdown</span>
              <span className={`font-mono ${state.currentDrawdownPct > 10 ? "text-red-400 font-bold" : state.currentDrawdownPct > 5 ? "text-amber-400" : "text-zinc-200"}`}>
                {state.currentDrawdownPct.toFixed(1)}% / {state.config.maxDrawdownPct ?? 15}%
              </span>
            </div>
            {state.trailingStopPrice !== null && (
              <div>
                <span className="text-zinc-500 block mb-1">Trailing Stop</span>
                <span className="font-mono text-amber-400">
                  ${formatPrice(state.trailingStopPrice)}
                </span>
              </div>
            )}
            {state.gridRepositionCount > 0 && (
              <div>
                <span className="text-zinc-500 block mb-1">Repositionamientos</span>
                <span className="font-mono text-zinc-200">{state.gridRepositionCount}</span>
              </div>
            )}
          </div>
          {state.currentDrawdownPct > 10 && (
            <div className="mt-1 text-[10px] text-red-400 bg-red-500/10 p-1.5 rounded flex items-center gap-1 border border-red-500/20">
              <Activity className="h-3 w-3 shrink-0" />
              Drawdown elevado. Kill switch a {state.config.maxDrawdownPct ?? 15}%.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Position Card */}
      {state.position && parseFloat(state.position.size) !== 0 && (() => {
        const sizeNum = parseFloat(state.position.size);
        const side = sizeNum > 0 ? "long" : "short";
        const entryPrice = parseFloat(state.position.entry_price);
        const liqInfo = getLiquidationInfo(entryPrice, state.config.leverage, side, currentPrice);
        const unrealizedPnl = parseFloat(state.position.unrealized_pnl);
        const { text: pnlText, colorClass: pnlColor } = formatPnL(unrealizedPnl);

        return (
          <Card className="bg-zinc-900 border-zinc-700">
            <CardHeader className="pb-2 pt-3 flex flex-row items-center justify-between">
              <CardTitle className="text-sm text-zinc-300 flex items-center gap-2">
                Posición Abierta
                <Badge variant="outline" className={side === "long" ? "border-emerald-500/50 text-emerald-400" : "border-red-500/50 text-red-400"}>
                  {side.toUpperCase()} {state.config.leverage}x
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0 space-y-2">
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <span className="text-zinc-500 block mb-1">Tamaño</span>
                  <span className="font-mono text-zinc-200">{Math.abs(sizeNum)} {state.config.pair.split("_")[0]}</span>
                </div>
                <div>
                  <span className="text-zinc-500 block mb-1">Precio Entrada</span>
                  <span className="font-mono text-zinc-200">${formatPrice(entryPrice)}</span>
                </div>
                <div>
                  <span className="text-zinc-500 block mb-1">PnL No Realizado</span>
                  <span className={`font-mono ${pnlColor}`}>{pnlText}</span>
                </div>
                <div>
                  <span className="text-zinc-500 block mb-1">Liq. Estimada</span>
                  <span className={`font-mono ${liqInfo.isDanger ? "text-red-400 font-bold" : "text-amber-400"}`}>
                    ${formatPrice(liqInfo.liquidationPrice)}
                  </span>
                </div>
              </div>
              {liqInfo.isDanger && (
                <div className="mt-2 text-[10px] text-red-400 bg-red-500/10 p-1.5 rounded flex items-center gap-1 border border-red-500/20">
                  <Activity className="h-3 w-3 shrink-0" />
                  Peligro! Liquidación a menos del {liqInfo.distancePercent.toFixed(1)}%
                </div>
              )}
            </CardContent>
          </Card>
        );
      })()}

      {/* Current Price */}
      <Card className="bg-zinc-900 border-zinc-700">
        <CardContent className="pt-4 pb-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-500">
              {state.config.pair.replace("_", "/").replace("_Perp", " PERP")}
            </span>
            <Badge
              variant="outline"
              className="text-xs border-emerald-600 text-emerald-400"
            >
              LIVE
            </Badge>
          </div>
          <div className="text-3xl font-bold text-white font-mono mt-1">
            ${formatPrice(currentPrice)}
          </div>
          <div className="flex gap-4 mt-2 text-xs text-zinc-500">
            <span>
              Low:{" "}
              <span className="text-zinc-300 font-mono">
                ${formatPrice(state.config.lowerPrice)}
              </span>
            </span>
            <span>
              High:{" "}
              <span className="text-zinc-300 font-mono">
                ${formatPrice(state.config.upperPrice)}
              </span>
            </span>
          </div>
          {/* Progress bar */}
          <div className="mt-3">
            <div className="h-2 bg-zinc-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-emerald-600 to-blue-500 transition-all duration-1000"
                style={{
                  width: `${Math.min(
                    100,
                    Math.max(
                      0,
                      ((currentPrice - state.config.lowerPrice) /
                        (state.config.upperPrice - state.config.lowerPrice)) *
                        100
                    )
                  )}%`,
                }}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Indicadores Técnicos */}
      {state.indicators && (
        <Card className="bg-zinc-900 border-zinc-700">
          <CardHeader className="pb-2 pt-3 flex flex-row items-center justify-between">
            <CardTitle className="text-sm text-zinc-300 flex items-center gap-2">
              <Activity className="h-4 w-4 text-blue-400" />
              Indicadores Técnicos (5m)
            </CardTitle>
            <Badge variant="outline" className="border-blue-500/50 text-blue-400">
              {state.config.strategyMode.replace(/_/g, " ")}
            </Badge>
          </CardHeader>
          <CardContent className="pt-0 space-y-2">
             <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <span className="text-zinc-500 block mb-1">EMA 21 / 50</span>
                  <span className="font-mono text-zinc-200">
                    {state.indicators.ema21 ? Math.round(state.indicators.ema21) : "-"} / {state.indicators.ema50 ? Math.round(state.indicators.ema50) : "-"}
                  </span>
                </div>
                <div>
                  <span className="text-zinc-500 block mb-1">EMA 200</span>
                  <span className={`font-mono ${state.indicators.trendStrength !== null ? (state.indicators.trendStrength > 0 ? "text-emerald-400" : "text-red-400") : "text-zinc-200"}`}>
                    {state.indicators.ema200 ? Math.round(state.indicators.ema200) : "-"}
                    {state.indicators.trendStrength !== null && (
                      <span className="text-[10px] ml-1">({state.indicators.trendStrength > 0 ? "+" : ""}{state.indicators.trendStrength.toFixed(1)}%)</span>
                    )}
                  </span>
                </div>
                <div>
                  <span className="text-zinc-500 block mb-1">RSI (14)</span>
                  <span className={`font-mono ${state.indicators.rsi.length > 0 ? (state.indicators.rsi[state.indicators.rsi.length - 1] > 70 ? 'text-red-400' : state.indicators.rsi[state.indicators.rsi.length - 1] < 30 ? 'text-emerald-400' : 'text-zinc-200') : 'text-zinc-200'}`}>
                    {state.indicators.rsi.length > 0 ? state.indicators.rsi[state.indicators.rsi.length - 1].toFixed(2) : "-"}
                  </span>
                </div>
                <div>
                  <span className="text-zinc-500 block mb-1">MACD</span>
                  <span className="font-mono text-zinc-200">
                    {state.indicators.macd.length > 0 && state.indicators.macd[state.indicators.macd.length - 1].MACD != null
                      ? state.indicators.macd[state.indicators.macd.length - 1].MACD?.toFixed(2)
                      : "-"}
                  </span>
                </div>
                <div>
                  <span className="text-zinc-500 block mb-1">ATR (14)</span>
                  <span className="font-mono text-zinc-200">
                    {state.indicators.atr ? state.indicators.atr.toFixed(2) : "-"}
                  </span>
                </div>
                <div>
                  <span className="text-zinc-500 block mb-1">Volatilidad</span>
                  <span className={`font-mono ${state.indicators.volatilityRatio !== null && state.indicators.volatilityRatio > 0.03 ? "text-red-400" : "text-zinc-200"}`}>
                    {state.indicators.volatilityRatio !== null
                      ? `${(state.indicators.volatilityRatio * 100).toFixed(2)}%`
                      : "-"}
                  </span>
                </div>
             </div>
             {state.indicators.emaCrossState !== "NONE" && (
               <div className={`text-[10px] p-1.5 rounded flex items-center gap-1 border ${
                 state.indicators.emaCrossState === "GOLDEN"
                   ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
                   : "text-red-400 bg-red-500/10 border-red-500/20"
               }`}>
                 {state.indicators.emaCrossState === "GOLDEN" ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                 {state.indicators.emaCrossState === "GOLDEN" ? "Golden Cross (EMA50 > EMA200)" : "Death Cross (EMA50 < EMA200)"}
               </div>
             )}
          </CardContent>
        </Card>
      )}

      {/* PnL Chart */}
      {pnlChartData.length > 1 && (
        <Card className="bg-zinc-900 border-zinc-700">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-zinc-400 flex items-center gap-2">
              <TrendingUp className="h-3.5 w-3.5" />
              PnL History
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <ResponsiveContainer width="100%" height={100}>
              <LineChart data={pnlChartData}>
                <XAxis dataKey="t" hide />
                <YAxis hide />
                <Tooltip
                  contentStyle={{
                    background: "#18181b",
                    border: "1px solid #3f3f46",
                    borderRadius: 8,
                    fontSize: 11,
                  }}
                  formatter={(v) => [`$${Number(v).toFixed(4)}`, "PnL"]}
                />
                <Line
                  type="monotone"
                  dataKey="pnl"
                  stroke="#10b981"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Grid Visualization */}
      {["NEUTRAL_GRID", "LONG_GRID", "SHORT_GRID", "AUTO_GRID"].includes(state.config.strategyMode) && gridData.length > 0 && (
        <Card className="bg-zinc-900 border-zinc-700">
          <CardHeader className="pb-2">
          <CardTitle className="text-xs text-zinc-400">Grid Levels</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="space-y-1 max-h-64 overflow-y-auto pr-1">
            {gridData.map((level, i) => (
              <div
                key={i}
                className={`flex items-center justify-between px-2 py-1 rounded text-xs font-mono transition-colors ${
                  Math.abs(level.price - currentPrice) < 10
                    ? "bg-zinc-700/70 border border-zinc-600"
                    : "hover:bg-zinc-800/50"
                }`}
              >
                <span
                  className={
                    level.type === "buy"
                      ? "text-emerald-400"
                      : "text-red-400"
                  }
                >
                  {level.type === "buy" ? "BUY " : "SELL"}
                </span>
                <span className="text-zinc-300">
                  ${formatPrice(level.price)}
                </span>
                {level.filled && (
                  <Badge className="text-[10px] bg-blue-500/20 text-blue-400 border-blue-500/30">
                    FILLED
                  </Badge>
                )}
                {!level.filled && Math.abs(level.price - currentPrice) < 5 && (
                  <Badge className="text-[10px] bg-amber-500/20 text-amber-400 border-amber-500/30">
                    PRICE
                  </Badge>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
      )}
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  valueClass,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  valueClass: string;
}) {
  return (
    <Card className="bg-zinc-900 border-zinc-700">
      <CardContent className="pt-3 pb-3">
        <div className="flex items-center gap-2 mb-1">
          {icon}
          <span className="text-xs text-zinc-500">{label}</span>
        </div>
        <div className={`text-lg font-bold font-mono ${valueClass}`}>
          {value}
        </div>
      </CardContent>
    </Card>
  );
}
