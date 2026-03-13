/**
 * POST /api/bot/auth
 * Autentica con GRVT usando GRVT_API_KEY del .env.
 * Guarda la sesión en el store server-side.
 * El cookie de GRVT nunca sale del servidor.
 */

import { NextResponse } from "next/server";
import { readEnvCredentials } from "@/lib/server/env";
import { loginWithApiKey } from "@/lib/grvt-api";
import { saveSession, getStoredSession } from "@/lib/server/session-store";

export async function POST() {
  try {
    // Reusar sesión existente si aún es válida
    const existing = getStoredSession();
    if (existing) {
      return NextResponse.json({ ok: true, reused: true });
    }

    const { apiKey } = readEnvCredentials();
    const session = await loginWithApiKey(apiKey);
    saveSession(session);

    return NextResponse.json({ ok: true, reused: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
