/**
 * Alpaca tool — typed wrapper around the Alpaca Markets REST API v2.
 *
 * All functions accept `env: Env` as their first argument so they can be called
 * from any Worker context without a global singleton.
 *
 * Public API:
 *  getPortfolio(env)                         → AlpacaPosition[]
 *  getPositionPrices(env, symbols)           → Record<string, number>
 *  getBuyingPower(env)                       → number
 *  paperBuy(env, symbol, notional)           → AlpacaOrder
 *  paperSell(env, symbol, qty)              → AlpacaOrder
 *
 * Internal stubs (not yet implemented):
 *  getPosition, closePosition, getOrder
 */

import { z } from "zod";
import type { AlpacaOrder, AlpacaPosition, Env } from "../types";

// ---------- Zod schemas ----------

const AlpacaPositionSchema = z.object({
  symbol: z.string(),
  qty: z.string(),
  side: z.enum(["long", "short"]),
  market_value: z.string(),
  avg_entry_price: z.string(),
  unrealized_pl: z.string(),
  unrealized_plpc: z.string(),
});

const AlpacaOrderSchema = z.object({
  id: z.string(),
  client_order_id: z.string(),
  symbol: z.string(),
  side: z.enum(["buy", "sell"]),
  type: z.string(),
  /**
   * Alpaca returns null for qty on notional orders (and until the order fills).
   * Our AlpacaOrder interface reflects this with `qty: string | null`.
   */
  qty: z.string().nullable(),
  notional: z.string().nullable(),
  status: z.string(),
  filled_avg_price: z.string().nullable(),
  filled_qty: z.string().nullable(),
  created_at: z.string(),
});

/**
 * Single-symbol snapshot shape from the Alpaca Data API.
 * We only care about the price fields; `.passthrough()` ignores the rest.
 */
const SnapshotSchema = z
  .object({
    latestTrade: z.object({ p: z.number() }).optional(),
    minuteBar: z.object({ c: z.number() }).optional(),
    dailyBar: z.object({ c: z.number() }).optional(),
  })
  .passthrough();

const SnapshotsResponseSchema = z.record(z.string(), SnapshotSchema);

/**
 * Relevant fields from GET /v2/account.
 * `buying_power` is the USD amount available for new orders.
 * `.passthrough()` ignores the many other fields in the response.
 */
const AccountSchema = z
  .object({
    buying_power: z.string(),
    cash: z.string(),
    portfolio_value: z.string(),
    status: z.string(),
  })
  .passthrough();

// ---------- Core fetch helper ----------

/**
 * Attaches Alpaca auth headers, executes the request, and validates the
 * response body against `schema`.
 *
 * Throws a descriptive Error on:
 *  - Network / DNS failure
 *  - Non-2xx HTTP status (includes the response body for context)
 *  - Non-JSON response body
 *  - Zod schema mismatch
 */
async function alpacaFetch<S extends z.ZodTypeAny>(
  env: Env,
  url: string,
  schema: S,
  init?: RequestInit
): Promise<z.infer<S>> {
  const headers: Record<string, string> = {
    "APCA-API-KEY-ID": env.ALPACA_API_KEY,
    "APCA-API-SECRET-KEY": env.ALPACA_SECRET_KEY,
  };

  // Only set Content-Type for requests that carry a body
  if (init?.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
    });
  } catch (err) {
    throw new Error(`Alpaca network error — ${url}: ${String(err)}`);
  }

  if (!res.ok) {
    let errBody = "";
    try {
      errBody = await res.text();
    } catch {
      // swallow — a read error here shouldn't hide the HTTP error
    }
    throw new Error(
      `Alpaca API HTTP ${res.status} ${res.statusText} — ${url}` +
        (errBody ? `\n${errBody}` : "")
    );
  }

  let rawJson: unknown;
  try {
    rawJson = await res.json();
  } catch {
    throw new Error(`Alpaca API returned non-JSON body — ${url}`);
  }

  const parsed = schema.safeParse(rawJson);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i: z.ZodIssue) => `[${i.path.join(".")}] ${i.message}`)
      .join("; ");
    throw new Error(`Alpaca API response shape mismatch — ${url}: ${issues}`);
  }

  return parsed.data as z.infer<S>;
}

