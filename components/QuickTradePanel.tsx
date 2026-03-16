"use client";

/**
 * QuickTradePanel — Abre posiciones Long/Short con TP y SL manual.
 * Monitorea el precio cada 3s y cierra la posición al alcanzar TP o SL.
 * Incluye sugerencias automáticas basadas en el sesgo de mercado.
 */

import { useCallback, useEffect, useRef, useState } from "react";
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
import { calculateIndicators } from "@/lib/indicators";
import { detectMarketBiasLegacy } from "@/lib/grid-bot";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Loader2,
  TrendingDown,
  TrendingUp,
  X,
  Zap,
} from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ActiveTrade {
  orderId: string;
  instrument: string;
  direction: "long" | "short";
  entryPrice: number;
  size: string;
  tp: number | null;
  sl: number | null;
  openedAt: number;
}

type MarketBias = "BULLISH" | "BEARISH" | "NEUTRAL";

const SUPPORTED_PAIRS = [
  "ETH_USDT_Perp",
  "BTC_USDT_Perp",
  "SOL_USDT_Perp",
  "ARB_USDT_Perp",
  "OP_USDT_Perp",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatPnL(pnl: number): string {
  return (pnl >= 0 ? "+" : "") + "$" + pnl.toFixed(4);
}

// ─── Component ────────────────────────────────────────────────────────────────

export function QuickTradePanel() {
  const [pair, setPair] = useState("ETH_USDT_Perp");
  const [investment, setInvestment] = useState("50");
  const [leverage, setLeverage] = useState("10");
  const [tpPct, setTpPct] = useState("4");
  const [slPct, setSlPct] = useState("2.5");

  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [priceLoading, setPriceLoading] = useState(false);
  const [bias, setBias] = useState<MarketBias | null>(null);

  const [activeTrade, setActiveTrade] = useState<ActiveTrade | null>(null);
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [loading, setLoading] = useState<"long" | "short" | "close" | null>(null);
  const [statusMsg, setStatusMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [closedMsg, setClosedMsg] = useState<string | null>(null);

  const monitorRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tradeRef = useRef<ActiveTrade | null>(null);
  tradeRef.current = activeTrade;

  // ── Fetch price + bias when pair changes ────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setPriceLoading(true);
    setLivePrice(null);
    setBias(null);

    const run = async () => {
      try {
        const res = await fetch(`/api/bot/price?instrument=${pair}`);
        const data = await res.json();
        if (!cancelled && data.price > 0) {
          setLivePrice(data.price);
        }
        // Detect bias from klines
        const klinesRes = await fetch(`/api/bot/klines?instrument=${pair}&interval=5m&limit=220`);
        const klinesData = await klinesRes.json();
        if (!cancelled && klinesData.ok && klinesData.klines?.length > 0) {
          const ind = calculateIndicators(klinesData.klines);
          const b = detectMarketBiasLegacy(data.price, ind.ema50, ind.ema200, ind.rsi);
          setBias(b);
          // Auto-suggest TP/SL
          if (b === "BULLISH") {
            setTpPct("4"); setSlPct("2.5");
          } else if (b === "BEARISH") {
            setTpPct("4"); setSlPct("2.5");
          }
        }
      } catch { /* ignore */ } finally {
        if (!cancelled) setPriceLoading(false);
      }
    };

    run();
    const interval = setInterval(run, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [pair]);

  // ── TP/SL monitor loop ───────────────────────────────────────────────────────
  const stopMonitor = useCallback(() => {
    if (monitorRef.current) {
      clearInterval(monitorRef.current);
      monitorRef.current = null;
    }
  }, []);

  const closePosition = useCallback(async (reason: string) => {
    const trade = tradeRef.current;
    if (!trade) return;
    stopMonitor();

    try {
      const res = await fetch("/api/bot/orders/close-position", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instrument: trade.instrument }),
      });
      const data = await res.json();
      if (data.ok) {
        setClosedMsg(`Posición cerrada: ${reason}`);
        setActiveTrade(null);
      }
    } catch {
      setClosedMsg(`Error al cerrar: ${reason}`);
    }
  }, [stopMonitor]);

  const startMonitor = useCallback((trade: ActiveTrade) => {
    stopMonitor();
    monitorRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/bot/price?instrument=${trade.instrument}`);
        const data = await res.json();
        if (!data.price) return;
        const price: number = data.price;
        setCurrentPrice(price);

        const t = tradeRef.current;
        if (!t) { stopMonitor(); return; }

        if (t.direction === "long") {
          if (t.tp && price >= t.tp) { await closePosition(`TP alcanzado @ $${price.toFixed(2)}`); return; }
          if (t.sl && price <= t.sl) { await closePosition(`SL alcanzado @ $${price.toFixed(2)}`); return; }
        } else {
          if (t.tp && price <= t.tp) { await closePosition(`TP alcanzado @ $${price.toFixed(2)}`); return; }
          if (t.sl && price >= t.sl) { await closePosition(`SL alcanzado @ $${price.toFixed(2)}`); return; }
        }
      } catch { /* ignore */ }
    }, 3_000);
  }, [stopMonitor, closePosition]);

  useEffect(() => () => stopMonitor(), [stopMonitor]);

  // ── Open trade ───────────────────────────────────────────────────────────────
  const openTrade = async (direction: "long" | "short") => {
    if (!livePrice) return;
    setLoading(direction);
    setStatusMsg(null);
    setClosedMsg(null);

    const inv = parseFloat(investment);
    const lev = parseInt(leverage);
    const tpPctN = parseFloat(tpPct);
    const slPctN = parseFloat(slPct);

    const tp = tpPctN > 0
      ? direction === "long"
        ? livePrice * (1 + tpPctN / 100)
        : livePrice * (1 - tpPctN / 100)
      : null;

    const sl = slPctN > 0
      ? direction === "long"
        ? livePrice * (1 - slPctN / 100)
        : livePrice * (1 + slPctN / 100)
      : null;

    try {
      const res = await fetch("/api/bot/orders/open-trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instrument: pair, direction, investment: inv, leverage: lev }),
      });
      const data = await res.json();

      if (!data.ok) {
        setStatusMsg({ text: data.error ?? "Error desconocido", ok: false });
        return;
      }

      const trade: ActiveTrade = {
        orderId: data.order_id,
        instrument: pair,
        direction,
        entryPrice: data.entryPrice,
        size: data.size,
        tp,
        sl,
        openedAt: Date.now(),
      };
      setActiveTrade(trade);
      setCurrentPrice(data.entryPrice);
      setStatusMsg({ text: `${direction === "long" ? "Long" : "Short"} abierto @ $${data.entryPrice.toFixed(2)}`, ok: true });
      startMonitor(trade);
    } catch (e) {
      setStatusMsg({ text: String(e), ok: false });
    } finally {
      setLoading(null);
    }
  };

  const handleClose = async () => {
    setLoading("close");
    await closePosition("Cierre manual");
    setLoading(null);
  };

  // ── Derived values ───────────────────────────────────────────────────────────
  const tp_long = livePrice && parseFloat(tpPct) > 0 ? livePrice * (1 + parseFloat(tpPct) / 100) : null;
  const sl_long = livePrice && parseFloat(slPct) > 0 ? livePrice * (1 - parseFloat(slPct) / 100) : null;
  const tp_short = livePrice && parseFloat(tpPct) > 0 ? livePrice * (1 - parseFloat(tpPct) / 100) : null;
  const sl_short = livePrice && parseFloat(slPct) > 0 ? livePrice * (1 + parseFloat(slPct) / 100) : null;

  const unrealizedPnl =
    activeTrade && currentPrice
      ? activeTrade.direction === "long"
        ? (currentPrice - activeTrade.entryPrice) * parseFloat(activeTrade.size)
        : (activeTrade.entryPrice - currentPrice) * parseFloat(activeTrade.size)
      : null;

  const biasColor =
    bias === "BULLISH" ? "text-emerald-400" :
    bias === "BEARISH" ? "text-red-400" :
    "text-zinc-400";

  const biasLabel =
    bias === "BULLISH" ? "ALCISTA → sugerido: LONG" :
    bias === "BEARISH" ? "BAJISTA → sugerido: SHORT" :
    bias === "NEUTRAL" ? "NEUTRAL" : "Calculando…";

  return (
    <Card className="bg-zinc-900 border-zinc-700">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2 text-zinc-300">
          <Zap className="h-4 w-4 text-yellow-400" />
          Posición Directa
          {activeTrade && (
            <Badge
              variant="outline"
              className={
                activeTrade.direction === "long"
                  ? "ml-auto border-emerald-500 text-emerald-400 text-[10px] animate-pulse"
                  : "ml-auto border-red-500 text-red-400 text-[10px] animate-pulse"
              }
            >
              {activeTrade.direction === "long" ? "▲ LONG" : "▼ SHORT"} activo
            </Badge>
          )}
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-3">

        {/* Pair + live price */}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs text-zinc-500 mb-1 block">Par</label>
            <Select
              value={pair}
              onValueChange={(v) => setPair(v ?? pair)}
              disabled={!!activeTrade}
            >
              <SelectTrigger className="bg-zinc-800 border-zinc-600 text-zinc-200 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-zinc-800 border-zinc-700">
                {SUPPORTED_PAIRS.map((p) => (
                  <SelectItem key={p} value={p} className="text-zinc-200 text-xs">{p}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col justify-end">
            <div className="rounded-lg bg-zinc-800/50 px-3 py-2 border border-zinc-700/50 text-center">
              {priceLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500 mx-auto" />
              ) : livePrice ? (
                <span className="text-sm font-mono font-semibold text-emerald-400">
                  ${livePrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              ) : (
                <span className="text-xs text-zinc-600">—</span>
              )}
            </div>
          </div>
        </div>

        {/* Market bias suggestion */}
        {livePrice && (
          <div className={`flex items-center gap-1.5 text-[11px] px-2 py-1.5 rounded border ${
            bias === "BULLISH" ? "bg-emerald-500/10 border-emerald-500/20" :
            bias === "BEARISH" ? "bg-red-500/10 border-red-500/20" :
            "bg-zinc-800/50 border-zinc-700/50"
          }`}>
            {bias === "BULLISH" ? <TrendingUp className="h-3.5 w-3.5 text-emerald-400 shrink-0" /> :
             bias === "BEARISH" ? <TrendingDown className="h-3.5 w-3.5 text-red-400 shrink-0" /> :
             <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500 shrink-0" />}
            <span className={biasColor + " font-medium"}>{biasLabel}</span>
          </div>
        )}

        {/* Investment + Leverage */}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs text-zinc-500 mb-1 block">Inversión (USDC)</label>
            <Input
              type="number"
              value={investment}
              onChange={(e) => setInvestment(e.target.value)}
              className="bg-zinc-800 border-zinc-600 text-zinc-200 text-xs"
              disabled={!!activeTrade}
            />
          </div>
          <div>
            <label className="text-xs text-zinc-500 mb-1 block">Leverage</label>
            <Select
              value={leverage}
              onValueChange={(v) => setLeverage(v ?? leverage)}
              disabled={!!activeTrade}
            >
              <SelectTrigger className="bg-zinc-800 border-zinc-600 text-zinc-200 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-zinc-800 border-zinc-700">
                {["1", "2", "3", "5", "10", "20"].map((l) => (
                  <SelectItem key={l} value={l} className="text-zinc-200 text-xs">{l}x</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* TP / SL % */}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs text-zinc-500 mb-1 block">
              Take Profit (%) <span className="text-zinc-700">0 = sin TP</span>
            </label>
            <Input
              type="number"
              step="0.5"
              min="0"
              value={tpPct}
              onChange={(e) => setTpPct(e.target.value)}
              className="bg-zinc-800 border-zinc-600 text-zinc-200 text-xs"
              disabled={!!activeTrade}
            />
          </div>
          <div>
            <label className="text-xs text-zinc-500 mb-1 block">
              Stop Loss (%) <span className="text-zinc-700">0 = sin SL</span>
            </label>
            <Input
              type="number"
              step="0.5"
              min="0"
              value={slPct}
              onChange={(e) => setSlPct(e.target.value)}
              className="bg-zinc-800 border-zinc-600 text-zinc-200 text-xs"
              disabled={!!activeTrade}
            />
          </div>
        </div>

        {/* Preview TP/SL prices */}
        {livePrice && !activeTrade && (
          <div className="rounded-lg bg-zinc-800/30 border border-zinc-700/40 p-2.5 space-y-1.5">
            <p className="text-[10px] text-zinc-600 uppercase font-medium tracking-wide">Precios estimados</p>
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              {/* LONG */}
              <div className="space-y-0.5">
                <p className="text-emerald-500 font-semibold flex items-center gap-0.5"><ArrowUp className="h-3 w-3" /> Long</p>
                {tp_long && <p className="text-zinc-400">TP: <span className="text-emerald-400 font-mono">${tp_long.toFixed(2)}</span></p>}
                {sl_long && <p className="text-zinc-400">SL: <span className="text-red-400 font-mono">${sl_long.toFixed(2)}</span></p>}
                {!tp_long && !sl_long && <p className="text-zinc-600">Sin TP/SL</p>}
              </div>
              {/* SHORT */}
              <div className="space-y-0.5">
                <p className="text-red-500 font-semibold flex items-center gap-0.5"><ArrowDown className="h-3 w-3" /> Short</p>
                {tp_short && <p className="text-zinc-400">TP: <span className="text-emerald-400 font-mono">${tp_short.toFixed(2)}</span></p>}
                {sl_short && <p className="text-zinc-400">SL: <span className="text-red-400 font-mono">${sl_short.toFixed(2)}</span></p>}
                {!tp_short && !sl_short && <p className="text-zinc-600">Sin TP/SL</p>}
              </div>
            </div>
            <p className="text-[10px] text-zinc-600">
              Capital efectivo: <span className="text-zinc-400 font-mono">${(parseFloat(investment) * parseInt(leverage)).toFixed(2)}</span>
            </p>
          </div>
        )}

        {/* Active trade info */}
        {activeTrade && currentPrice && (
          <div className={`rounded-lg border p-2.5 space-y-1.5 ${
            activeTrade.direction === "long"
              ? "bg-emerald-500/10 border-emerald-500/20"
              : "bg-red-500/10 border-red-500/20"
          }`}>
            <div className="flex items-center justify-between text-xs">
              <span className="text-zinc-400">Entrada</span>
              <span className="font-mono text-zinc-200">${activeTrade.entryPrice.toFixed(2)}</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-zinc-400">Precio actual</span>
              <span className="font-mono text-zinc-200">${currentPrice.toFixed(2)}</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-zinc-400">Tamaño</span>
              <span className="font-mono text-zinc-200">{activeTrade.size}</span>
            </div>
            {activeTrade.tp && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-zinc-400">Take Profit</span>
                <span className="font-mono text-emerald-400">${activeTrade.tp.toFixed(2)}</span>
              </div>
            )}
            {activeTrade.sl && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-zinc-400">Stop Loss</span>
                <span className="font-mono text-red-400">${activeTrade.sl.toFixed(2)}</span>
              </div>
            )}
            {unrealizedPnl !== null && (
              <div className="flex items-center justify-between text-xs font-semibold border-t border-zinc-700/50 pt-1.5">
                <span className="text-zinc-400">PnL no realizado</span>
                <span className={`font-mono ${unrealizedPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {formatPnL(unrealizedPnl)}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Status / error messages */}
        {statusMsg && (
          <div className={`flex items-start gap-1.5 text-xs p-2 rounded border ${
            statusMsg.ok
              ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-300"
              : "bg-red-500/10 border-red-500/20 text-red-300"
          }`}>
            {!statusMsg.ok && <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />}
            {statusMsg.text}
          </div>
        )}

        {closedMsg && (
          <div className="text-xs p-2 rounded border bg-zinc-800/50 border-zinc-700/50 text-zinc-400">
            {closedMsg}
          </div>
        )}

        {/* Action buttons */}
        {!activeTrade ? (
          <div className="grid grid-cols-2 gap-2">
            <Button
              size="sm"
              className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs gap-1.5"
              disabled={!livePrice || loading !== null}
              onClick={() => openTrade("long")}
            >
              {loading === "long" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ArrowUp className="h-3.5 w-3.5" />
              )}
              Abrir Long
            </Button>
            <Button
              size="sm"
              className="bg-red-600 hover:bg-red-500 text-white text-xs gap-1.5"
              disabled={!livePrice || loading !== null}
              onClick={() => openTrade("short")}
            >
              {loading === "short" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ArrowDown className="h-3.5 w-3.5" />
              )}
              Abrir Short
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="w-full border-zinc-600 text-zinc-300 hover:bg-zinc-800 text-xs gap-1.5"
            disabled={loading === "close"}
            onClick={handleClose}
          >
            {loading === "close" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <X className="h-3.5 w-3.5" />
            )}
            Cerrar Posición
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
