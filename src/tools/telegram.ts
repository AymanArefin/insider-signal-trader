/**
 * Telegram tool — sends messages to a Telegram chat via the Bot API.
 *
 * Public API:
 *  sendApprovalMessage(env, rec, currentPrice?)  → void
 *  sendMessage(env, text)                        → void  (stub)
 *  sendTradeConfirmation(env, log)               → void  (stub)
 */

import { z } from "zod";
import type { Env, Recommendation, TradeLog, AlpacaPosition, PositionWithThesis } from "../types";

// ---------- Telegram API response schema ----------

/**
 * Telegram always returns `{ ok: true, result: … }` on success and
 * `{ ok: false, error_code: N, description: "…" }` on failure.
 * We only need to distinguish the two shapes to surface errors cleanly.
 */
const TelegramResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({
    ok: z.literal(false),
    error_code: z.number(),
    description: z.string(),
  }),
]);

// ---------- Helpers ----------

const TELEGRAM_API = "https://api.telegram.org";

/**
 * Escapes characters that Telegram Markdown v1 treats as formatting markers.
 * Applied to every piece of dynamic content embedded in the message so that
 * tickers, insider names, or reasoning text cannot accidentally break the layout.
 *
 * Markdown v1 special chars: * _ ` [
 */
function escapeMd(text: string): string {
  return text.replace(/([*_`[])/g, "\\$1");
}

function fmtUSD(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(2)}`;
}

const ACTION_EMOJI: Record<Recommendation["action"], string> = {
  BUY: "🟢",
  SELL: "🔴",
  HOLD: "🟡",
};

/**
 * Posts a JSON payload to a Telegram Bot API method.
 * Throws a descriptive Error on network failure, non-2xx HTTP, or
 * `{ ok: false }` in the Telegram response body.
 */
async function telegramPost(
  token: string,
  method: string,
  body: Record<string, unknown>
): Promise<void> {
  const url = `${TELEGRAM_API}/bot${token}/${method}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`Telegram network error — ${method}: ${String(err)}`);
  }

  let rawJson: unknown;
  try {
    rawJson = await res.json();
  } catch {
    throw new Error(
      `Telegram API returned non-JSON body — ${method} [HTTP ${res.status}]`
    );
  }

  // Surface Telegram errors whether they arrive as HTTP 4xx or ok:false in 200 body
  if (!res.ok) {
    const parsed = TelegramResponseSchema.safeParse(rawJson);
    const desc =
      parsed.success && !parsed.data.ok
        ? parsed.data.description
        : JSON.stringify(rawJson);
    throw new Error(
      `Telegram API HTTP ${res.status} on ${method}: ${desc}`
    );
  }

  const parsed = TelegramResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new Error(
      `Telegram API response shape unexpected — ${method}: ${parsed.error.message}`
    );
  }
  if (!parsed.data.ok) {
    throw new Error(
      `Telegram API error on ${method} [${parsed.data.error_code}]: ${parsed.data.description}`
    );
  }
}

// ---------- Public API ----------

/**
 * Sends a formatted insider-trade recommendation card to the configured
 * Telegram chat with ✅ Approve and ❌ Reject inline keyboard buttons.
 *
 * @param env           Worker environment (provides token, chat ID, base URL).
 * @param recommendation The PENDING recommendation to present for approval.
 * @param currentPrice  Optional latest market price for the ticker; included in
 *                      the card when supplied by the caller.
 *
 * @throws Error if `recommendation.id` is missing (card cannot be actioned without it).
 * @throws Error on any Telegram API failure, including Telegram's own error description.
 */
export async function sendApprovalMessage(
  env: Env,
  recommendation: Recommendation,
  currentPrice?: number
): Promise<void> {
  if (!recommendation.id) {
    throw new Error(
      "sendApprovalMessage: recommendation.id is required to build approval URLs " +
        "(call insertRecommendation before sending the card)"
    );
  }

  const approveUrl = `${env.APPROVAL_BASE_URL}/approve?id=${recommendation.id}`;
  const rejectUrl = `${env.APPROVAL_BASE_URL}/reject?id=${recommendation.id}`;

  const emoji = ACTION_EMOJI[recommendation.action];
  const ticker = escapeMd(recommendation.ticker);
  const reasoning = escapeMd(recommendation.reasoning);

  const priceLines = currentPrice !== undefined
    ? `*Current Price:* ${escapeMd(fmtUSD(currentPrice))}\n`
    : "";

  const stopLine = recommendation.stopPrice !== undefined
    ? `🛑 *Stop\\-Loss:* ${escapeMd(`$${recommendation.stopPrice.toFixed(2)}`)}`
    : null;

  const takeProfitLine = recommendation.takeProfitPrice !== undefined
    ? `🎯 *Take\\-Profit:* ${escapeMd(`$${recommendation.takeProfitPrice.toFixed(2)}`)}`
    : null;

  const expiryHours = Number(env.APPROVAL_EXPIRY_HOURS) || 23;

  const text = [
    `🚨 *INSIDER TRADE SIGNAL*`,
    ``,
    `${emoji} *Action:* ${recommendation.action}`,
    `*Ticker:* $${ticker}`,
    `*Notional:* ${escapeMd(fmtUSD(recommendation.notional))}`,
    priceLines.length ? priceLines.trimEnd() : null,
    stopLine,
    takeProfitLine,
    ``,
    `📋 *Agent Reasoning:*`,
    reasoning,
    ``,
    `\`Recommendation ID: ${recommendation.id}\``,
    `_Expires in ${expiryHours}h — approve or it auto-expires._`,
  ]
    .filter((line) => line !== null)
    .join("\n");

  await telegramPost(env.TELEGRAM_BOT_TOKEN, "sendMessage", {
    chat_id: env.TELEGRAM_CHAT_ID,
    parse_mode: "Markdown",
    text,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Approve", url: approveUrl },
          { text: "❌ Reject", url: rejectUrl },
        ],
      ],
    },
  });
}

