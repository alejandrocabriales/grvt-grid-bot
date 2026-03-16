"use client";

import { GridBotConfig } from "@/components/GridBotConfig";
import { QuickTradePanel } from "@/components/QuickTradePanel";
import { Dashboard } from "@/components/Dashboard";
import { ActivityLog } from "@/components/ActivityLog";
import { useGridBot } from "@/hooks/useGridBot";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Bot, LayoutDashboard, Settings, Terminal } from "lucide-react";

export default function Home() {
  const { state, currentPrice, isConnecting, error, startBot, stopBot } =
    useGridBot();

  const isRunning = state?.isRunning ?? false;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Header */}
      <header className="border-b border-zinc-800 bg-zinc-900/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
              <Bot className="h-5 w-5 text-emerald-400" />
            </div>
            <div>
              <h1 className="font-bold text-white leading-none">
                GRVT Grid Bot
              </h1>
              <p className="text-xs text-zinc-500 mt-0.5">
                Automated Volume Generation
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {state && (
              <>
                <div className="text-right hidden sm:block">
                  <p className="text-xs text-zinc-500">Current Price</p>
                  <p className="text-sm font-mono font-bold text-white">
                    ${currentPrice > 0 ? currentPrice.toFixed(2) : "—"}
                  </p>
                </div>
                <div className="text-right hidden sm:block">
                  <p className="text-xs text-zinc-500">PnL</p>
                  <p
                    className={`text-sm font-mono font-bold ${
                      state.totalPnL >= 0 ? "text-emerald-400" : "text-red-400"
                    }`}
                  >
                    {state.totalPnL >= 0 ? "+" : ""}${state.totalPnL.toFixed(4)}
                  </p>
                </div>
              </>
            )}
            <Badge
              variant="outline"
              className={
                isRunning
                  ? "border-emerald-500 text-emerald-400 animate-pulse"
                  : "border-zinc-600 text-zinc-500"
              }
            >
              <span
                className={`w-1.5 h-1.5 rounded-full mr-1.5 ${
                  isRunning ? "bg-emerald-400" : "bg-zinc-500"
                }`}
              />
              {isRunning ? "Running" : "Idle"}
            </Badge>
          </div>
        </div>
      </header>

      {/* Main Layout */}
      <main className="max-w-7xl mx-auto px-4 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-6">
          {/* Left: Config Panel */}
          <aside className="space-y-4">
            <GridBotConfig
              isRunning={isRunning}
              isConnecting={isConnecting}
              error={error}
              onStart={startBot}
              onStop={stopBot}
            />
            <QuickTradePanel />
          </aside>

          {/* Right: Dashboard & Logs */}
          <div>
            {state ? (
              <Tabs defaultValue="dashboard">
                <TabsList className="bg-zinc-900 border border-zinc-700 mb-4">
                  <TabsTrigger
                    value="dashboard"
                    className="data-[state=active]:bg-zinc-700 text-xs gap-1.5"
                  >
                    <LayoutDashboard className="h-3.5 w-3.5" />
                    Dashboard
                  </TabsTrigger>
                  <TabsTrigger
                    value="logs"
                    className="data-[state=active]:bg-zinc-700 text-xs gap-1.5"
                  >
                    <Terminal className="h-3.5 w-3.5" />
                    Logs
                    {state.logs.filter((l) => l.level === "error").length > 0 && (
                      <Badge className="ml-1 text-[10px] bg-red-500/20 text-red-400 border-red-500/30 px-1 py-0">
                        {state.logs.filter((l) => l.level === "error").length}
                      </Badge>
                    )}
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="dashboard">
                  <Dashboard state={state} currentPrice={currentPrice} />
                </TabsContent>

                <TabsContent value="logs">
                  <ActivityLog logs={state.logs} />
                </TabsContent>
              </Tabs>
            ) : (
              <div className="flex flex-col items-center justify-center h-full min-h-[400px] text-center">
                <div className="p-4 rounded-2xl bg-zinc-900 border border-zinc-700 mb-4">
                  <Settings className="h-12 w-12 text-zinc-600" />
                </div>
                <h2 className="text-lg font-semibold text-zinc-400 mb-2">
                  Configure your Grid Bot
                </h2>
                <p className="text-sm text-zinc-600 max-w-xs">
                  Set up your API credentials y grid parameters on the left,
                  then click Start Bot to begin automated trading.
                </p>
                <div className="mt-6 grid grid-cols-3 gap-4 text-center">
                  {[
                    { icon: "📡", label: "Real-time WebSocket" },
                    { icon: "🔐", label: "EIP-712 Signing" },
                    { icon: "⚡", label: "Auto Counter Orders" },
                  ].map((f) => (
                    <div
                      key={f.label}
                      className="p-3 rounded-xl bg-zinc-900 border border-zinc-800"
                    >
                      <div className="text-2xl mb-1">{f.icon}</div>
                      <div className="text-xs text-zinc-500">{f.label}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-800 mt-12 py-4 text-center">
        <p className="text-xs text-zinc-600">
          GRVT Grid Bot · Uso privado · No es asesoramiento financiero
        </p>
      </footer>
    </div>
  );
}
