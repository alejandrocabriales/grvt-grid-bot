/**
 * GET /api/bot/positions?instrument=ETH_USDT_Perp
 * Returns open positions for the sub-account.
 */

import { NextRequest, NextResponse } from "next/server";
import { readEnvCredentials } from "@/lib/server/env";
import { getStoredSession, saveSession } from "@/lib/server/session-store";
import { loginWithApiKey, getPositions } from "@/lib/grvt-api";

export async function GET(req: NextRequest) {
  try {
    const instrument = req.nextUrl.searchParams.get("instrument") || undefined;
    const { subAccountId, apiKey } = readEnvCredentials();

    let session = getStoredSession();
    if (!session) {
      session = await loginWithApiKey(apiKey);
      saveSession(session);
    }

    const positions = await getPositions(session, subAccountId, instrument);
    return NextResponse.json({ ok: true, positions });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
