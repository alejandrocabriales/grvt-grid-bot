/**
 * GRVT API Client
 * Docs: https://api-docs.grvt.io/
 * Auth: Session cookie via API Key login → EIP-712 signed orders
 */

const MAINNET = {
  rest: "https://trades.grvt.io",
  auth: "https://edge.grvt.io",
  marketData: "https://market-data.grvt.io",
  ws: "wss://market-data.grvt.io/ws/full",
  wsTrading: "wss://trades.grvt.io/ws/full",
};

const TESTNET = {
  rest: "https://trades.testnet.grvt.io",
  auth: "https://edge.testnet.grvt.io",
  marketData: "https://market-data.testnet.grvt.io",
  ws: "wss://market-data.testnet.grvt.io/ws/full",
  wsTrading: "wss://trades.testnet.grvt.io/ws/full",
};

function getBaseUrls() {
  const useTestnet = process.env.GRVT_USE_TESTNET === "true";
  return useTestnet ? TESTNET : MAINNET;
}

export { getBaseUrls };

export interface GrvtSession {
  cookie: string;       // gravity=<token>
  accountId: string;   // X-Grvt-Account-Id
}

export interface GrvtOrder {
  sub_account_id: string;
  is_market: boolean;
  time_in_force: string;
  post_only: boolean;
  reduce_only: boolean;
  legs: {
    instrument: string;
    size: string;
    limit_price: string;
    is_buying_asset: boolean;
  }[];
  signature: {
    signer: string;
    r: string;
    s: string;
    v: number;
    expiration: string; // nanoseconds as string
    nonce: number;
  };
  metadata: {
    client_order_id: string;
  };
}

export interface OpenOrder {
  id: string;
  client_order_id?: string;
  instrument: string;
  is_buying_asset: boolean;
  limit_price: string;
  size: string;
  filled_size: string;
  state: string;
  created_at: string;
}

// ─── Instrument lookup ───────────────────────────────────────────────────────

export interface InstrumentInfo {
  instrumentHash: string;
  baseDecimals: number;
  tickSize: string;
  minSize: string;
  sizeDecimals: number;  // derived from minSize (e.g. "0.01" → 2)
  priceDecimals: number; // derived from tickSize (e.g. "0.01" → 2)
}

// Cache instrument info to avoid repeated fetches
const instrumentCache = new Map<string, InstrumentInfo>();

/**
 * Fetch instrument metadata (ID, base_decimals, tick_size, min_size).
 * base_decimals controls how many decimal places are allowed in size fields.
 */
