/**
 * Si ENGINE_BASE_URL está definido, las rutas /api/engine/* se proxian
 * al engine remoto (Fly.io) en lugar de ejecutarse localmente.
 *
 * Vercel: set ENGINE_BASE_URL=https://grvt-grid-bot.fly.dev
 * Fly.io: no setear ENGINE_BASE_URL (corre localmente)
 */
export async function proxyEngine(
  path: string,
  method: "GET" | "POST",
  body?: unknown
): Promise<unknown | null> {
  const baseUrl = process.env.ENGINE_BASE_URL;
  if (!baseUrl) return null; // sin proxy → ejecutar localmente

  const url = `${baseUrl}/api/engine/${path}`;
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body != null ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
}
