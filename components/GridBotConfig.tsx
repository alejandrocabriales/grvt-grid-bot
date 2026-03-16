"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { GridConfig, calculateMaxGrids, detectMarketBiasLegacy } from "@/lib/grid-bot";
import { calculateIndicators } from "@/lib/indicators";
import {
  AlertTriangle,
  CheckCircle2,
  FileKey2,
  Loader2,
  Play,
  ShieldCheck,
  Square,
  XCircle,
} from "lucide-react";

const SUPPORTED_PAIRS = [
  "ETH_USDT_Perp",
  "BTC_USDT_Perp",
  "SOL_USDT_Perp",
  "ARB_USDT_Perp",
  "OP_USDT_Perp",
  "XRP_USDT_Perp",
];

// ─── Tipos para el estado de credenciales ────────────────────────────────────

interface CredStatus {
  loading: boolean;
  ok: boolean;
  missing: string[];
  sessionActive: boolean;
  masked: {
    apiKey: string;
    signerAddress: string;
    subAccountId: string;
  } | null;
}

// ─── Componente ───────────────────────────────────────────────────────────────

interface Props {
  isRunning: boolean;
  isConnecting: boolean;
  error: string | null;
  onStart: (config: GridConfig) => void;
  onStop: () => void;
}

export function GridBotConfig({
  isRunning,
  isConnecting,
  error,
  onStart,
  onStop,
}: Props) {
  const [creds, setCreds] = useState<CredStatus>({
    loading: true,
    ok: false,
    missing: [],
    sessionActive: false,
    masked: null,
  });

  const [form, setForm] = useState({
    pair: "ETH_USDT_Perp",
    strategyMode: "NEUTRAL_GRID" as GridConfig["strategyMode"],
    upperPrice: "",
    lowerPrice: "",
    gridCount: "5",
    totalInvestment: "100",
    leverage: "20",
    stopLoss: "",
    takeProfit: "",
    atrMultiplier: "1.5",
    riskPerTrade: "1.5",
    maxDrawdownPct: "15",
    enableTrailingStop: true,
    trailingAtrMult: "2.0",
    autoReposition: true,
    trendFilterEnabled: true,
    gridType: "GEOMETRIC" as GridConfig["gridType"],
    autoRange: false,
    // ─── Módulos dinámicos avanzados ───────────────────────────────────────
    atrStepMult: "0.5",
    marginGuardPct: "15",
    macroRsiExit: false,
  });

  // Live price for the selected pair
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [priceLoading, setPriceLoading] = useState(false);
  const [minSize, setMinSize] = useState(0.01);
  const [balance, setBalance] = useState<number | null>(null);
  const [strategyTip, setStrategyTip] = useState<string | null>(null);
  // Preset seleccionado (índice 0/1/2) para mostrar borde activo
  const [selectedPresetIdx, setSelectedPresetIdx] = useState<number | null>(null);
  // Sesgo de mercado detectado automáticamente al cargar el par
  const [detectedBias, setDetectedBias] = useState<"BULLISH" | "BEARISH" | "NEUTRAL" | null>(null);

  // Verificar credenciales al montar (llama /api/credentials)
  useEffect(() => {
    const check = async () => {
      setCreds((c) => ({ ...c, loading: true }));
      try {
        const res = await fetch("/api/credentials");
        const data = await res.json();
        setCreds({
          loading: false,
          ok: data.ok,
          missing: data.missing ?? [],
          sessionActive: data.sessionActive ?? false,
          masked: data.masked ?? null,
        });
      } catch {
        setCreds({
          loading: false,
          ok: false,
          missing: ["Error de red al leer /api/credentials"],
          sessionActive: false,
          masked: null,
        });
      }
    };
    check();
    // Re-verificar cada 30s para actualizar estado de sesión
    const interval = setInterval(check, 30_000);
    return () => clearInterval(interval);
  }, []);

  // Fetch balance
  useEffect(() => {
    const fetchBalance = async () => {
      try {
        const res = await fetch("/api/bot/balance");
        const data = await res.json();
        if (data.ok) {
          const eq = parseFloat(data.equity);
          if (eq > 0) setBalance(eq);
        }
      } catch { /* ignore */ }
    };
    fetchBalance();
    const interval = setInterval(fetchBalance, 30_000);
    return () => clearInterval(interval);
  }, []);

  // Fetch live price + detectar sesgo de mercado cuando cambia el par
  useEffect(() => {
    let cancelled = false;

    const fetchPriceAndBias = async () => {
      setPriceLoading(true);
      setLivePrice(null);
      setDetectedBias(null);
      setSelectedPresetIdx(null); // Resetear selección al cambiar de par
      try {
        // Precio e info del instrumento
        const res = await fetch(`/api/bot/price?instrument=${form.pair}`);
        const data = await res.json();
        if (!cancelled && data.price > 0) {
          const price = data.price;
          setLivePrice(price);
          if (data.minSize) setMinSize(parseFloat(data.minSize));
          // Auto-fill de rango si está vacío
          setForm((f) => {
            const needsAutoFill = !f.lowerPrice && !f.upperPrice;
            if (needsAutoFill) {
              const lower = Math.floor(price * 0.97);
              const upper = Math.ceil(price * 1.03);
              return { ...f, lowerPrice: String(lower), upperPrice: String(upper) };
            }
            return f;
          });

          // Detectar sesgo del mercado en segundo plano (no bloquea el UI)
          try {
            const klinesRes = await fetch(
              `/api/bot/klines?instrument=${form.pair}&interval=5m&limit=220`
            );
            const klinesData = await klinesRes.json();
            if (!cancelled && klinesData.ok && klinesData.klines?.length > 0) {
              const indicators = calculateIndicators(klinesData.klines);
              const bias = detectMarketBiasLegacy(price, indicators.ema50, indicators.ema200, indicators.rsi);
              setDetectedBias(bias);
            }
          } catch {
            // Indicadores opcionales — no bloquear si fallan
          }
        }
      } catch {
        // silently fail
      } finally {
        if (!cancelled) setPriceLoading(false);
      }
    };

    fetchPriceAndBias();
    const interval = setInterval(fetchPriceAndBias, 30_000); // Cada 30s (no tan frecuente)
    return () => { cancelled = true; clearInterval(interval); };
  }, [form.pair]);

  const set = (key: string) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((f) => ({ ...f, [key]: e.target.value }));
    if (key === "stopLoss" || key === "takeProfit") setStrategyTip(null);
  };

  const gridStep =
    (parseFloat(form.upperPrice) - parseFloat(form.lowerPrice)) /
    parseInt(form.gridCount);

  const profitPerGrid = (gridStep / parseFloat(form.lowerPrice)) * 100;

  const handleStart = () => {
    if (!creds.ok) return;

    const config: GridConfig = {
      pair: form.pair,
      strategyMode: form.strategyMode,
      upperPrice: parseFloat(form.upperPrice) || 0,
      lowerPrice: parseFloat(form.lowerPrice) || 0,
      gridCount: parseInt(form.gridCount) || 2,
      totalInvestment: parseFloat(form.totalInvestment),
      leverage: parseInt(form.leverage) || 1,
      stopLoss: form.stopLoss ? parseFloat(form.stopLoss) : undefined,
      takeProfit: form.takeProfit ? parseFloat(form.takeProfit) : undefined,
      atrMultiplier: parseFloat(form.atrMultiplier),
      riskPerTrade: parseFloat(form.riskPerTrade),
      maxDrawdownPct: parseFloat(form.maxDrawdownPct) || 15,
      enableTrailingStop: form.enableTrailingStop,
      trailingAtrMult: parseFloat(form.trailingAtrMult) || 2.0,
      autoReposition: form.autoReposition,
      trendFilterEnabled: form.trendFilterEnabled,
      gridType: form.gridType,
      autoRange: form.autoRange,
      atrStepMult: parseFloat(form.atrStepMult) || 0.5,
      marginGuardPct: parseFloat(form.marginGuardPct) || 15,
      macroRsiExit: form.macroRsiExit,
    };

    const isGridMode = ["NEUTRAL_GRID", "LONG_GRID", "SHORT_GRID", "AUTO_GRID"].includes(config.strategyMode);
    if (isGridMode) {
      if (config.upperPrice <= config.lowerPrice)
        return alert("El precio superior debe ser mayor al inferior");
      if (config.gridCount < 2) return alert("Se necesitan al menos 2 grids");
      if (livePrice && (livePrice < config.lowerPrice || livePrice > config.upperPrice))
        return alert(
          `El precio actual ($${livePrice.toFixed(2)}) está fuera del rango [$${config.lowerPrice} – $${config.upperPrice}].`
        );
    }
    if (config.totalInvestment <= 0) return alert("La inversión debe ser > 0");


    onStart(config);
  };

  return (
    <div className="space-y-4">

      {/* ── Sección de Credenciales (solo estado, sin inputs) ──────────────── */}
      <Card className="bg-zinc-900 border-zinc-700">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2 text-zinc-300">
            <FileKey2 className="h-4 w-4" />
            Credenciales
            <span className="ml-auto">
              {creds.loading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500" />
              ) : creds.ok ? (
                <ShieldCheck className="h-4 w-4 text-emerald-400" />
              ) : (
                <XCircle className="h-4 w-4 text-red-400" />
              )}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">

          {creds.loading ? (
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <Loader2 className="h-3 w-3 animate-spin" />
              Verificando archivo .env...
            </div>
          ) : creds.ok ? (
            <>
              {/* Badge de estado general */}
              <div className="flex items-center gap-2 p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                <div>
                  <p className="text-xs font-semibold text-emerald-300">
                    Configuración cargada desde .env
                  </p>
                  <p className="text-[10px] text-emerald-500/80 mt-0.5">
                    Las claves nunca se exponen en el navegador
                  </p>
                </div>
              </div>

              {/* Valores enmascarados (solo para confirmación visual) */}
              <div className="space-y-2 pt-1">
                <MaskedField
                  label="API Key"
                  value={creds.masked?.apiKey ?? ""}
                />
                <MaskedField
                  label="Signer Address (EIP-712)"
                  value={creds.masked?.signerAddress ?? ""}
                  fullWidth
                />
                <MaskedField
                  label="Sub Account ID"
                  value={creds.masked?.subAccountId ?? ""}
                />
              </div>

              {/* Estado de la sesión GRVT */}
              <div className="flex items-center justify-between text-xs pt-1">
                <span className="text-zinc-500">Sesión GRVT</span>
                <Badge
                  variant="outline"
                  className={
                    creds.sessionActive
                      ? "border-emerald-600 text-emerald-400 text-[10px]"
                      : "border-zinc-600 text-zinc-500 text-[10px]"
                  }
                >
                  {creds.sessionActive ? "Activa" : "Sin sesión"}
                </Badge>
              </div>
            </>
          ) : (
            /* Error: faltan variables */
            <Alert className="border-red-500/30 bg-red-500/10 p-3">
              <XCircle className="h-4 w-4 text-red-400" />
              <AlertDescription className="text-red-300 text-xs ml-2">
                <p className="font-semibold mb-1">
                  Faltan credenciales en el archivo .env:
                </p>
                <ul className="list-disc list-inside space-y-0.5">
                  {creds.missing.map((v) => (
                    <li key={v} className="font-mono text-red-400">
                      {v}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-zinc-400">
                  Crea un archivo <code className="text-zinc-300">.env</code> en
                  la raíz del proyecto (usa{" "}
                  <code className="text-zinc-300">.env.example</code> como
                  plantilla) y reinicia el servidor.
                </p>
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {/* ── Parámetros de la Estrategia ──────────────────────────────────────── */}
      <Card className="bg-zinc-900 border-zinc-700">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm text-zinc-300">
            Configuración de Estrategia
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-zinc-500 mb-1 block">
                Fase de Mercado
              </label>
              <Select
                value={form.strategyMode}
                onValueChange={(v) => {
                  setForm((f) => ({ ...f, strategyMode: v as typeof f.strategyMode }));
                  setStrategyTip(null);
                }}
                disabled={isRunning}
              >
                <SelectTrigger className="bg-zinc-800 border-zinc-600 text-zinc-200 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-zinc-800 border-zinc-700">
                  <SelectItem value="AUTO_GRID" className="text-blue-400 text-xs font-semibold">Auto Grid (sigue tendencia)</SelectItem>
                  <SelectItem value="NEUTRAL_GRID" className="text-zinc-200 text-xs">Neutral Grid</SelectItem>
                  <SelectItem value="LONG_GRID" className="text-emerald-400 text-xs">Long Grid (solo compras)</SelectItem>
                  <SelectItem value="SHORT_GRID" className="text-red-400 text-xs">Short Grid (solo ventas)</SelectItem>
                  <SelectItem value="BULL_MOMENTUM" className="text-emerald-400 text-xs font-semibold">Direccional Alcista</SelectItem>
                  <SelectItem value="BEAR_BREAKDOWN" className="text-red-400 text-xs font-semibold">Direccional Bajista</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <label className="text-xs text-zinc-500 mb-1 block">
              Par de Trading
            </label>
            <Select
              value={form.pair}
              onValueChange={(v) => {
                setForm((f) => ({ ...f, pair: v ?? f.pair, lowerPrice: "", upperPrice: "" }));
                setStrategyTip(null);
              }}
              disabled={isRunning}
            >
              <SelectTrigger className="bg-zinc-800 border-zinc-600 text-zinc-200 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-zinc-800 border-zinc-700">
                {SUPPORTED_PAIRS.map((p) => (
                  <SelectItem
                    key={p}
                    value={p}
                    className="text-zinc-200 text-xs"
                  >
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Live price + balance indicator */}
          <div className="rounded-lg bg-zinc-800/50 p-3 border border-zinc-700/50 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-zinc-500">Precio actual</span>
              {priceLoading ? (
                <Loader2 className="h-3 w-3 animate-spin text-zinc-500" />
              ) : livePrice ? (
                <span className="text-sm font-mono font-semibold text-emerald-400">
                  ${livePrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              ) : (
                <span className="text-xs text-zinc-600">No disponible</span>
              )}
            </div>
            {balance !== null && (
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-500">Balance sub-cuenta</span>
                <span className={`text-sm font-mono font-semibold ${balance > 0 ? "text-emerald-400" : "text-red-400"}`}>
                  ${balance.toFixed(2)}
                </span>
              </div>
            )}
            {balance !== null && balance <= 0 && (
              <p className="text-[10px] text-red-400 bg-red-500/10 rounded p-1.5">
                Sin fondos en sub-cuenta. Transfiere USDT desde tu cuenta principal en grvt.io
              </p>
            )}
            {livePrice && (balance === null || balance > 0) && !isRunning && (() => {
              // Modo recomendado según el sesgo detectado
              const recommendedMode: GridConfig["strategyMode"] =
                detectedBias === "BULLISH" ? "LONG_GRID" :
                detectedBias === "BEARISH" ? "SHORT_GRID" :
                "AUTO_GRID";

              // Presets de rango: [lowerPct, upperPct, slPct, tpPct, grids, leverage]
              // Para SHORT_GRID invertimos la asimetría del SL/TP
              const isShort = recommendedMode === "SHORT_GRID";
              const PRESETS = [
                {
                  label: "Intraday (±3%)",
                  badge: "Max volumen",
                  desc: "~10 trades/día, 96% cobertura",
                  lowerPct: 0.97, upperPct: 1.03,
                  slPct: isShort ? 1.04 : 0.96,
                  tpPct: isShort ? 0.96 : 1.04,
                  grids: "5", leverage: "20",
                  tip: isShort
                    ? "SHORT Grid Intraday (20x): SL en +4% ($SL_PRICE) para salir si el precio sube fuerte. TP en -4% ($TP_PRICE) para capitalizar la caída."
                    : "LONG Grid Intraday (20x): SL en -4% ($SL_PRICE) para salir antes de liquidar. TP en +4% ($TP_PRICE) para capitalizar rupturas.",
                },
                {
                  label: "Scalping (±1.5%)",
                  badge: "Rápido",
                  desc: "Trades frecuentes, rango estrecho",
                  lowerPct: 0.985, upperPct: 1.015,
                  slPct: isShort ? 1.02 : 0.98,
                  tpPct: isShort ? 0.98 : 1.02,
                  grids: "4", leverage: "20",
                  tip: isShort
                    ? "SHORT Scalping: rango ±1.5%, SL en +2% ($SL_PRICE), TP en -2% ($TP_PRICE). Ideal para caídas rápidas."
                    : "LONG Scalping: rango ±1.5%, SL en -2% ($SL_PRICE), TP en +2% ($TP_PRICE). Ideal para rebotes cortos.",
                },
                {
                  label: "Swing (±5%)",
                  badge: "Mayor profit",
                  desc: "Menos trades, mayor ganancia/ciclo",
                  lowerPct: 0.95, upperPct: 1.05,
                  slPct: isShort ? 1.075 : 0.925,
                  tpPct: isShort ? 0.925 : 1.075,
                  grids: "4", leverage: "10",
                  tip: isShort
                    ? "SHORT Swing (10x): SL amplio en +7.5% ($SL_PRICE), TP en -7.5% ($TP_PRICE) para capturar movimientos bajistas de fondo."
                    : "LONG Swing (10x): SL al -7.5% ($SL_PRICE), TP en +7.5% ($TP_PRICE) para aguantar alta volatilidad.",
                },
              ];

              return (
                <div className="space-y-1.5 mt-1">
                  {/* Banner de sesgo detectado */}
                  {detectedBias && (
                    <div className={`flex items-center justify-between text-[10px] px-2 py-1 rounded border ${
                      detectedBias === "BULLISH"
                        ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
                        : detectedBias === "BEARISH"
                          ? "bg-red-500/10 border-red-500/20 text-red-400"
                          : "bg-zinc-700/50 border-zinc-600/50 text-zinc-400"
                    }`}>
                      <span>
                        Mercado detectado: <strong>{detectedBias === "BULLISH" ? "ALCISTA" : detectedBias === "BEARISH" ? "BAJISTA" : "NEUTRAL"}</strong>
                      </span>
                      <span className="font-mono font-semibold">
                        → {recommendedMode.replace(/_/g, " ")}
                      </span>
                    </div>
                  )}

                  {/* Preset especial: Dynamic Grid */}
                  <button
                    type="button"
                    className={`w-full py-2 px-3 rounded border text-left text-xs transition-all ${
                      form.autoRange && form.macroRsiExit
                        ? "bg-violet-600/30 border-violet-400 text-violet-200 ring-1 ring-violet-400/50"
                        : "bg-violet-500/10 border-violet-500/30 text-violet-300 hover:bg-violet-500/20"
                    }`}
                    onClick={() => {
                      setSelectedPresetIdx(null);
                      setForm((f) => ({
                        ...f,
                        strategyMode: "AUTO_GRID",
                        autoRange: true,
                        atrStepMult: "0.5",
                        marginGuardPct: "15",
                        macroRsiExit: true,
                        enableTrailingStop: true,
                        trendFilterEnabled: true,
                        autoReposition: true,
                        leverage: "20",
                        stopLoss: "",
                        takeProfit: "",
                      }));
                      setStrategyTip("Dynamic Grid: rango y grids se calculan automáticamente desde el ATR. El filtro 4H bloquea compras en tendencia bajista. La grilla se reduce al 50% si el RSI diario supera 80.");
                    }}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold">Dynamic Grid (ATR)</span>
                      <span className="text-[9px] px-1.5 py-0.5 rounded border border-violet-400/50 text-violet-300 bg-violet-500/10 font-mono">
                        AUTO_GRID ✦
                      </span>
                    </div>
                    <span className="text-[10px] text-violet-400/80">
                      Espaciado ATR·0.5 · Filtro 4H EMA200 · Salida RSI diario &gt;80
                    </span>
                    <br />
                    <span className="text-[10px] text-violet-500/70">
                      Rango automático · Margin guard 15% · Trailing stop activo
                    </span>
                  </button>

                  <p className="text-[10px] text-zinc-500 font-medium uppercase tracking-wide">
                    Configuraciones sugeridas
                  </p>

                  {PRESETS.map((s, i) => {
                    const isSelected = selectedPresetIdx === i;
                    const isDefault = i === 0 && selectedPresetIdx === null; // Intraday destacada por defecto
                    const isBearish = detectedBias === "BEARISH";
                    const slVal = isShort ? Math.ceil(livePrice * s.slPct) : Math.floor(livePrice * s.slPct);
                    const tpVal = isShort ? Math.floor(livePrice * s.tpPct) : Math.ceil(livePrice * s.tpPct);

                    // Estilo del botón:
                    // - Seleccionado: borde sólido + fondo intenso
                    // - Default (Intraday sin selección): borde tenue + fondo suave
                    // - No seleccionado: gris neutro
                    let btnClass: string;
                    if (isSelected) {
                      btnClass = isBearish
                        ? "bg-red-600/30 border-red-400 text-red-200 ring-1 ring-red-400/50"
                        : "bg-emerald-600/30 border-emerald-400 text-emerald-200 ring-1 ring-emerald-400/50";
                    } else if (isDefault) {
                      btnClass = isBearish
                        ? "bg-red-600/20 border-red-500/40 text-red-300 hover:bg-red-600/30"
                        : "bg-emerald-600/20 border-emerald-500/40 text-emerald-400 hover:bg-emerald-600/30";
                    } else {
                      btnClass = "bg-zinc-800/50 border-zinc-700/50 text-zinc-400 hover:bg-zinc-700/50 hover:border-zinc-600";
                    }

                    // Badge del modo
                    let badgeClass: string;
                    if (isSelected) {
                      badgeClass = isBearish
                        ? "border-red-400 text-red-300 bg-red-500/20"
                        : "border-emerald-400 text-emerald-300 bg-emerald-500/20";
                    } else if (isDefault) {
                      badgeClass = isBearish
                        ? "border-red-500/40 text-red-400 bg-red-500/10"
                        : "border-emerald-500/40 text-emerald-400 bg-emerald-500/10";
                    } else {
                      badgeClass = "border-zinc-600/40 text-zinc-500 bg-zinc-800/30";
                    }

                    return (
                      <button
                        key={s.label}
                        type="button"
                        className={`w-full py-1.5 px-3 rounded border text-left text-xs transition-all ${btnClass}`}
                        onClick={() => {
                          setSelectedPresetIdx(i);
                          setForm((f) => ({
                            ...f,
                            strategyMode: recommendedMode,
                            lowerPrice: String(Math.floor(livePrice * s.lowerPct)),
                            upperPrice: String(Math.ceil(livePrice * s.upperPct)),
                            gridCount: s.grids,
                            leverage: s.leverage,
                            stopLoss: String(slVal),
                            takeProfit: String(tpVal),
                          }));
                          setStrategyTip(
                            s.tip
                              .replace("$SL_PRICE", slVal.toString())
                              .replace("$TP_PRICE", tpVal.toString())
                          );
                        }}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-semibold">{s.label}</span>
                          <span className={`text-[9px] px-1.5 py-0.5 rounded border font-mono ${badgeClass}`}>
                            {recommendedMode.replace(/_/g, " ")}
                            {(isSelected || isDefault) && " ★"}
                          </span>
                        </div>
                        <span className={`text-[10px] ${isSelected ? (isBearish ? "text-red-400/80" : "text-emerald-400/80") : "text-zinc-500"}`}>
                          {s.badge} · {s.desc}
                        </span>
                        <br />
                        <span className={`text-[10px] ${isSelected ? "text-zinc-400" : "text-zinc-600"}`}>
                          ${Math.floor(livePrice * s.lowerPct).toLocaleString()}–${Math.ceil(livePrice * s.upperPct).toLocaleString()} · {s.grids} grids · {s.leverage}x
                        </span>
                      </button>
                    );
                  })}
                </div>
              );
            })()}
          </div>

          {["NEUTRAL_GRID", "LONG_GRID", "SHORT_GRID", "AUTO_GRID"].includes(form.strategyMode) && (
            <>
              <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-zinc-500 mb-1 block">
                Precio Inferior ($)
              </label>
              <Input
                type="number"
                value={form.lowerPrice}
                onChange={set("lowerPrice")}
                placeholder={livePrice ? String(Math.floor(livePrice * 0.95)) : ""}
                className="bg-zinc-800 border-zinc-600 text-zinc-200 text-xs"
                disabled={isRunning}
              />
            </div>
            <div>
              <label className="text-xs text-zinc-500 mb-1 block">
                Precio Superior ($)
              </label>
              <Input
                type="number"
                value={form.upperPrice}
                onChange={set("upperPrice")}
                placeholder={livePrice ? String(Math.ceil(livePrice * 1.05)) : ""}
                className="bg-zinc-800 border-zinc-600 text-zinc-200 text-xs"
                disabled={isRunning}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 mt-2">
            <div>
              <label className="text-xs text-zinc-500 mb-1 block">
                Stop Loss ($) <span className="text-zinc-700">(opcional)</span>
              </label>
              <Input
                type="number"
                value={form.stopLoss}
                onChange={set("stopLoss")}
                placeholder="0.00"
                className="bg-zinc-800 border-zinc-600 text-zinc-200 text-xs"
                disabled={isRunning}
              />
            </div>
            <div>
              <label className="text-xs text-zinc-500 mb-1 block">
                Take Profit ($) <span className="text-zinc-700">(opcional)</span>
              </label>
              <Input
                type="number"
                value={form.takeProfit}
                onChange={set("takeProfit")}
                placeholder="0.00"
                className="bg-zinc-800 border-zinc-600 text-zinc-200 text-xs"
                disabled={isRunning}
              />
            </div>
          </div>
          {strategyTip && (
            <div className="mt-2 text-[10px] text-zinc-400 bg-zinc-800/50 p-2 rounded border border-zinc-700/50">
              <span className="text-emerald-400 font-semibold mr-1">Tesis:</span>
              {strategyTip}
            </div>
          )}

          {/* Range validation warning */}
          {livePrice && parseFloat(form.lowerPrice) > 0 && parseFloat(form.upperPrice) > 0 && (
            livePrice < parseFloat(form.lowerPrice) || livePrice > parseFloat(form.upperPrice)
          ) && (
            <Alert className="border-amber-500/30 bg-amber-500/10 p-2">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
              <AlertDescription className="text-amber-300 text-[11px] ml-2">
                El precio actual (${livePrice.toFixed(2)}) está fuera del rango configurado.
                El precio debe estar entre Inferior y Superior para que el bot funcione.
                <button
                  type="button"
                  className="block mt-1 text-amber-400 underline hover:text-amber-300"
                  onClick={() => {
                    setForm((f) => ({
                      ...f,
                      lowerPrice: String(Math.floor(livePrice * 0.97)),
                      upperPrice: String(Math.ceil(livePrice * 1.03)),
                    }));
                  }}
                >
                  Usar rango sugerido (±3%)
                </button>
              </AlertDescription>
            </Alert>
          )}

              <div className="grid grid-cols-3 gap-2 mt-2">
                <div>
                  <label className="text-xs text-zinc-500 mb-1 block">
                    N° de Grids
                  </label>
                  <Input
                    type="number"
                    min="2"
                    max="100"
                    value={form.gridCount}
                    onChange={set("gridCount")}
                    className="bg-zinc-800 border-zinc-600 text-zinc-200 text-xs"
                    disabled={isRunning}
                  />
                </div>
              </div>
            </>
          )}

          {form.strategyMode !== "NEUTRAL_GRID" && (
            <div className="grid grid-cols-2 gap-2 mt-2">
              <div>
                <label className="text-xs text-zinc-500 mb-1 block">
                  Riesgo por Trade (%)
                </label>
                <Input
                  type="number"
                  value={form.riskPerTrade}
                  onChange={set("riskPerTrade")}
                  className="bg-zinc-800 border-zinc-600 text-zinc-200 text-xs"
                  disabled={isRunning}
                />
              </div>
              <div>
                <label className="text-xs text-zinc-500 mb-1 block">
                  Multiplicador ATR
                </label>
                <Input
                  type="number"
                  value={form.atrMultiplier}
                  onChange={set("atrMultiplier")}
                  className="bg-zinc-800 border-zinc-600 text-zinc-200 text-xs"
                  disabled={isRunning}
                />
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-zinc-500 mb-1 block">
                Inversión (USDC)
              </label>
              <Input
                type="number"
                value={form.totalInvestment}
                onChange={set("totalInvestment")}
                className="bg-zinc-800 border-zinc-600 text-zinc-200 text-xs"
                disabled={isRunning}
              />
            </div>
            <div>
              <label className="text-xs text-zinc-500 mb-1 block">
                Leverage
              </label>
              <Select
                value={form.leverage}
                onValueChange={(v) => setForm((f) => ({ ...f, leverage: v ?? f.leverage }))}
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

          {/* Controles de Protección */}
          <Card className="bg-zinc-800/50 border-zinc-700/50">
            <CardContent className="pt-3 pb-3 space-y-2">
              <p className="text-[10px] text-zinc-500 font-medium uppercase tracking-wide">Protecciones</p>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-zinc-500 mb-1 block">
                    Max Drawdown (%)
                  </label>
                  <Input
                    type="number"
                    value={form.maxDrawdownPct}
                    onChange={set("maxDrawdownPct")}
                    className="bg-zinc-800 border-zinc-600 text-zinc-200 text-xs"
                    disabled={isRunning}
                  />
                </div>
                <div>
                  <label className="text-xs text-zinc-500 mb-1 block">
                    Trailing ATR Mult
                  </label>
                  <Input
                    type="number"
                    value={form.trailingAtrMult}
                    onChange={set("trailingAtrMult")}
                    className="bg-zinc-800 border-zinc-600 text-zinc-200 text-xs"
                    disabled={isRunning}
                  />
                </div>
              </div>
              <div className="flex gap-4 text-xs flex-wrap">
                <label className="flex items-center gap-1.5 text-zinc-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.enableTrailingStop}
                    onChange={(e) => setForm((f) => ({ ...f, enableTrailingStop: e.target.checked }))}
                    disabled={isRunning}
                    className="rounded border-zinc-600"
                  />
                  Trailing Stop
                </label>
                <label className="flex items-center gap-1.5 text-zinc-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.autoReposition}
                    onChange={(e) => setForm((f) => ({ ...f, autoReposition: e.target.checked }))}
                    disabled={isRunning}
                    className="rounded border-zinc-600"
                  />
                  Auto-Reposicionar
                </label>
                <label className="flex items-center gap-1.5 text-zinc-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.trendFilterEnabled}
                    onChange={(e) => setForm((f) => ({ ...f, trendFilterEnabled: e.target.checked }))}
                    disabled={isRunning}
                    className="rounded border-zinc-600"
                  />
                  Filtro Tendencia
                </label>
              </div>

              {/* ── Módulos Dinámicos Avanzados ────────────────────────────── */}
              <div className="pt-1 border-t border-zinc-700/50">
                <p className="text-[10px] text-zinc-500 font-medium uppercase tracking-wide mb-2">
                  Módulos Dinámicos
                </p>
                <div className="flex gap-4 text-xs flex-wrap mb-2">
                  <label className="flex items-center gap-1.5 text-zinc-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.autoRange}
                      onChange={(e) => setForm((f) => ({ ...f, autoRange: e.target.checked }))}
                      disabled={isRunning}
                      className="rounded border-zinc-600"
                    />
                    <span>
                      Rango Auto-ATR{" "}
                      <span className="text-zinc-600 text-[10px]">(calcula grids desde ATR)</span>
                    </span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.macroRsiExit}
                      onChange={(e) => setForm((f) => ({ ...f, macroRsiExit: e.target.checked }))}
                      disabled={isRunning}
                      className="rounded border-zinc-600"
                    />
                    <span className={form.macroRsiExit ? "text-violet-400" : "text-zinc-400"}>
                      Salida Macro RSI&gt;80{" "}
                      <span className="text-zinc-600 text-[10px]">(cierra 50% + break-even)</span>
                    </span>
                  </label>
                </div>
                {form.autoRange && (
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-xs text-zinc-500 mb-1 block">
                        ATR Step Mult{" "}
                        <span className="text-zinc-700">(espaciado entre niveles)</span>
                      </label>
                      <Input
                        type="number"
                        step="0.1"
                        min="0.1"
                        max="2"
                        value={form.atrStepMult}
                        onChange={set("atrStepMult")}
                        className="bg-zinc-800 border-zinc-600 text-zinc-200 text-xs"
                        disabled={isRunning}
                      />
                      <p className="text-[10px] text-zinc-600 mt-0.5">
                        dist. = ATR14 × {form.atrStepMult || "0.5"}
                      </p>
                    </div>
                    <div>
                      <label className="text-xs text-zinc-500 mb-1 block">
                        Margin Guard (%){" "}
                        <span className="text-zinc-700">(pausa compras)</span>
                      </label>
                      <Input
                        type="number"
                        step="1"
                        min="5"
                        max="50"
                        value={form.marginGuardPct}
                        onChange={set("marginGuardPct")}
                        className="bg-zinc-800 border-zinc-600 text-zinc-200 text-xs"
                        disabled={isRunning}
                      />
                      <p className="text-[10px] text-zinc-600 mt-0.5">
                        bloquea BUYs si margin &gt; {form.marginGuardPct || "15"}%
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Preview de la estrategia */}
          {["NEUTRAL_GRID", "LONG_GRID", "SHORT_GRID", "AUTO_GRID"].includes(form.strategyMode) && !isNaN(gridStep) && gridStep > 0 && (() => {
            const lev = parseInt(form.leverage) || 1;
            const inv = parseFloat(form.totalInvestment) || 0;
            const grids = parseInt(form.gridCount) || 2;
            const effectiveCapital = inv * lev;
            const effectivePerGrid = effectiveCapital / grids;
            // Estimate order size at live price
            const estSize = livePrice ? effectivePerGrid / livePrice : 0;
            const sizeTooSmall = estSize > 0 && estSize < minSize;
            const maxGrids = livePrice
              ? calculateMaxGrids(inv, grids, livePrice, minSize, lev)
              : grids;

            return (
              <div className="rounded-lg bg-zinc-800/50 p-3 space-y-1 border border-zinc-700/50">
                <GridPreviewRow
                  label="Capital efectivo"
                  value={`$${effectiveCapital.toFixed(2)} (${lev}x)`}
                  highlight
                />
                <GridPreviewRow
                  label="Espaciado por Grid"
                  value={`$${gridStep.toFixed(2)}`}
                />
                <GridPreviewRow
                  label="Profit / Grid (est.)"
                  value={`≈ ${profitPerGrid.toFixed(3)}%`}
                  highlight
                />
                <GridPreviewRow
                  label="USDC por Grid"
                  value={`$${effectivePerGrid.toFixed(2)}`}
                />
                {livePrice ? (
                  <GridPreviewRow
                    label="Size por orden (est.)"
                    value={`${estSize.toFixed(4)} (min: ${minSize})`}
                  />
                ) : null}
                <GridPreviewRow
                  label="Niveles totales"
                  value={String(grids + 1)}
                />
                {sizeTooSmall && (
                  <div className="mt-2 p-2 rounded bg-amber-500/10 border border-amber-500/20">
                    <p className="text-[11px] text-amber-300">
                      El size por orden ({estSize.toFixed(4)}) es menor al mínimo ({minSize}).
                      {maxGrids < grids ? (
                        <>
                          {" "}Se reducirá automáticamente a {maxGrids} grids al iniciar.
                          <button
                            type="button"
                            className="block mt-1 text-amber-400 underline hover:text-amber-300"
                            onClick={() => setForm((f) => ({ ...f, gridCount: String(maxGrids) }))}
                          >
                            Ajustar a {maxGrids} grids ahora
                          </button>
                        </>
                      ) : (
                        <> Aumenta el leverage o la inversión.</>
                      )}
                    </p>
                  </div>
                )}
              </div>
            );
          })()}
        </CardContent>
      </Card>

      {/* Error del bot */}
      {error && (
        <Alert className="border-red-500/30 bg-red-500/10">
          <AlertTriangle className="h-4 w-4 text-red-400" />
          <AlertDescription className="text-red-300 text-xs">
            {error}
          </AlertDescription>
        </Alert>
      )}

      {/* ── Controles ─────────────────────────────────────────────────────── */}
      {!isRunning ? (
        <Button
          onClick={handleStart}
          disabled={isConnecting || !creds.ok || creds.loading}
          className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-semibold disabled:opacity-50"
        >
          {isConnecting ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Conectando...
            </>
          ) : (
            <>
              <Play className="h-4 w-4 mr-2" />
              Start Bot
            </>
          )}
        </Button>
      ) : (
        <Button
          onClick={onStop}
          variant="destructive"
          className="w-full bg-red-600 hover:bg-red-500 font-semibold"
        >
          <Square className="h-4 w-4 mr-2" />
          Stop Bot &amp; Cancelar Órdenes
        </Button>
      )}

      {/* Nota de .env cuando no hay credenciales */}
      {!creds.loading && !creds.ok && (
        <p className="text-[10px] text-zinc-600 text-center">
          El bot no puede iniciar sin credenciales válidas en .env
        </p>
      )}
    </div>
  );
}

// ─── Sub-componentes ──────────────────────────────────────────────────────────

function MaskedField({
  label,
  value,
  fullWidth = false,
}: {
  label: string;
  value: string;
  fullWidth?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-zinc-500 shrink-0">{label}</span>
      <code
        className={`text-xs font-mono text-zinc-300 bg-zinc-800 px-2 py-0.5 rounded border border-zinc-700 truncate ${
          fullWidth ? "max-w-full" : "max-w-[140px]"
        }`}
        title="Valor enmascarado — solo para confirmación"
      >
        {value}
      </code>
    </div>
  );
}

function GridPreviewRow({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="flex justify-between text-xs">
      <span className="text-zinc-500">{label}</span>
      <span className={`font-mono ${highlight ? "text-emerald-400" : "text-zinc-300"}`}>
        {value}
      </span>
    </div>
  );
}
