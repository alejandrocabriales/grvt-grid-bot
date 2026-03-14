import { NextResponse } from "next/server";
import { stopEngine } from "@/lib/server/engine-process";
import { proxyEngine } from "@/lib/server/engine-proxy";

export async function POST() {
  try {
    const proxied = await proxyEngine("stop", "POST");
    if (proxied !== null) return NextResponse.json(proxied);

    stopEngine();
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
