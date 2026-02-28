/**
 * Approval route handler — processes human-in-the-loop approve/reject actions
 * arriving via Telegram inline-button deep-links.
 *
 * Routes:
 *  GET /approve?id=<uuid>  — validate → execute trade → log → mark APPROVED
 *  GET /reject?id=<uuid>   — validate → mark REJECTED
 *
 * Both routes perform the same three validations before branching:
 *  1. `id` query parameter is present.
 *  2. Recommendation exists in D1.
 *  3. Recommendation status is PENDING (not already resolved).
 *  4. Recommendation has not exceeded APPROVAL_EXPIRY_HOURS (approve only).
 */

import type { AlpacaOrder, Env, Recommendation, TradeLog } from "../types";
import {
  getRecommendation,
  logTrade,
  updateRecommendationStatus,
} from "../tools/db";
import { getPortfolio, getPositionPrices, paperBuy, paperBuyBracket, paperBuyQty, paperSell } from "../tools/alpaca";

// ---------- Tiny response helpers ----------

function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

// ---------- Shared validation ----------

/** Milliseconds in one hour */
const MS_PER_HOUR = 3_600_000;

interface ValidationResult {
  rec: Recommendation;
  /** Pre-computed ISO string for the resolved_at column */
  resolvedAt: string;
}

/**
 * Looks up a recommendation by ID, checks it exists, and verifies it is still
 * PENDING.  The caller passes `checkExpiry: true` for the approve path so that
 * stale approvals are caught and stored before returning an error.
 */
async function validatePending(
  env: Env,
  id: string,
  checkExpiry: boolean
): Promise<ValidationResult | Response> {
  const rec = await getRecommendation(env.DB, id);

  if (!rec) {
    return text(`Recommendation "${id}" not found.`, 400);
  }

  if (rec.status !== "PENDING") {
    return text(
      `Recommendation is already ${rec.status.toLowerCase()} and cannot be actioned again.`,
      400
    );
  }

  const resolvedAt = new Date().toISOString();

  if (checkExpiry && rec.createdAt) {
    const expiryHours = Number(env.APPROVAL_EXPIRY_HOURS) || 23;
    const ageMs = Date.now() - Date.parse(rec.createdAt);
    if (ageMs >= expiryHours * MS_PER_HOUR) {
      // Persist the expiry so the scheduler doesn't double-write
      await updateRecommendationStatus(
        env.DB,
        id,
        "EXPIRED",
        resolvedAt
      ).catch((err) =>
        console.error(`[approval] Could not mark ${id} as EXPIRED: ${String(err)}`)
      );
      return text(
        `This recommendation expired after ${expiryHours} hours and can no longer be approved.`,
        400
      );
    }
  }

  return { rec, resolvedAt };
}

// ---------- Order → TradeLog mapper ----------

/**
 * Builds a TradeLog from an Alpaca order response.
 *
 * Market orders are usually filled immediately on the paper account, but
 * `filled_avg_price` and `filled_qty` can be null in the immediate response
 * if the order is still pending ACK.  We fall back to reasonable proxies so
 * the DB row is always written — a follow-up polling step can update prices.
 */
function orderToTradeLog(
  order: AlpacaOrder,
  rec: Recommendation
): TradeLog {
  const side: TradeLog["side"] = rec.action === "BUY" ? "long" : "short";

  // Prefer filled values; fall back to the order's requested values
  const filledPrice = order.filled_avg_price
    ? parseFloat(order.filled_avg_price)
    : 0;

  const filledQty =
    order.filled_qty
      ? parseFloat(order.filled_qty)
      : order.qty
        ? parseFloat(order.qty)
        : 0;

  const effectiveNotional =
    filledPrice > 0 && filledQty > 0
      ? filledPrice * filledQty
      : rec.notional;

  return {
    ticker: rec.ticker,
    side,
    qty: filledQty,
    price: filledPrice,
    notional: effectiveNotional,
    alpacaOrderId: order.id,
    recommendationId: rec.id!,
  };
}

// ---------- Route handlers ----------

