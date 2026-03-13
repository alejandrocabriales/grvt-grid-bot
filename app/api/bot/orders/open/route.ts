/**
 * GET /api/bot/orders/open?instrument=ETH_USDT_Perp
 * Retorna las órdenes abiertas del instrumento.
 */

import { NextRequest, NextResponse } from "next/server";
import { readEnvCredentials } from "@/lib/server/env";
import { getStoredSession, saveSession } from "@/lib/server/session-store";
import { getOpenOrders, loginWithApiKey } from "@/lib/grvt-api";

export async function GET(req: NextRequest) {
  try {
    const instrument = req.nextUrl.searchParams.get("instrument");
    if (!instrument) {
      return NextResponse.json(
        { ok: false, error: "instrument requerido" },
        { status: 400 }
      );
    }

    const { subAccountId, apiKey } = readEnvCredentials();

    let session = getStoredSession();
    if (!session) {
      session = await loginWithApiKey(apiKey);
      saveSession(session);
    }
    const orders = await getOpenOrders(session, subAccountId, instrument);

    return NextResponse.json({ ok: true, orders });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
