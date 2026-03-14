import { NextRequest, NextResponse } from "next/server";
import { getBinanceKlines } from "@/lib/grvt-api";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const instrument = searchParams.get("instrument");
    const interval = searchParams.get("interval") || "5m";
    const limit = searchParams.get("limit") || "200";

    if (!instrument) {
      return NextResponse.json({ ok: false, error: "Missing instrument" }, { status: 400 });
    }

    const klines = await getBinanceKlines(instrument, interval, parseInt(limit));
    return NextResponse.json({ ok: true, klines });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error.message || "Failed to fetch klines" },
      { status: 500 }
    );
  }
}
