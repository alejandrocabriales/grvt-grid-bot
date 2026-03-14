/**
 * lib/server/engine-process.ts — Singleton que gestiona el proceso hijo del motor
 *
 * Usa globalThis para sobrevivir hot-reload de Next.js en desarrollo.
 * El proceso hijo hereda las variables de entorno del proceso padre (credenciales GRVT).
 */

import { spawn, type ChildProcess } from "child_process";
import path from "path";

// Persiste a través de hot-reloads de Next.js
const g = globalThis as unknown as {
  __engineProcess?: ChildProcess | null;
};

export function startEngine(configPath: string): { pid: number } {
  if (isEngineRunning()) {
    return { pid: g.__engineProcess!.pid! };
  }

  const proc = spawn(
    "npx",
    ["tsx", path.join(process.cwd(), "scripts/run-bot.ts"), "--config", configPath, "--reset"],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    }
  );

  proc.stdout?.on("data", (data: Buffer) => {
    for (const line of data.toString().split("\n")) {
      if (line.trim()) console.log(`[ENGINE] ${line.trim()}`);
    }
  });

  proc.stderr?.on("data", (data: Buffer) => {
    for (const line of data.toString().split("\n")) {
      if (line.trim()) console.error(`[ENGINE] ${line.trim()}`);
    }
  });

  proc.on("exit", (code, signal) => {
    console.log(`[ENGINE] Process exited — code=${code} signal=${signal}`);
    g.__engineProcess = null;
  });

  g.__engineProcess = proc;
  return { pid: proc.pid! };
}

export function stopEngine(): void {
  if (g.__engineProcess && !g.__engineProcess.killed) {
    g.__engineProcess.kill("SIGTERM");
  }
  g.__engineProcess = null;
}

export function getEnginePid(): number | null {
  return g.__engineProcess?.pid ?? null;
}

export function isEngineRunning(): boolean {
  return g.__engineProcess != null && !g.__engineProcess.killed;
}
