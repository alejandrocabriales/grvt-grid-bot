/**
 * POST /api/bot/orders/cancel
 * Cancela todas las órdenes abiertas del instrumento.
 * Body: { instrument }
 */

import { NextRequest, NextResponse } from "next/server";
import { readEnvCredentials } from "@/lib/server/env";
import { getStoredSession, saveSession } from "@/lib/server/session-store";
import { cancelAllOrders, loginWithApiKey } from "@/lib/grvt-api";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { instrument } = body as { instrument: string };

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
    await cancelAllOrders(session, subAccountId, instrument);

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