// ---------- Public API ----------

/**
 * Returns all currently open positions in the paper-trading account.
 * Maps to GET {ALPACA_BASE_URL}/v2/positions.
 */
export async function getPortfolio(env: Env): Promise<AlpacaPosition[]> {
  return alpacaFetch(
    env,
    `${env.ALPACA_BASE_URL}/v2/positions`,
    z.array(AlpacaPositionSchema)
  );
}

/**
 * Returns the latest market price for each requested symbol.
 * Uses the Alpaca Data API snapshots endpoint with a price fallback chain:
 *   latestTrade.p → minuteBar.c → dailyBar.c
 *
 * Symbols with no snapshot data are omitted from the result map rather than
 * returning a zero or NaN, so callers should check for key presence.
 *
 * Maps to GET {ALPACA_DATA_URL}/v2/stocks/snapshots?symbols=...
 */
export async function getPositionPrices(
  env: Env,
  symbols: string[]
): Promise<Record<string, number>> {
  if (symbols.length === 0) return {};

  const url =
    `${env.ALPACA_DATA_URL}/v2/stocks/snapshots` +
    `?symbols=${symbols.map(encodeURIComponent).join(",")}`;

  const snapshots = await alpacaFetch(env, url, SnapshotsResponseSchema);

  const prices: Record<string, number> = {};
  for (const [symbol, snap] of Object.entries(snapshots)) {
    const price = snap.latestTrade?.p ?? snap.minuteBar?.c ?? snap.dailyBar?.c;
    if (price !== undefined) prices[symbol] = price;
  }
  return prices;
}

/**
 * Returns the current buying power (available cash for new orders) from the
 * paper-trading account. Maps to GET {ALPACA_BASE_URL}/v2/account.
 *
 * Alpaca returns buying_power as a decimal string; we parse it to a number.
 * For a margin account this is typically 2× cash; for a non-margin paper
 * account it equals the cash balance.
 */
export async function getBuyingPower(env: Env): Promise<number> {
  const account = await alpacaFetch(
    env,
    `${env.ALPACA_BASE_URL}/v2/account`,
    AccountSchema
  );
  return parseFloat(account.buying_power);
}

/**
 * Returns a structured snapshot of the paper-trading account, including
 * total net worth (portfolio_value), cash balance, buying power, and status.
 * Maps to GET {ALPACA_BASE_URL}/v2/account.
 */
export async function getAccount(env: Env): Promise<{
  portfolio_value: number;
  cash: number;
  buying_power: number;
  status: string;
}> {
  const account = await alpacaFetch(
    env,
    `${env.ALPACA_BASE_URL}/v2/account`,
    AccountSchema
  );
  return {
    portfolio_value: parseFloat(account.portfolio_value),
    cash: parseFloat(account.cash),
    buying_power: parseFloat(account.buying_power),
    status: account.status,
  };
}

/**
 * Submits a notional market-buy order on the paper account.
 * Only works for fractionable stocks — prefer paperBuyQty for non-fractionable assets.
 * `notional` is the dollar amount to spend (e.g. 10000 → $10,000).
 *
 * Maps to POST {ALPACA_BASE_URL}/v2/orders
 */
export async function paperBuy(
  env: Env,
  symbol: string,
  notional: number
): Promise<AlpacaOrder> {
  return alpacaFetch(
    env,
    `${env.ALPACA_BASE_URL}/v2/orders`,
    AlpacaOrderSchema,
    {
      method: "POST",
      body: JSON.stringify({
        symbol,
        notional: notional.toFixed(2),
        side: "buy",
        type: "market",
        time_in_force: "day",
      }),
    }
  );
}

