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
import { GridConfig, calculateMaxGrids } from "@/lib/grid-bot";
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
    upperPrice: "",
    lowerPrice: "",
    gridCount: "5",
    totalInvestment: "44",
    leverage: "20",
  });

  // Live price for the selected pair
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [priceLoading, setPriceLoading] = useState(false);
  const [minSize, setMinSize] = useState(0.01);
  const [balance, setBalance] = useState<number | null>(null);

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

  // Fetch live price when pair changes
  useEffect(() => {
    let cancelled = false;
    const fetchPrice = async () => {
      setPriceLoading(true);
      setLivePrice(null);
      try {
        const res = await fetch(`/api/bot/price?instrument=${form.pair}`);
        const data = await res.json();
        if (!cancelled && data.price > 0) {
          setLivePrice(data.price);
          if (data.minSize) setMinSize(parseFloat(data.minSize));
          // Auto-fill with intraday range (±3% for max volume)
          setForm((f) => {
            const needsAutoFill = !f.lowerPrice && !f.upperPrice;
            if (needsAutoFill) {
              const lower = Math.floor(data.price * 0.97);
              const upper = Math.ceil(data.price * 1.03);
              return { ...f, lowerPrice: String(lower), upperPrice: String(upper) };
            }
            return f;
          });
        }
      } catch {
        // silently fail
      } finally {
        if (!cancelled) setPriceLoading(false);
      }
    };
    fetchPrice();
    const interval = setInterval(fetchPrice, 15_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [form.pair]);

  const set = (key: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const gridStep =
    (parseFloat(form.upperPrice) - parseFloat(form.lowerPrice)) /
    parseInt(form.gridCount);

  const profitPerGrid = (gridStep / parseFloat(form.lowerPrice)) * 100;

  const handleStart = () => {
    if (!creds.ok) return;

    const config: GridConfig = {
      pair: form.pair,
      upperPrice: parseFloat(form.upperPrice),
      lowerPrice: parseFloat(form.lowerPrice),
      gridCount: parseInt(form.gridCount),
      totalInvestment: parseFloat(form.totalInvestment),
      leverage: parseInt(form.leverage) || 1,
    };

    if (config.upperPrice <= config.lowerPrice)
      return alert("El precio superior debe ser mayor al inferior");
    if (config.gridCount < 2) return alert("Se necesitan al menos 2 grids");
    if (config.totalInvestment <= 0) return alert("La inversión debe ser > 0");
    if (livePrice && (livePrice < config.lowerPrice || livePrice > config.upperPrice))
      return alert(
        `El precio actual ($${livePrice.toFixed(2)}) está fuera del rango [$${config.lowerPrice} – $${config.upperPrice}]. Ajusta el rango para que contenga el precio actual.`
      );

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

      {/* ── Parámetros de la Grilla ────────────────────────────────────────── */}
      <Card className="bg-zinc-900 border-zinc-700">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm text-zinc-300">
            Parámetros de la Grilla
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <label className="text-xs text-zinc-500 mb-1 block">
              Par de Trading
            </label>
            <Select
              value={form.pair}
              onValueChange={(v) => setForm((f) => ({ ...f, pair: v ?? f.pair, lowerPrice: "", upperPrice: "" }))}
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
            {livePrice && (balance === null || balance > 0) && !isRunning && (
              <div className="space-y-1.5 mt-1">
                <p className="text-[10px] text-zinc-500 font-medium uppercase tracking-wide">Estrategias sugeridas</p>
                {([
                  {
                    label: "Intraday (±3%) — Max volumen",
                    desc: "~10 trades/día, 96% cobertura",
                    lowerPct: 0.97, upperPct: 1.03,
                    grids: "5", leverage: "20",
                    highlight: true,
                  },
                  {
                    label: "Scalping (±1.5%) — Rápido",
                    desc: "Trades frecuentes, rango estrecho",
                    lowerPct: 0.985, upperPct: 1.015,
                    grids: "4", leverage: "20",
                    highlight: false,
                  },
                  {
                    label: "Swing (±5%) — Mayor profit",
                    desc: "Menos trades, mayor ganancia/ciclo",
                    lowerPct: 0.95, upperPct: 1.05,
                    grids: "4", leverage: "10",
                    highlight: false,
                  },
                ] as const).map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    className={`w-full py-1.5 px-3 rounded border text-left text-xs transition-colors ${
                      s.highlight
                        ? "bg-emerald-600/20 border-emerald-500/30 text-emerald-400 hover:bg-emerald-600/30"
                        : "bg-zinc-800/50 border-zinc-700/50 text-zinc-400 hover:bg-zinc-700/50"
                    }`}
                    onClick={() => {
                      const bal = balance ?? 49.5;
                      const usable = Math.floor(bal * 0.9 * 100) / 100;
                      setForm({
                        pair: form.pair,
                        lowerPrice: String(Math.floor(livePrice * s.lowerPct)),
                        upperPrice: String(Math.ceil(livePrice * s.upperPct)),
                        gridCount: s.grids,
                        totalInvestment: String(usable),
                        leverage: s.leverage,
                      });
                    }}
                  >
                    <span className="font-medium">{s.label}</span>
                    {s.highlight && <span className="ml-1 text-[9px] text-emerald-500">★ RECOMENDADA</span>}
                    <br />
                    <span className="text-[10px] text-zinc-500">
                      {s.desc} | ${Math.floor(livePrice * s.lowerPct)}-${Math.ceil(livePrice * s.upperPct)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

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

          <div className="grid grid-cols-3 gap-2">
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

          {/* Preview de la grilla */}
          {!isNaN(gridStep) && gridStep > 0 && (() => {
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
