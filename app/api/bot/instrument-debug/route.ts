/**
 * GET /api/bot/instrument-debug?instrument=XRP_USDT_Perp
 * Llama al endpoint /full/v1/instrument de GRVT y devuelve la respuesta cruda completa.
 * Útil para diagnosticar qué campos devuelve GRVT para cada instrumento.
 */

import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const instrument = req.nextUrl.searchParams.get("instrument") ?? "XRP_USDT_Perp";
  const useTestnet = process.env.GRVT_USE_TESTNET === "true";
  const base = useTestnet
    ? "https://market-data.testnet.grvt.io"
    : "https://market-data.grvt.io";

  const results: Record<string, unknown> = {};

  // 1. /full/v1/instrument
  try {
    const r = await fetch(`${base}/full/v1/instrument`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instrument }),
    });
    results["instrument"] = { status: r.status, body: await r.json().catch(() => r.text()) };
  } catch (e) {
    results["instrument"] = { error: String(e) };
  }

  // 2. /full/v1/mini (ticker price — sabemos que esto funciona)
  try {
    const r = await fetch(`${base}/full/v1/mini`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instrument }),
    });
    results["mini"] = { status: r.status, body: await r.json().catch(() => r.text()) };
  } catch (e) {
    results["mini"] = { error: String(e) };
  }

  // 3. /full/v1/ticker (otro endpoint posible)
  try {
    const r = await fetch(`${base}/full/v1/ticker`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instrument }),
    });
    results["ticker"] = { status: r.status, body: await r.json().catch(() => r.text()) };
  } catch (e) {
    results["ticker"] = { error: String(e) };
  }

  // 4. /full/v1/all_instruments — lista todos los instrumentos disponibles
  try {
    const r = await fetch(`${base}/full/v1/all_instruments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: ["PERPETUAL"], base: [], quote: [] }),
    });
    const body = await r.json().catch(() => r.text());
    // Solo filtrar los relacionados con el instrumento buscado para no devolver mucho
    if (typeof body === "object" && body !== null && "result" in body) {
      const list = (body as { result: unknown[] }).result;
      if (Array.isArray(list)) {
        const filtered = list.filter((x: unknown) =>
          typeof x === "object" && x !== null &&
          JSON.stringify(x).toLowerCase().includes(instrument.split("_")[0].toLowerCase())
        );
        results["all_instruments_match"] = { status: r.status, matched: filtered, total: list.length };
      } else {
        results["all_instruments"] = { status: r.status, body };
      }
    } else {
      results["all_instruments"] = { status: r.status, body };
    }
  } catch (e) {
    results["all_instruments"] = { error: String(e) };
  }

  return NextResponse.json({ instrument, network: useTestnet ? "testnet" : "mainnet", results });
}
