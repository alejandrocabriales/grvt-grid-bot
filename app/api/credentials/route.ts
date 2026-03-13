/**
 * GET /api/credentials
 * Retorna el estado de las credenciales del .env para la UI.
 * Solo expone valores enmascarados — nunca los secretos reales.
 */

import { NextResponse } from "next/server";
import { getEnvStatus } from "@/lib/server/env";
import { isSessionValid } from "@/lib/server/session-store";

export async function GET() {
  const status = await getEnvStatus();
  return NextResponse.json({
    ...status,
    sessionActive: isSessionValid(),
  });
}