export async function getInstrumentInfo(instrument: string): Promise<InstrumentInfo> {
  if (instrumentCache.has(instrument)) {
    return instrumentCache.get(instrument)!;
  }

  const base = getBaseUrls();
  const res = await fetch(`${base.marketData}/full/v1/instrument`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instrument }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to fetch instrument for ${instrument} (${res.status}): ${text}`);
  }

  const data = await res.json();
  const result = data.result || {};

  // Log the full response so we can see all available fields
  console.log(`[Instrument] Full response for ${instrument}:`, JSON.stringify(result, null, 2));

  const instrumentHash: string =
    result.instrument_hash?.toString() ||
    result.instrument_id?.toString();

  if (!instrumentHash) {
    throw new Error(`No instrument_hash returned for ${instrument}. Response: ${JSON.stringify(data)}`);
  }

  const tickSize = result.tick_size ?? "0.01";
  const minSize = result.min_size ?? "0.01";

  // Derive actual allowed decimals from min_size and tick_size
  // e.g. min_size "0.01" → 2 decimals, "0.001" → 3 decimals
  const sizeDecimals = (minSize.split(".")[1] || "").replace(/0+$/, "").length || 0;
  const priceDecimals = (tickSize.split(".")[1] || "").replace(/0+$/, "").length || 0;

  const info: InstrumentInfo = {
    instrumentHash,
    baseDecimals: Number(result.base_decimals ?? 9),
    tickSize,
    minSize,
    sizeDecimals,
    priceDecimals,
  };

  console.log(`[Instrument] ${instrument}: sizeDecimals=${sizeDecimals} (from min_size=${minSize}), priceDecimals=${priceDecimals} (from tick_size=${tickSize})`);

  instrumentCache.set(instrument, info);
  return info;
}

/**
 * Shortcut: get just the instrument hash (for backwards compat)
 */
export async function getInstrumentId(instrument: string): Promise<string> {
  const info = await getInstrumentInfo(instrument);
  return info.instrumentHash;
}

// ─── Auth ────────────────────────────────────────────────────────────────────

export async function loginWithApiKey(
  apiKey: string
): Promise<GrvtSession> {
  const base = getBaseUrls();
  const res = await fetch(`${base.auth}/auth/api_key/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GRVT Login failed (${res.status}): ${text}`);
  }

  const data = await res.json();

  // Log all response headers for debugging
  const allHeaders: Record<string, string> = {};
  res.headers.forEach((value, key) => { allHeaders[key] = value; });
  console.log("[GRVT Auth] Response headers:", JSON.stringify(allHeaders, null, 2));
  console.log("[GRVT Auth] Response body:", JSON.stringify(data, null, 2));

  // Extract cookie from response headers or body
  // Node.js fetch: getSetCookie() returns array; fallback to get() for older runtimes
  const setCookieHeaders: string[] =
    typeof (res.headers as any).getSetCookie === "function"
      ? (res.headers as any).getSetCookie()
      : [];

  // Also try the legacy single-header approach
  const singleCookie = res.headers.get("set-cookie") || "";
  const allCookieStr = [...setCookieHeaders, singleCookie].filter(Boolean).join("; ");

  console.log("[GRVT Auth] All set-cookie values:", setCookieHeaders);
  console.log("[GRVT Auth] Single set-cookie header:", singleCookie);

  // Try to find the gravity= cookie in headers
  const cookieMatch = allCookieStr.match(/gravity=([^;,\s]+)/);
  let cookie = cookieMatch ? `gravity=${cookieMatch[1]}` : "";

  // Fallback: check response body for token fields
  if (!cookie) {
    cookie =
      data.cookie ||
      data.token ||
      data.access_token ||
      data.session_token ||
      (data.result?.cookie) ||
      (data.result?.token) ||
      "";
    if (cookie && !cookie.startsWith("gravity=")) {
      cookie = `gravity=${cookie}`;
    }
  }

  const accountId =
    res.headers.get("x-grvt-account-id") ||
    data.account_id ||
    data.result?.account_id ||
    "";

  if (!cookie) {
    console.error("[GRVT Auth] No cookie captured anywhere. All cookie strings:", allCookieStr);
    console.error("[GRVT Auth] Full body:", JSON.stringify(data));
    throw new Error(
      "GRVT login succeeded but no session cookie was captured. " +
      "Check that the API key is valid and the set-cookie header is accessible."
    );
  }

  if (!accountId) {
    console.error("[GRVT Auth] No account ID captured from headers or body");
  }

  return { cookie, accountId };
}

// ─── Orders ──────────────────────────────────────────────────────────────────

export async function createOrder(
  session: GrvtSession,
  order: GrvtOrder
): Promise<{ order_id: string }> {
  const res = await fetch(`${getBaseUrls().rest}/full/v1/create_order`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: session.cookie,
      "X-Grvt-Account-Id": session.accountId,
    },
    body: JSON.stringify({ order }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Create order failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return { order_id: data.result?.order_id || data.order_id || "" };
}

export async function cancelOrder(
  session: GrvtSession,
  subAccountId: string,
  orderId: string
): Promise<void> {
  const res = await fetch(`${getBaseUrls().rest}/full/v1/cancel_order`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: session.cookie,
      "X-Grvt-Account-Id": session.accountId,
    },
    body: JSON.stringify({
      sub_account_id: subAccountId,
      order_id: orderId,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Cancel order failed (${res.status}): ${text}`);
  }
}

export async function cancelAllOrders(
  session: GrvtSession,
  subAccountId: string,
  instrument: string
): Promise<void> {
  const res = await fetch(`${getBaseUrls().rest}/full/v1/cancel_all_orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: session.cookie,
      "X-Grvt-Account-Id": session.accountId,
    },
    body: JSON.stringify({
      sub_account_id: subAccountId,
      instrument,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Cancel all orders failed (${res.status}): ${text}`);
  }
}

