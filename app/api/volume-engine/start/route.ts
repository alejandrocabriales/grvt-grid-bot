import { NextRequest, NextResponse } from "next/server";
import { startVolumeEngine, isVolumeEngineRunning } from "@/lib/server/volume-process";
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
      return NextResponse.json({ ok: false, error: "Volume engine already running" }, { status: 409 });
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