async function handleApprove(
  id: string,
  env: Env
): Promise<Response> {
  // ── 1–4: Validate ──────────────────────────────────────────────────────────
  const validated = await validatePending(env, id, /* checkExpiry */ true);
  if (validated instanceof Response) return validated;
  const { rec, resolvedAt } = validated;

  if (rec.action === "HOLD") {
    return text("HOLD recommendations cannot be executed as trades.", 400);
  }

  // ── 5: Submit order to Alpaca ──────────────────────────────────────────────
  let order: AlpacaOrder;
  try {
    if (rec.action === "BUY") {
      // Always fetch the current price — needed for:
      //  a) bracket order qty conversion
      //  b) non-fractionable stocks (Alpaca rejects notional orders with 403)
      const prices = await getPositionPrices(env, [rec.ticker]);
      const currentPrice = prices[rec.ticker];
      if (!currentPrice) {
        return text(
          `Cannot place order for ${rec.ticker}: current price unavailable. Please retry.`,
          500
        );
      }

      const wholeQty = Math.floor(rec.notional / currentPrice);
      if (wholeQty < 1) {
        return text(
          `Notional $${rec.notional} is too small to buy 1 share of ${rec.ticker} at $${currentPrice.toFixed(2)}.`,
          400
        );
      }

      if (rec.stopPrice !== undefined && rec.takeProfitPrice !== undefined) {
        // Validate bracket levels against the live price before submitting.
        const bracketValid =
          rec.stopPrice < currentPrice &&
          rec.takeProfitPrice > currentPrice;

        if (bracketValid) {
          order = await paperBuyBracket(env, rec.ticker, wholeQty, rec.stopPrice, rec.takeProfitPrice);
        } else {
          const reason = rec.stopPrice >= currentPrice
            ? `stop $${rec.stopPrice} >= current $${currentPrice.toFixed(2)}`
            : `take-profit $${rec.takeProfitPrice} <= current $${currentPrice.toFixed(2)}`;
          console.warn(
            `[approval] Bracket levels invalid for ${rec.ticker} (${reason}) — placing plain market buy`
          );
          order = await paperBuyQty(env, rec.ticker, wholeQty);
        }
      } else {
        // No bracket levels — plain whole-share market buy (works for all stocks)
        order = await paperBuyQty(env, rec.ticker, wholeQty);
      }
    } else {
      // SELL: resolve the current held quantity from the live portfolio
      const positions = await getPortfolio(env);
      const position = positions.find((p) => p.symbol === rec.ticker);

      if (!position) {
        return text(
          `Cannot sell ${rec.ticker}: no open position found in the portfolio.`,
          400
        );
      }

      const qty = parseFloat(position.qty);
      order = await paperSell(env, rec.ticker, qty);
    }
  } catch (err) {
    console.error(`[approval] Order submission failed for ${id}: ${String(err)}`);
    return text(
      `Order submission failed: ${err instanceof Error ? err.message : String(err)}`,
      500
    );
  }

  console.log(
    `[approval] Order submitted — ${rec.action} ${rec.ticker}` +
      ` alpacaOrderId=${order.id} status=${order.status}`
  );

  // ── 6: Write position record to D1 ────────────────────────────────────────
  try {
    await logTrade(env.DB, orderToTradeLog(order, rec));
  } catch (err) {
    // Non-fatal: order is placed; log the DB failure and continue
    console.error(
      `[approval] logTrade failed for order ${order.id}: ${String(err)}`
    );
  }

  // ── 7: Transition recommendation to APPROVED ──────────────────────────────
  try {
    await updateRecommendationStatus(env.DB, id, "APPROVED", resolvedAt);
  } catch (err) {
    console.error(
      `[approval] Could not mark ${id} as APPROVED: ${String(err)}`
    );
  }

  return text(`Trade executed: ${rec.action} ${rec.ticker}`);
}

async function handleReject(
  id: string,
  env: Env
): Promise<Response> {
  // ── 1–3: Validate ──────────────────────────────────────────────────────────
  const validated = await validatePending(env, id, /* checkExpiry */ false);
  if (validated instanceof Response) return validated;
  const { resolvedAt } = validated;

  // ── 4: Transition recommendation to REJECTED ──────────────────────────────
  try {
    await updateRecommendationStatus(env.DB, id, "REJECTED", resolvedAt);
  } catch (err) {
    console.error(
      `[approval] Could not mark ${id} as REJECTED: ${String(err)}`
    );
    return text(
      `Failed to record rejection: ${err instanceof Error ? err.message : String(err)}`,
      500
    );
  }

  return text("Recommendation rejected.");
}

// ---------- Public entry point ----------

export async function handleApproval(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");

  if (!id || id.trim() === "") {
    return text("Missing required query parameter: id", 400);
  }

  if (url.pathname.startsWith("/approve")) {
    return handleApprove(id.trim(), env);
  }

  if (url.pathname.startsWith("/reject")) {
    return handleReject(id.trim(), env);
  }

  return text("Not found", 404);
}
