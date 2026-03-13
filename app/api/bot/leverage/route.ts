/**
 * POST /api/bot/leverage
 * Sets initial leverage for an instrument on the sub-account.
 * Body: { instrument, leverage }
 */

import { NextRequest, NextResponse } from "next/server";
import { readEnvCredentials } from "@/lib/server/env";
import { clearSession, getStoredSession, saveSession } from "@/lib/server/session-store";
import { loginWithApiKey, setInitialLeverage } from "@/lib/grvt-api";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { instrument, leverage } = body as {
      instrument: string;
      leverage: number;
    };

    if (!instrument || !leverage || leverage < 1) {
      return NextResponse.json(
        { ok: false, error: "instrument y leverage requeridos" },
        { status: 400 }
      );
    }

    const { subAccountId } = readEnvCredentials();

    let session = getStoredSession();
    if (!session) {
      const { apiKey } = readEnvCredentials();
      session = await loginWithApiKey(apiKey);
      saveSession(session);
    }

    try {
      await setInitialLeverage(session, subAccountId, instrument, leverage);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("(403)") || msg.includes("expired")) {
        console.warn("[Leverage] Session expired, re-authenticating...");
        clearSession();
        const { apiKey } = readEnvCredentials();
        session = await loginWithApiKey(apiKey);
        saveSession(session);
        await setInitialLeverage(session, subAccountId, instrument, leverage);
      } else {
        throw err;
      }
    }

    console.log(`[Leverage] Set ${leverage}x for ${instrument}`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
