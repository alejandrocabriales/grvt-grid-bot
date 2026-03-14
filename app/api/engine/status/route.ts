import { NextResponse } from "next/server";
import { BotDatabase } from "@/scripts/db";
import { isEngineRunning } from "@/lib/server/engine-process";
import type { GridConfig } from "@/lib/grid-bot";
import path from "path";

function openDb(): BotDatabase {
  const dbPath = process.env.BOT_DB_PATH ?? path.join(process.cwd(), "bot-state.sqlite");
  return new BotDatabase(dbPath);
}

export async function GET() {
  try {
    const db = openDb();

    const botStatus        = db.getConfig<string>("bot_status");
    const config           = db.getConfig<GridConfig>("grid_config");
    const totalPnL         = db.getMetric<number>("total_pnl", 0);
    const filledOrders     = db.getMetric<number>("filled_orders", 0);
    const maxEquity        = db.getMetric<number>("max_equity", 0);
    const startTime        = db.getConfig<number>("start_time") ?? 0;
    const trailingStopPrice = db.getMetric<number | null>("trailing_stop_price", null);
    const peakPrice        = db.getMetric<number | null>("peak_price", null);
    const logs             = db.getLogsRecent(50);
    const pair             = config?.pair ?? "";
    const orders           = pair ? db.getOrderHistory(pair, 20) : [];

    // El proceso puede haber muerto pero la DB dice "running" → reconciliar
    const processRunning = isEngineRunning();
    // Si el proceso no está activo pero la DB dice "running" (estado stale tras redeploy),
    // limpiar el flag para que la UI no quede bloqueada
    if (!processRunning && botStatus === "running") {
      db.setConfig("bot_status", "stopped");
    }
    db.close();

    const isRunning = processRunning;

    return NextResponse.json({
      ok: true,
      isRunning,
      config,
      totalPnL,
      filledOrders,
      maxEquity,
      startTime,
      trailingStopPrice,
      peakPrice,
      logs,
      orders,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