export async function getOpenOrders(
  session: GrvtSession,
  subAccountId: string,
  instrument: string
): Promise<OpenOrder[]> {
  const res = await fetch(`${getBaseUrls().rest}/full/v1/open_orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: session.cookie,
      "X-Grvt-Account-Id": session.accountId,
    },
    body: JSON.stringify({
      sub_account_id: subAccountId,
      instrument,
      kind: ["PERPETUAL"],
      base: [],
      quote: [],
    }),
  });

  if (!res.ok) return [];

  const data = await res.json();
  return data.result || [];
}

// ─── Positions ────────────────────────────────────────────────────────────────

export interface Position {
  instrument: string;
  size: string;           // positive = long, negative = short
  entry_price: string;
  mark_price: string;
  unrealized_pnl: string;
  realized_pnl: string;
  margin: string;
  leverage: string;
}

export async function getPositions(
  session: GrvtSession,
  subAccountId: string,
  instrument?: string
): Promise<Position[]> {
  const body: Record<string, unknown> = { sub_account_id: subAccountId };
  if (instrument) body.instrument = instrument;

  const res = await fetch(`${getBaseUrls().rest}/full/v1/positions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: session.cookie,
      "X-Grvt-Account-Id": session.accountId,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`[Positions] Failed (${res.status}):`, text);
    return [];
  }

  const data = await res.json();
  return data.result || [];
}

// ─── Leverage ─────────────────────────────────────────────────────────────────

export async function setInitialLeverage(
  session: GrvtSession,
  subAccountId: string,
  instrument: string,
  leverage: number
): Promise<void> {
  const res = await fetch(`${getBaseUrls().rest}/full/v1/set_initial_leverage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: session.cookie,
      "X-Grvt-Account-Id": session.accountId,
    },
    body: JSON.stringify({
      sub_account_id: subAccountId,
      instrument,
      leverage: String(leverage),
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Set leverage failed (${res.status}): ${text}`);
  }
}

export async function getAllInitialLeverage(
  session: GrvtSession,
  subAccountId: string
): Promise<Array<{ instrument: string; leverage: string; min_leverage: string; max_leverage: string }>> {
  const res = await fetch(`${getBaseUrls().rest}/full/v1/get_all_initial_leverage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: session.cookie,
      "X-Grvt-Account-Id": session.accountId,
    },
    body: JSON.stringify({ sub_account_id: subAccountId }),
  });

  if (!res.ok) return [];
  const data = await res.json();
  return data.results || [];
}

// ─── Account ──────────────────────────────────────────────────────────────────

export async function getSubAccountSummary(
  session: GrvtSession,
  subAccountId: string
): Promise<{ equity: string; pnl: string; availableBalance: string; raw: Record<string, unknown> }> {
  const res = await fetch(`${getBaseUrls().rest}/full/v1/account_summary`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: session.cookie,
      "X-Grvt-Account-Id": session.accountId,
    },
    body: JSON.stringify({ sub_account_id: subAccountId }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`[Balance] Failed (${res.status}):`, text);
    return { equity: "0", pnl: "0", availableBalance: "0", raw: {} };
  }

  const data = await res.json();
  console.log(`[Balance] Full response:`, JSON.stringify(data, null, 2));
  const result = data.result || data || {};
  return {
    equity: result.total_equity || result.equity || "0",
    pnl: result.unrealized_pnl || result.pnl || "0",
    availableBalance: result.available_balance || "0",
    raw: result,
  };
}

// ─── K-lines (Fallback via Binance) ──────────────────────────────────────────

export interface Kline {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export async function getBinanceKlines(
  symbol: string,
  interval: string = "5m",
  limit: number = 200
): Promise<Kline[]> {
  try {
    // Convert GRVT symbol (ETH_USDT_Perp) to Binance (ETHUSDT)
    const binanceSymbol = symbol.split("_")[0] + "USDT";
    const res = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${binanceSymbol}&interval=${interval}&limit=${limit}`
    );
    if (!res.ok) {
      console.error(`[Klines] Failed to fetch from binance: ${res.statusText}`);
      return [];
    }
    const data = await res.json();
    return data.map((k: any) => ({
      timestamp: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
  } catch (err) {
    console.error("[Klines] Error fetching from binance:", err);
    return [];
  }
}

