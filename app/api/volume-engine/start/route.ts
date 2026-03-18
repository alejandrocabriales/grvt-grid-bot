import { NextRequest, NextResponse } from "next/server";
import { startVolumeEngine, stopVolumeEngine, isVolumeEngineRunning } from "@/lib/server/volume-process";
import type { VolumeConfig } from "@/lib/volume-optimizer";
import fs from "fs";
import path from "path";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const config: VolumeConfig = body.config;

    if (!config) {
      return NextResponse.json({ ok: false, error: "Missing config" }, { status: 400 });
    }

    if (isVolumeEngineRunning()) {
      // Auto-stop existing engine so user can switch pairs without manual stop
      stopVolumeEngine();
      // Brief wait for process to release resources
      await new Promise((r) => setTimeout(r, 1_500));
    }

    const dbDir = process.env.VOL_DB_PATH
      ? path.dirname(process.env.VOL_DB_PATH)
      : (process.env.TMPDIR ?? "/tmp");
    const configPath = path.join(dbDir, "volume-config.json");
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");

    const { pid } = startVolumeEngine(configPath);
    return NextResponse.json({ ok: true, pid });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
