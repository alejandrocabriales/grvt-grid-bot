/**
 * POST /api/bot/orders/create
 * Firma y envía una orden limit a GRVT.
 * La private key (EIP-712) se lee del .env — nunca pasa por el cliente.
 *
 * Body: { instrument, size, limitPrice, isBuying }
 */

import { NextRequest, NextResponse } from "next/server";
import { readEnvCredentials } from "@/lib/server/env";
import { clearSession, getStoredSession, saveSession } from "@/lib/server/session-store";
import { signLimitOrder } from "@/lib/eip712";
import { createOrder, getInstrumentInfo, loginWithApiKey } from "@/lib/grvt-api";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { instrument, size, limitPrice, isBuying } = body as {
      instrument: string;
      size: string;
      limitPrice: string;
      isBuying: boolean;
    };

    console.log(`[CreateOrder] instrument=${instrument} size=${size} limitPrice=${limitPrice} isBuying=${isBuying}`);

    if (!instrument || !size || !limitPrice || typeof isBuying !== "boolean") {
      return NextResponse.json(
        { ok: false, error: "Parámetros inválidos" },
        { status: 400 }
      );
    }

    let session = getStoredSession();
    if (!session) {
      // Auto-autenticar si la sesión se perdió (hot-reload, serverless, etc.)
      const { apiKey } = readEnvCredentials();
      session = await loginWithApiKey(apiKey);
      saveSession(session);
    }

    // Leer credenciales del .env (server-side only)
    const { privateKey, subAccountId, useTestnet } = readEnvCredentials();

    // Validar que la private key sea hex válido antes de usarla
    if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
      return NextResponse.json(
        { ok: false, error: "GRVT_PRIVATE_KEY_EIP712 tiene formato inválido" },
        { status: 500 }
      );
    }

    // Obtener info del instrumento (hash + baseDecimals para EIP-712)
    const instrInfo = await getInstrumentInfo(instrument);

    // Firma la orden en el servidor
    const signedOrder = await signLimitOrder({
      subAccountId,
      instrument,
      instrumentId: instrInfo.instrumentHash,
      size,
      limitPrice,
      isBuying,
      privateKey,
      useTestnet,
      baseDecimals: instrInfo.baseDecimals,
    });

    // Envía a GRVT — reintenta con nueva sesión si recibe 403 (sesión expirada)
    let result;
    try {
      result = await createOrder(session, signedOrder);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("(403)") || msg.includes("expired")) {
        console.warn("[Orders] Session expired, re-authenticating...");
        clearSession();
        const { apiKey } = readEnvCredentials();
        session = await loginWithApiKey(apiKey);
        saveSession(session);
        result = await createOrder(session, signedOrder);
      } else {
        throw err;
      }
    }

    return NextResponse.json({ ok: true, order_id: result.order_id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
