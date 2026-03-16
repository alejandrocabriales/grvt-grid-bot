/**
 * scripts/run-volume-bot.ts — Entry point del Volume Optimizer
 *
 * Uso:
 *   npx tsx scripts/run-volume-bot.ts
 *   npx tsx scripts/run-volume-bot.ts --config volume-config.json
 *
 * Config desde archivo (recomendado):
 *   Crea volume-config.json en la raíz del proyecto
 *
 * Config desde variables de entorno (alternativa):
 *   VOL_PAIR=BTC_USDT_Perp
 *   VOL_INVESTMENT=50
 *   VOL_LEVERAGE=10
 */

import * as dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import { VolumeEngine } from "./volume-engine";
import {
  type VolumeConfig,
  defaultVolumeConfig,
  estimateVolume,
} from "../lib/volume-optimizer";

// ─── Load config ─────────────────────────────────────────────────────────────

function loadConfig(): VolumeConfig {
  const configFlagIdx = process.argv.indexOf("--config");
  const configFile = configFlagIdx !== -1 ? process.argv[configFlagIdx + 1] : null;

  const candidates = [
    configFile && path.resolve(configFile),
    path.join(process.cwd(), "volume-config.json"),
  ].filter(Boolean) as string[];

  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      console.log(`[Config] Loading from ${filePath}`);
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
      // Merge with defaults to fill missing fields
      const defaults = defaultVolumeConfig(
        raw.pair ?? "BTC_USDT_Perp",
        raw.totalInvestment ?? 50,
        raw.leverage ?? 10
      );
      return { ...defaults, ...raw };
    }
  }

  // Fallback to env vars
  console.log("[Config] volume-config.json not found, using env vars");

  const pair = process.env.VOL_PAIR ?? "BTC_USDT_Perp";
  const investment = parseFloat(process.env.VOL_INVESTMENT ?? "50");
  const leverage = parseInt(process.env.VOL_LEVERAGE ?? "10");

  return defaultVolumeConfig(pair, investment, leverage);
}

// ─── Banner ──────────────────────────────────────────────────────────────────

function printBanner(config: VolumeConfig, dbPath: string): void {
  const net = process.env.GRVT_USE_TESTNET === "true" ? "TESTNET" : "MAINNET";
  const est = estimateVolume(
    config.totalInvestment,
    config.leverage,
    config.spreadPairs
  );

  console.log("");
  console.log("══════════════════════════════════════════════════════════════");
  console.log("  GRVT Volume Optimizer — Maximize Trading Volume");
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`  Pair:           ${config.pair}`);
  console.log(`  Capital:        $${config.totalInvestment} x ${config.leverage}x = $${config.totalInvestment * config.leverage} notional`);
  console.log(`  Spread pairs:   ${config.spreadPairs}`);
  console.log(`  Spread offset:  ${config.spreadOffsetBps} bps (step: ${config.spreadStepBps} bps)`);
  console.log(`  Scalp TP/SL:    ${config.scalpTpBps}/${config.scalpSlBps} bps`);
  console.log(`  Max drawdown:   ${config.maxDrawdownPct}%`);
  console.log(`  Max session loss: $${config.maxSessionLossUsdc.toFixed(2)}`);
  console.log(`  Network:        ${net}`);
  console.log(`  DB:             ${dbPath}`);
  console.log("──────────────────────────────────────────────────────────────");
  console.log("  Volume Estimates (50% fill rate):");
  console.log(`    Per pair notional: $${est.nocionalPerPair.toFixed(0)}`);
  console.log(`    Per cycle volume:  $${est.volumePerCyclePerPair.toFixed(0)}`);
  console.log(`    Cycles/hour:       ${est.cyclesPerHour.toFixed(1)}`);
  console.log(`    Volume/hour:       $${est.volumePerHour.toFixed(0)}`);
  console.log(`    Volume/day:        $${est.volumePerDay.toFixed(0)}`);
  console.log(`    Volume/week:       $${est.volumePerWeek.toFixed(0)}`);
  console.log(`    Trades/day:        ~${est.tradesPerDay.toFixed(0)}`);
  console.log("══════════════════════════════════════════════════════════════\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = loadConfig();
  const dbPath = process.env.VOL_DB_PATH ?? path.join(process.cwd(), "volume-state.sqlite");

  printBanner(config, dbPath);

  const engine = new VolumeEngine(config, dbPath);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[Signal] ${signal} received. Shutting down...`);
    await engine.stop();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  process.on("uncaughtException", async (err) => {
    console.error("\n[Fatal] Uncaught exception:", err);
    await engine.stop();
    process.exit(1);
  });

  process.on("unhandledRejection", async (reason) => {
    console.error("\n[Fatal] Unhandled rejection:", reason);
    await engine.stop();
    process.exit(1);
  });

  await engine.start();
}

main().catch(async (err) => {
  console.error("[Fatal]", err);
  process.exit(1);
});
