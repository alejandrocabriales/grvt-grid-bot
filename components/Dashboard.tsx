"use client";

import { GridState, formatPrice, formatPnL } from "@/lib/grid-bot";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Activity,
  BarChart2,
  DollarSign,
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
import { useMemo } from "react";

interface Props {
  state: GridState;
  currentPrice: number;
}

export function Dashboard({ state, currentPrice }: Props) {
  const { totalPnL, colorClass } = useMemo(() => {
    const { text, colorClass } = formatPnL(state.totalPnL);
    return { totalPnL: text, colorClass };
  }, [state.totalPnL]);

  const uptime = useMemo(() => {
    const ms = Date.now() - state.startTime;
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }, [state.startTime]);

  // Generate price grid visualization data
  const gridData = useMemo(() => {
    return state.levels
      .map((level) => ({
        price: level.price,
        type: level.price < currentPrice ? "buy" : "sell",
        active: Math.abs(level.price - currentPrice) < state.config.gridCount,
        filled: level.filled,
      }))
      .reverse();
  }, [state.levels, currentPrice, state.config.gridCount]);

  // PnL chart data from logs
  const pnlChartData = useMemo(() => {
    let cumulative = 0;
    return state.logs
      .filter((l) => l.message.includes("PnL"))
      .reverse()
      .map((l, i) => {
        const match = l.message.match(/\+\$([0-9.]+)/);
        if (match) cumulative += parseFloat(match[1]);
        return { t: i, pnl: cumulative };
      });
  }, [state.logs]);

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
          value={uptime}
          valueClass="text-purple-400"
        />
      </div>

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
          {/* Progress bar showing current price in range */}
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
                {Math.abs(level.price - currentPrice) < 5 && (
                  <Badge className="text-[10px] bg-amber-500/20 text-amber-400 border-amber-500/30">
                    ← PRICE
                  </Badge>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
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
