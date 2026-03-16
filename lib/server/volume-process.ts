/**
 * lib/server/volume-process.ts — Singleton para el proceso del Volume Optimizer
 *
 * Mismo patrón que engine-process.ts pero ejecuta run-volume-bot.ts
 */

import { spawn, type ChildProcess } from "child_process";
import path from "path";

const g = globalThis as unknown as {
  __volumeProcess?: ChildProcess | null;
};

export function startVolumeEngine(configPath: string): { pid: number } {
  if (isVolumeEngineRunning()) {
    return { pid: g.__volumeProcess!.pid! };
  }

  const proc = spawn(
    "npx",
    ["tsx", path.join(process.cwd(), "scripts/run-volume-bot.ts"), "--config", configPath],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    }
  );

  proc.stdout?.on("data", (data: Buffer) => {
    for (const line of data.toString().split("\n")) {
      if (line.trim()) console.log(`[VOL-ENGINE] ${line.trim()}`);
    }
  });

  proc.stderr?.on("data", (data: Buffer) => {
    for (const line of data.toString().split("\n")) {
      if (line.trim()) console.error(`[VOL-ENGINE] ${line.trim()}`);
    }
  });

  proc.on("exit", (code, signal) => {
    console.log(`[VOL-ENGINE] Process exited — code=${code} signal=${signal}`);
    g.__volumeProcess = null;
  });

  g.__volumeProcess = proc;
  return { pid: proc.pid! };
}

export function stopVolumeEngine(): void {
  if (g.__volumeProcess && !g.__volumeProcess.killed) {
    g.__volumeProcess.kill("SIGTERM");
  }
  g.__volumeProcess = null;
}

export function isVolumeEngineRunning(): boolean {
  return g.__volumeProcess != null && !g.__volumeProcess.killed;
}
