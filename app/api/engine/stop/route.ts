import { NextResponse } from "next/server";
import { stopEngine } from "@/lib/server/engine-process";

export async function POST() {
  try {
    stopEngine();
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