/**
 * Submits a whole-share market-buy order on the paper account.
 * Works for both fractionable and non-fractionable stocks.
 * `qty` must be a positive integer.
 *
 * Maps to POST {ALPACA_BASE_URL}/v2/orders
 */
export async function paperBuyQty(
  env: Env,
  symbol: string,
  qty: number
): Promise<AlpacaOrder> {
  return alpacaFetch(
    env,
    `${env.ALPACA_BASE_URL}/v2/orders`,
    AlpacaOrderSchema,
    {
      method: "POST",
      body: JSON.stringify({
        symbol,
        qty: String(Math.floor(qty)),
        side: "buy",
        type: "market",
        time_in_force: "day",
      }),
    }
  );
}

/**
 * Submits a bracket market-buy order on the paper account.
 * Bracket orders attach an OCO (one-cancels-other) pair to the market entry:
 *   - take_profit.limit_price  — auto-sells when price rises to target
 *   - stop_loss.stop_price     — auto-sells when price falls to floor
 *
 * Bracket orders require qty (shares), not notional. The caller must convert
 * notional → qty using the current market price before calling this function.
 * time_in_force is "gtc" (good till cancelled) so the OCO legs persist after
 * the entry fills.
 *
 * Maps to POST {ALPACA_BASE_URL}/v2/orders
 */
export async function paperBuyBracket(
  env: Env,
  symbol: string,
  qty: number,
  stopPrice: number,
  takeProfitPrice: number
): Promise<AlpacaOrder> {
  return alpacaFetch(
    env,
    `${env.ALPACA_BASE_URL}/v2/orders`,
    AlpacaOrderSchema,
    {
      method: "POST",
      body: JSON.stringify({
        symbol,
        qty: String(Math.floor(qty)),
        side: "buy",
        type: "market",
        time_in_force: "gtc",
        order_class: "bracket",
        take_profit: {
          limit_price: takeProfitPrice.toFixed(2),
        },
        stop_loss: {
          stop_price: stopPrice.toFixed(2),
        },
      }),
    }
  );
}

/**
 * Submits a quantity-based market-sell order on the paper account.
 * `qty` is the number of shares to sell.
 * Alpaca requires qty as a string in the request body.
 *
 * Maps to POST {ALPACA_BASE_URL}/v2/orders
 */
export async function paperSell(
  env: Env,
  symbol: string,
  qty: number
): Promise<AlpacaOrder> {
  return alpacaFetch(
    env,
    `${env.ALPACA_BASE_URL}/v2/orders`,
    AlpacaOrderSchema,
    {
      method: "POST",
      body: JSON.stringify({
        symbol,
        qty: String(qty),
        side: "sell",
        type: "market",
        time_in_force: "day",
      }),
    }
  );
}

/**
 * Returns open (or all) orders from the paper-trading account.
 * Maps to GET {ALPACA_BASE_URL}/v2/orders?status=<status>&limit=<limit>.
 *
 * Useful for verifying that an order was submitted even when the market is
 * closed and the order has not yet filled (so it won't appear in positions).
 */
export async function getOrders(
  env: Env,
  status: "open" | "closed" | "all" = "open",
  limit = 50
): Promise<AlpacaOrder[]> {
  const url = `${env.ALPACA_BASE_URL}/v2/orders?status=${status}&limit=${limit}`;
  return alpacaFetch(env, url, z.array(AlpacaOrderSchema));
}

// ---------- Stubs (not yet implemented) ----------

export async function getPosition(_env: Env, _ticker: string): Promise<AlpacaPosition | null> {
  // TODO: GET /v2/positions/:ticker — returns null on 404
  return null;
}

export async function closePosition(_env: Env, _ticker: string): Promise<AlpacaOrder> {
  // TODO: DELETE /v2/positions/:ticker
  throw new Error("closePosition — not yet implemented");
}

export async function getOrder(_env: Env, _orderId: string): Promise<AlpacaOrder> {
  // TODO: GET /v2/orders/:orderId
  throw new Error("getOrder — not yet implemented");
}