// ---------- Public API (continued) ----------

/**
 * Sends a plain-text (or Markdown) message to the configured Telegram chat,
 * or to a specific `chatId` when responding to an incoming user message.
 */
export async function sendMessage(
  env: Env,
  text: string,
  chatId?: string
): Promise<void> {
  await telegramPost(env.TELEGRAM_BOT_TOKEN, "sendMessage", {
    chat_id: chatId ?? env.TELEGRAM_CHAT_ID,
    parse_mode: "Markdown",
    text,
  });
}

/**
 * Sends a formatted Alpaca paper-account portfolio summary to Telegram.
 * Shows total net worth, cash, buying power, and a per-position breakdown
 * with current prices and unrealized P/L where available.
 *
 * @param env       Worker environment.
 * @param account   Account snapshot from getAccount().
 * @param positions Open positions from getPortfolio().
 * @param prices    Latest prices from getPositionPrices() (keyed by symbol).
 * @param chatId    Optional override for the destination chat (e.g. the user
 *                  who sent the query); defaults to env.TELEGRAM_CHAT_ID.
 */
export async function sendPortfolioSummary(
  env: Env,
  account: { portfolio_value: number; cash: number; buying_power: number },
  positions: AlpacaPosition[],
  prices: Record<string, number>,
  chatId?: string,
  theses?: PositionWithThesis[]
): Promise<void> {
  // Build a ticker → thesis lookup for stop/limit display
  const thesisByTicker = new Map<string, PositionWithThesis>();
  for (const t of theses ?? []) {
    if (!thesisByTicker.has(t.ticker)) thesisByTicker.set(t.ticker, t);
  }

  const lines: string[] = [
    `💼 *PAPER ACCOUNT SUMMARY*`,
    ``,
    `💰 *Net Worth:* ${escapeMd(fmtUSD(account.portfolio_value))}`,
    `💵 *Cash:* ${escapeMd(fmtUSD(account.cash))}`,
    `⚡ *Buying Power:* ${escapeMd(fmtUSD(account.buying_power))}`,
  ];

  if (positions.length === 0) {
    lines.push(``, `📊 *Positions:* _(none — account is flat)_`);
  } else {
    lines.push(``, `📊 *Open Positions (${positions.length}):*`, ``);

    let totalPL = 0;

    for (const p of positions) {
      const pl = parseFloat(p.unrealized_pl);
      const plPct = (parseFloat(p.unrealized_plpc) * 100).toFixed(2);
      const mktVal = parseFloat(p.market_value);
      const entryPrice = parseFloat(p.avg_entry_price);
      const currentPrice = prices[p.symbol];
      const plSign = pl >= 0 ? "+" : "-";
      totalPL += pl;

      const priceStr =
        currentPrice !== undefined
          ? `$${entryPrice.toFixed(2)} → $${currentPrice.toFixed(2)}`
          : `$${entryPrice.toFixed(2)}`;

      lines.push(
        `*${escapeMd(p.symbol)}* ${escapeMd(p.side.toUpperCase())} × ${escapeMd(p.qty)} shares`,
        `  Entry: ${escapeMd(priceStr)}  \\|  Value: ${escapeMd(fmtUSD(mktVal))}`,
        `  P/L: ${escapeMd(`${plSign}${fmtUSD(Math.abs(pl))} (${plSign}${plPct}%)`)}`,
      );

      const thesis = thesisByTicker.get(p.symbol);
      if (thesis?.stopPrice !== undefined || thesis?.takeProfitPrice !== undefined) {
        const stopStr = thesis.stopPrice !== undefined
          ? `🛑 Stop: $${thesis.stopPrice.toFixed(2)}`
          : null;
        const targetStr = thesis.takeProfitPrice !== undefined
          ? `🎯 Target: $${thesis.takeProfitPrice.toFixed(2)}`
          : null;
        const bracketParts = [stopStr, targetStr].filter(Boolean).join("  \\|  ");
        lines.push(`  ${escapeMd(bracketParts)}`);
      }

      lines.push(``);
    }

    const totalPLSign = totalPL >= 0 ? "+" : "-";
    lines.push(
      `💹 *Total Unrealized P/L:* ${escapeMd(`${totalPLSign}${fmtUSD(Math.abs(totalPL))}`)}`
    );
  }

  const timestamp = new Date().toUTCString();
  lines.push(``, `_Updated: ${escapeMd(timestamp)}_`);

  await telegramPost(env.TELEGRAM_BOT_TOKEN, "sendMessage", {
    chat_id: chatId ?? env.TELEGRAM_CHAT_ID,
    parse_mode: "Markdown",
    text: lines.join("\n"),
  });
}

// ---------- Stubs (not yet implemented) ----------

export async function sendTradeConfirmation(_env: Env, _log: TradeLog): Promise<void> {
  // TODO: format and send order execution summary
}
