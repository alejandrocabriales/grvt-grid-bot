/**
 * Server-side GRVT session store (módulo singleton)
 * Al ser una app privada de un solo usuario, guardamos la sesión en memoria.
 * El módulo persiste mientras el proceso de Next.js esté corriendo.
 */

import type { GrvtSession } from "@/lib/grvt-api";

interface SessionStore {
  session: GrvtSession | null;
  expiresAt: number; // timestamp ms
}

// Usar globalThis para sobrevivir hot-reload de Next.js en desarrollo.
// En producción (serverless), el proceso persiste entre invocaciones del mismo worker.
const globalForSession = globalThis as unknown as {
  __grvtSessionStore?: SessionStore;
};

if (!globalForSession.__grvtSessionStore) {
  globalForSession.__grvtSessionStore = {
    session: null,
    expiresAt: 0,
  };
}

const store: SessionStore = globalForSession.__grvtSessionStore;

const SESSION_TTL_MS = 50 * 60 * 1000; // 50 minutos (sesiones GRVT duran ~1h)

export function getStoredSession(): GrvtSession | null {
  if (store.session && Date.now() < store.expiresAt) {
    return store.session;
  }
  store.session = null;
  return null;
}

export function saveSession(session: GrvtSession): void {
  store.session = session;
  store.expiresAt = Date.now() + SESSION_TTL_MS;
}

export function clearSession(): void {
  store.session = null;
  store.expiresAt = 0;
}

export function isSessionValid(): boolean {
  return store.session !== null && Date.now() < store.expiresAt;
}
