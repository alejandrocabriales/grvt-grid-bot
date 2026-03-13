/**
 * GET /api/bot/debug
 * Diagnóstico completo: balance, órdenes abiertas, posiciones, leverage.
 * Hace las llamadas raw para ver exactamente qué devuelve GRVT.
 */

import { NextResponse } from "next/server";
import { readEnvCredentials } from "@/lib/server/env";
import { getStoredSession, saveSession } from "@/lib/server/session-store";
import { getBaseUrls, loginWithApiKey } from "@/lib/grvt-api";

async function grvtPost(session: { cookie: string; accountId: string }, path: string, body: Record<string, unknown>) {
  const base = getBaseUrls();
  const res = await fetch(`${base.rest}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: session.cookie,
      "X-Grvt-Account-Id": session.accountId,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) };
  } catch {
    return { status: res.status, data: text };
  }
}

export async function GET() {
  try {
    const { subAccountId, apiKey } = readEnvCredentials();

    let session = getStoredSession();
    if (!session) {
      session = await loginWithApiKey(apiKey);
      saveSession(session);
    }

    // 1. Try multiple possible balance endpoints
    const balancePaths = [
      "/full/v1/sub_account_summary",
      "/full/v1/get_sub_account",
      "/full/v1/account_summary",
      "/full/v1/get_account_summary",
      "/full/v1/collateral",
      "/full/v1/get_collateral",
      "/full/v1/sub_account",
      "/full/v1/get_sub_account_summary",
    ];
    const balanceResults: Record<string, unknown> = {};
    for (const path of balancePaths) {
      const r = await grvtPost(session, path, { sub_account_id: subAccountId });
      // Only include non-404 results
      if (r.status !== 404 && !(typeof r.data === "string" && r.data.includes("404"))) {
        balanceResults[path] = r;
      }
    }
    const summary = { data: balanceResults };

    // 2. Open orders for ETH_USDT_Perp
    const openOrders = await grvtPost(session, "/full/v1/open_orders", {
      sub_account_id: subAccountId,
      kind: ["PERPETUAL"],
      base: [],
      quote: [],
    });

    // 3. Positions
    const positions = await grvtPost(session, "/full/v1/positions", {
      sub_account_id: subAccountId,
      kind: ["PERPETUAL"],
      base: [],
      quote: [],
    });

    // 4. Funding (main) account — where deposits go
    const funding = await grvtPost(session, "/full/v1/funding_account_summary", {});

    // 5. Correct sub-account summary
    const subAccountSummary = await grvtPost(session, "/full/v1/account_summary", {
      sub_account_id: subAccountId,
    });

    return NextResponse.json({
      ok: true,
      subAccountId,
      subAccountSummary: subAccountSummary.data,
      fundingAccount: funding.data,
      openOrders: openOrders.data,
      positions: positions.data,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
