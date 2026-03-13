/**
 * GET /api/bot/balance
 * Returns the sub-account equity and available margin.
 */

import { NextResponse } from "next/server";
import { readEnvCredentials } from "@/lib/server/env";
import { getStoredSession, saveSession } from "@/lib/server/session-store";
import { loginWithApiKey, getSubAccountSummary } from "@/lib/grvt-api";

export async function GET() {
  try {
    const { subAccountId, apiKey } = readEnvCredentials();

    let session = getStoredSession();
    if (!session) {
      session = await loginWithApiKey(apiKey);
      saveSession(session);
    }

    const summary = await getSubAccountSummary(session, subAccountId);
    return NextResponse.json({
      ok: true,
      equity: summary.equity,
      availableBalance: summary.availableBalance,
      pnl: summary.pnl,
      subAccountId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
