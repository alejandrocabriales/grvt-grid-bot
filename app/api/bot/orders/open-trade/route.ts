/**
 * POST /api/bot/orders/open-trade
 * Abre una posición de mercado (long o short) calculando el tamaño
 * a partir de inversión + apalancamiento + precio actual.
 *
 * Body: { instrument, direction: "long" | "short", investment: number, leverage: number }
 * Returns: { ok, order_id, entryPrice, size, instrument, direction }
 */

import { NextRequest, NextResponse } from "next/server";
import { readEnvCredentials } from "@/lib/server/env";
import { clearSession, getStoredSession, saveSession } from "@/lib/server/session-store";
import { signLimitOrder } from "@/lib/eip712";
import {
  createOrder,
  getInstrumentId,
  getInstrumentInfo,
  loginWithApiKey,
} from "@/lib/grvt-api";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { instrument, direction, investment, leverage } = body as {
      instrument: string;
      direction: "long" | "short";
      investment: number;
      leverage: number;
    };

    if (!instrument || !direction || !investment || !leverage) {
      return NextResponse.json({ ok: false, error: "Parámetros inválidos" }, { status: 400 });
    }

    const { privateKey, subAccountId, apiKey, useTestnet } = readEnvCredentials();

    let session = getStoredSession();
    if (!session) {
      session = await loginWithApiKey(apiKey);
      saveSession(session);
    }

    // Obtener precio actual e info del instrumento
    const base = useTestnet
      ? "https://market-data.testnet.grvt.io"
      : "https://market-data.grvt.io";

    const [miniRes, instrumentInfo] = await Promise.all([
      fetch(`${base}/full/v1/mini`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instrument }),
      }),
      getInstrumentInfo(instrument),
    ]);

    const miniData = await miniRes.json();
    const result = miniData?.result ?? miniData;
    const entryPrice = parseFloat(
      result?.mark_price || result?.oracle_price || result?.last_price || "0"
    );

    if (entryPrice <= 0) {
      return NextResponse.json({ ok: false, error: "No se pudo obtener el precio actual" }, { status: 500 });
    }

    // Calcular tamaño: capital efectivo / precio
    const effectiveCapital = investment * leverage;
    const rawSize = effectiveCapital / entryPrice;
    const sizeDecimals = instrumentInfo?.sizeDecimals ?? 2;
    const size = rawSize.toFixed(sizeDecimals);
    const minSize = parseFloat(instrumentInfo?.minSize ?? "0.01");

    if (parseFloat(size) < minSize) {
      return NextResponse.json({
        ok: false,
        error: `Tamaño calculado (${size}) es menor al mínimo (${minSize}). Aumenta inversión o leverage.`,
      }, { status: 400 });
    }

    // Orden de mercado: GRVT requiere limit_price = "0" cuando isMarket = true
    const isBuying = direction === "long";

    const instrumentId = await getInstrumentId(instrument);

    const signedOrder = await signLimitOrder({
      subAccountId,
      instrument,
      instrumentId,
      size,
      limitPrice: "0",
      isBuying,
      isMarket: true,
      privateKey,
      useTestnet,
    });

    let orderResult;
    try {
      orderResult = await createOrder(session, signedOrder);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("(403)") || msg.includes("expired")) {
        clearSession();
        session = await loginWithApiKey(apiKey);
        saveSession(session);
        orderResult = await createOrder(session, signedOrder);
      } else {
        throw err;
      }
    }

    return NextResponse.json({
      ok: true,
      order_id: orderResult.order_id,
      entryPrice,
      size,
      instrument,
      direction,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
