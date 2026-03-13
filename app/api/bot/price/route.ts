/**
 * GET /api/bot/price?instrument=ETH_USDT_Perp
 * Proxy al endpoint de precio de GRVT.
 * Evita problemas de CORS al llamar directamente desde el browser.
 */

import { NextRequest, NextResponse } from "next/server";
import { getInstrumentInfo } from "@/lib/grvt-api";

export async function GET(req: NextRequest) {
  const instrument = req.nextUrl.searchParams.get("instrument");
  if (!instrument) {
    return NextResponse.json({ ok: false, error: "instrument requerido" }, { status: 400 });
  }

  const useTestnet = process.env.GRVT_USE_TESTNET === "true";
  const base = useTestnet
    ? "https://market-data.testnet.grvt.io"
    : "https://market-data.grvt.io";

  try {
    // Fetch price and instrument info in parallel
    const [miniRes, instrumentInfo] = await Promise.all([
      fetch(`${base}/full/v1/mini`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instrument }),
      }),
      getInstrumentInfo(instrument).catch(() => null),
    ]);

    let price = 0;
    const miniText = await miniRes.text();
    console.log(`[Price] /mini response (${miniRes.status}):`, miniText);

    if (miniRes.ok) {
      try {
        const data = JSON.parse(miniText);
        const result = data?.result ?? data;
        price = parseFloat(
          result?.mark_price ||
            result?.oracle_price ||
            result?.last_price ||
            "0"
        );
      } catch {
        console.error("[Price] Failed to parse mini response");
      }
    }

    return NextResponse.json({
      ok: true,
      price,
      sizeDecimals: instrumentInfo?.sizeDecimals ?? 2,
      priceDecimals: instrumentInfo?.priceDecimals ?? 2,
      tickSize: instrumentInfo?.tickSize ?? "0.01",
      minSize: instrumentInfo?.minSize ?? "0.01",
    });
  } catch {
    return NextResponse.json({ ok: false, price: 0, sizeDecimals: 2, priceDecimals: 2, minSize: "0.01" });
  }
}
