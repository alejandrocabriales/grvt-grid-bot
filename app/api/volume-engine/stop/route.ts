import { NextResponse } from "next/server";
import { stopVolumeEngine } from "@/lib/server/volume-process";

export async function POST() {
  try {
    stopVolumeEngine();
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
