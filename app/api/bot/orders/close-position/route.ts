/**
 * POST /api/bot/orders/close-position
 * Closes an open position with a market order (reduce-only).
 *
 * Body: { instrument }
 * Queries the current position, then places an opposite market order to close it.
 */

import { NextRequest, NextResponse } from "next/server";
import { readEnvCredentials } from "@/lib/server/env";
import { clearSession, getStoredSession, saveSession } from "@/lib/server/session-store";
import { signLimitOrder } from "@/lib/eip712";
import {
  createOrder,
  getInstrumentId,
  getPositions,
  loginWithApiKey,
} from "@/lib/grvt-api";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { instrument } = body as { instrument: string };

    if (!instrument) {
      return NextResponse.json(
        { ok: false, error: "Missing instrument" },
        { status: 400 }
      );
    }

    const { privateKey, subAccountId, apiKey, useTestnet } = readEnvCredentials();

    let session = getStoredSession();
    if (!session) {
      session = await loginWithApiKey(apiKey);
      saveSession(session);
    }

    // Get current position
    const positions = await getPositions(session, subAccountId, instrument);
    const position = positions.find((p) => p.instrument === instrument);

    if (!position || parseFloat(position.size) === 0) {
      return NextResponse.json({ ok: true, message: "No position to close" });
    }

    const posSize = parseFloat(position.size);
    const isLong = posSize > 0;
    const absSize = Math.abs(posSize).toString();

    const instrumentId = await getInstrumentId(instrument);

    // Orden de mercado: GRVT requiere limit_price = "0" cuando isMarket = true
    const signedOrder = await signLimitOrder({
      subAccountId,
      instrument,
      instrumentId,
      size: absSize,
      limitPrice: "0",
      isBuying: !isLong, // opposite side to close
      isMarket: true,
      reduceOnly: true,
      privateKey,
      useTestnet,
    });

    let result;
    try {
      result = await createOrder(session, signedOrder);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("(403)") || msg.includes("expired")) {
        clearSession();
        session = await loginWithApiKey(apiKey);
        saveSession(session);
        result = await createOrder(session, signedOrder);
      } else {
        throw err;
      }
    }

    return NextResponse.json({
      ok: true,
      order_id: result.order_id,
      closed_size: absSize,
      side: isLong ? "sell" : "buy",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
