import { NextRequest, NextResponse } from "next/server";
import { startEngine, isEngineRunning } from "@/lib/server/engine-process";
import type { GridConfig } from "@/lib/grid-bot";
import fs from "fs";
import path from "path";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const config: GridConfig = body.config;
    if (!config) {
      return NextResponse.json({ ok: false, error: "Missing config" }, { status: 400 });
    }

    if (isEngineRunning()) {
      return NextResponse.json({ ok: false, error: "Engine already running" }, { status: 409 });
    }

    // Guardar config en disco para que run-bot.ts la cargue
    // Usar /tmp como fallback ya que process.cwd() puede ser read-only en entornos serverless
    const dbDir = process.env.BOT_DB_PATH
      ? path.dirname(process.env.BOT_DB_PATH)
      : (process.env.TMPDIR ?? "/tmp");
    const configPath = path.join(dbDir, "bot-config.json");
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");

    const { pid } = startEngine(configPath);
    return NextResponse.json({ ok: true, pid });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
