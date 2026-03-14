/**
 * scripts/db.ts — Persistencia SQLite para el motor standalone del bot
 *
 * Usa better-sqlite3 (síncrono) para simplificar el código y garantizar
 * consistencia transaccional sin callbacks.
 *
 * Tablas:
 *   grid_orders  — estado de cada orden colocada
 *   bot_config   — configuración activa (JSON serializado)
 *   bot_metrics  — métricas de runtime (PnL, drawdown, etc.)
 *   bot_log      — log persistente de eventos importantes
 */

import Database from "better-sqlite3";
import path from "path";

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface DbOrder {
  id?: number;
  pair: string;
  level_index: number;
  price: number;
  side: "buy" | "sell";
  size: string;
  order_id: string | null;
  client_order_id: string | null;
  /** pending → orden creada localmente pero sin confirmar en exchange
   *  open    → confirmada en exchange, esperando fill
   *  filled  → ejecutada
   *  cancelled → cancelada */
  status: "pending" | "open" | "filled" | "cancelled";
  /** 1 si ya se colocó la contra-orden correspondiente */
  counter_placed: 0 | 1;
  created_at: number;
  filled_at: number | null;
}

// ─── Clase BotDatabase ────────────────────────────────────────────────────────

export class BotDatabase {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    // WAL mode: lecturas no bloquean escrituras
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS grid_orders (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        pair             TEXT    NOT NULL,
        level_index      INTEGER NOT NULL,
        price            REAL    NOT NULL,
        side             TEXT    NOT NULL,
        size             TEXT    NOT NULL,
        order_id         TEXT,
        client_order_id  TEXT,
        status           TEXT    NOT NULL DEFAULT 'pending',
        counter_placed   INTEGER NOT NULL DEFAULT 0,
        created_at       INTEGER NOT NULL,
        filled_at        INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_orders_status  ON grid_orders(status, pair);
      CREATE INDEX IF NOT EXISTS idx_orders_orderid ON grid_orders(order_id);

      CREATE TABLE IF NOT EXISTS bot_config (
        key        TEXT    PRIMARY KEY,
        value      TEXT    NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bot_metrics (
        key        TEXT    PRIMARY KEY,
        value      TEXT    NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bot_log (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        level     TEXT    NOT NULL,
        message   TEXT    NOT NULL,
        timestamp INTEGER NOT NULL
      );
    `);
  }

  // ─── Orders ─────────────────────────────────────────────────────────────────

  insertOrder(order: Omit<DbOrder, "id">): number {
    const stmt = this.db.prepare(`
      INSERT INTO grid_orders
        (pair, level_index, price, side, size, order_id, client_order_id,
         status, counter_placed, created_at, filled_at)
      VALUES
        (@pair, @level_index, @price, @side, @size, @order_id, @client_order_id,
         @status, @counter_placed, @created_at, @filled_at)
    `);
    const result = stmt.run(order);
    return result.lastInsertRowid as number;
  }

  /** Actualiza order_id y status cuando la API confirma la orden */
  updateOrderId(id: number, orderId: string, status: DbOrder["status"] = "open"): void {
    this.db
      .prepare(`UPDATE grid_orders SET order_id = ?, status = ? WHERE id = ?`)
      .run(orderId, status, id);
  }

  updateOrderStatus(orderId: string, status: DbOrder["status"], filledAt?: number): void {
    this.db
      .prepare(`UPDATE grid_orders SET status = ?, filled_at = ? WHERE order_id = ?`)
      .run(status, filledAt ?? null, orderId);
  }

  markCounterPlaced(orderId: string): void {
    this.db
      .prepare(`UPDATE grid_orders SET counter_placed = 1 WHERE order_id = ?`)
      .run(orderId);
  }

  getOpenOrders(pair: string): DbOrder[] {
    return this.db
      .prepare(`SELECT * FROM grid_orders WHERE pair = ? AND status = 'open'`)
      .all(pair) as DbOrder[];
  }

  getAllActiveOrders(pair: string): DbOrder[] {
    return this.db
      .prepare(`SELECT * FROM grid_orders WHERE pair = ? AND status IN ('pending','open')`)
      .all(pair) as DbOrder[];
  }

  cancelAllOrders(pair: string): void {
    this.db
      .prepare(`UPDATE grid_orders SET status = 'cancelled' WHERE pair = ? AND status IN ('pending','open')`)
      .run(pair);
  }

  // ─── Config ──────────────────────────────────────────────────────────────────

  setConfig(key: string, value: unknown): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO bot_config (key, value, updated_at) VALUES (?, ?, ?)`)
      .run(key, JSON.stringify(value), Date.now());
  }

  getConfig<T>(key: string): T | null {
    const row = this.db
      .prepare(`SELECT value FROM bot_config WHERE key = ?`)
      .get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : null;
  }

  // ─── Metrics ─────────────────────────────────────────────────────────────────

  setMetric(key: string, value: unknown): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO bot_metrics (key, value, updated_at) VALUES (?, ?, ?)`)
      .run(key, JSON.stringify(value), Date.now());
  }

  getMetric<T>(key: string, defaultValue: T): T {
    const row = this.db
      .prepare(`SELECT value FROM bot_metrics WHERE key = ?`)
      .get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : defaultValue;
  }

  // ─── Log ─────────────────────────────────────────────────────────────────────

  appendLog(level: "info" | "warn" | "error" | "success", message: string): void {
    this.db
      .prepare(`INSERT INTO bot_log (level, message, timestamp) VALUES (?, ?, ?)`)
      .run(level, message, Date.now());
  }

  // ─── Read helpers for UI ──────────────────────────────────────────────────

  getLogsRecent(limit = 50): { level: string; message: string; timestamp: number }[] {
    return this.db
      .prepare(`SELECT level, message, timestamp FROM bot_log ORDER BY id DESC LIMIT ?`)
      .all(limit) as { level: string; message: string; timestamp: number }[];
  }

  getOrderHistory(pair: string, limit = 100): DbOrder[] {
    return this.db
      .prepare(`SELECT * FROM grid_orders WHERE pair = ? ORDER BY id DESC LIMIT ?`)
      .all(pair, limit) as DbOrder[];
  }

  close(): void {
    this.db.close();
  }
}
