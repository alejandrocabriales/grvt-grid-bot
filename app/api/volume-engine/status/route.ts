import { NextResponse } from "next/server";
import { BotDatabase } from "@/scripts/db";
import { isVolumeEngineRunning } from "@/lib/server/volume-process";
import path from "path";

function openDb(): BotDatabase {
  const dbPath = process.env.VOL_DB_PATH ?? path.join(process.cwd(), "volume-state.sqlite");
  return new BotDatabase(dbPath);
}

export async function GET() {
  try {
    const db = openDb();

    const botStatus    = db.getConfig<string>("bot_status");
    const config       = db.getConfig<unknown>("volume_config");
    const totalVolume  = db.getMetric<number>("total_volume", 0);
    const totalTrades  = db.getMetric<number>("total_trades", 0);
    const totalPnL     = db.getMetric<number>("total_pnl", 0);
    const spreadCycles = db.getMetric<number>("spread_cycles", 0);
    const scalpTrades  = db.getMetric<number>("scalp_trades", 0);
    const sessionPnL   = db.getMetric<number>("session_pnl", 0);
    const maxEquity    = db.getMetric<number>("max_equity", 0);
    const startTime    = db.getConfig<number>("start_time") ?? 0;
    const logs         = db.getLogsRecent(30);

    const processRunning = isVolumeEngineRunning();
    if (!processRunning && botStatus === "running") {
      db.setConfig("bot_status", "stopped");
    }
    db.close();

    return NextResponse.json({
      ok: true,
      isRunning: processRunning,
      config,
      totalVolume,
      totalTrades,
      totalPnL,
      spreadCycles,
      scalpTrades,
      sessionPnL,
      maxEquity,
      startTime,
      logs,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
