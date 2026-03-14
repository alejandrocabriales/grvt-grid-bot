/**
 * scripts/run-bot.ts — Entry point del motor standalone
 *
 * Uso:
 *   npx tsx scripts/run-bot.ts             # Reanuda estado anterior
 *   npx tsx scripts/run-bot.ts --reset     # Ignora estado anterior, inicia limpio
 *   npx tsx scripts/run-bot.ts --config my-config.json   # Config personalizada
 *
 * Config desde archivo (recomendado):
 *   Crea bot-config.json en la raíz del proyecto (ver bot-config.example.json)
 *
 * Config desde variables de entorno (alternativa rápida):
 *   BOT_PAIR=BTC_USDT_Perp
 *   BOT_UPPER=70000
 *   BOT_LOWER=58000
 *   BOT_GRIDS=12
 *   BOT_INVESTMENT=200    # USDC de margen real
 *   BOT_LEVERAGE=2
 */

import * as dotenv from "dotenv";
dotenv.config();

import fs   from "fs";
import path from "path";
import { GridEngine }  from "./grid-engine";
import type { GridConfig } from "../lib/grid-bot";

// ─── Cargar configuración ────────────────────────────────────────────────────

function loadConfig(): GridConfig {
  // Soporte para --config ruta/al/archivo.json
  const configFlagIdx = process.argv.indexOf("--config");
  const configFile    = configFlagIdx !== -1 ? process.argv[configFlagIdx + 1] : null;

  const candidates = [
    configFile && path.resolve(configFile),
    path.join(process.cwd(), "bot-config.json"),
  ].filter(Boolean) as string[];

  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      console.log(`[Config] Cargando desde ${filePath}`);
      return JSON.parse(fs.readFileSync(filePath, "utf8")) as GridConfig;
    }
  }

  // Fallback a variables de entorno
  console.log("[Config] bot-config.json no encontrado, usando variables de entorno");

  const upper      = parseFloat(process.env.BOT_UPPER      ?? "0");
  const lower      = parseFloat(process.env.BOT_LOWER      ?? "0");
  const grids      = parseInt(process.env.BOT_GRIDS         ?? "10");
  const investment = parseFloat(process.env.BOT_INVESTMENT  ?? "100");
  const leverage   = parseInt(process.env.BOT_LEVERAGE      ?? "1");

  if (!upper || !lower) {
    console.error(
      "\n[Error] Debes configurar el rango del grid.\n" +
      "  Opción A: Crea bot-config.json (ver bot-config.example.json)\n" +
      "  Opción B: Exporta BOT_UPPER y BOT_LOWER antes de ejecutar\n"
    );
    process.exit(1);
  }

  return {
    pair:               process.env.BOT_PAIR ?? "BTC_USDT_Perp",
    strategyMode:       "NEUTRAL_GRID",
    upperPrice:         upper,
    lowerPrice:         lower,
    gridCount:          grids,
    gridType:           "GEOMETRIC",
    totalInvestment:    investment,
    leverage,
    maxDrawdownPct:     15,
    enableTrailingStop: false,
    autoReposition:     false,
    trendFilterEnabled: true,
  };
}

// ─── Imprimir banner ─────────────────────────────────────────────────────────

function printBanner(config: GridConfig, dbPath: string): void {
  const net = process.env.GRVT_USE_TESTNET === "true" ? "TESTNET ⚠" : "MAINNET";
  console.log("");
  console.log("══════════════════════════════════════════════════");
  console.log("  GRVT Grid Bot — Motor Standalone 24/7");
  console.log("══════════════════════════════════════════════════");
  console.log(`  Par:         ${config.pair}`);
  console.log(`  Modo:        ${config.strategyMode}`);
  console.log(`  Rango:       $${config.lowerPrice} — $${config.upperPrice}`);
  console.log(`  Grids:       ${config.gridCount} (${config.gridType})`);
  console.log(`  Inversión:   $${config.totalInvestment} margen × ${config.leverage}x`);
  if (config.stopLoss)   console.log(`  Stop-Loss:   $${config.stopLoss}`);
  if (config.takeProfit) console.log(`  Take-Profit: $${config.takeProfit}`);
  console.log(`  Max DD:      ${config.maxDrawdownPct ?? 15}%`);
  console.log(`  Red:         ${net}`);
  console.log(`  Estado DB:   ${dbPath}`);
  if (process.argv.includes("--reset")) {
    console.log("  Modo:        --reset (estado anterior ignorado)");
  }
  console.log("══════════════════════════════════════════════════\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config    = loadConfig();
  const forceNew  = process.argv.includes("--reset");
  const dbPath    = process.env.BOT_DB_PATH ?? path.join(process.cwd(), "bot-state.sqlite");

  printBanner(config, dbPath);

  const engine = new GridEngine(config, dbPath);

  // ── Señales de OS para apagado limpio ─────────────────────────────────────

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[Signal] ${signal} recibido. Apagando limpiamente...`);
    await engine.stop();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));   // Ctrl+C

  process.on("uncaughtException", async (err) => {
    console.error("\n[Fatal] Excepción no capturada:", err);
    await engine.stop();
    process.exit(1);
  });

  process.on("unhandledRejection", async (reason) => {
    console.error("\n[Fatal] Promise rejection no manejada:", reason);
    await engine.stop();
    process.exit(1);
  });

  // ── Arranque ──────────────────────────────────────────────────────────────
  await engine.start(forceNew);
}

main().catch(async (err) => {
  console.error("[Fatal]", err);
  process.exit(1);
});
