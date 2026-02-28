/**
 * Smoke-test for sendApprovalMessage().
 *
 * Sends a realistic mock approval card to the configured Telegram chat.
 * Check the chat to confirm the message arrives with the correct formatting
 * and that the ✅ Approve / ❌ Reject buttons render inline keyboard buttons.
 *
 * No real trade is executed — the approval URLs point to APPROVAL_BASE_URL
 * which is typically http://localhost:8787 in local dev (or your Worker URL).
 *
 * Usage:
 *   npx tsx scripts/test-telegram.ts
 *   npm run test:telegram
 *
 * Options (env vars):
 *   TEST_TICKER      Override the ticker symbol  (default: NVDA)
 *   TEST_ACTION      Override action BUY|SELL     (default: BUY)
 */

import { sendApprovalMessage, sendPortfolioSummary } from "../src/tools/telegram";
import { getAccount, getPortfolio, getPositionPrices } from "../src/tools/alpaca";
import { loadEnv } from "./lib/loadEnv";
import type { Recommendation } from "../src/types";

function hr(char = "─", width = 60) {
  return char.repeat(width);
}

async function main() {
  const env = loadEnv();

  const ticker = process.env.TEST_TICKER ?? "NVDA";
  const action = (process.env.TEST_ACTION as "BUY" | "SELL" | "HOLD") ?? "BUY";

  // Telegram rejects localhost URLs in inline keyboard buttons (HTTP 400).
  // When running locally, substitute a placeholder https URL so the card still
  // renders with working buttons — they won't hit a real server, but the shape is valid.
  const isLocalhost = env.APPROVAL_BASE_URL.startsWith("http://localhost") ||
    env.APPROVAL_BASE_URL.startsWith("http://127.");
  if (isLocalhost) {
    env.APPROVAL_BASE_URL = "https://insider-signal-trader.example.workers.dev";
  }

  console.log(hr("═"));
  console.log("  test-telegram — sendApprovalMessage()");
  console.log(hr("═"));
  console.log(`  bot token : …${env.TELEGRAM_BOT_TOKEN.slice(-6)}`);
  console.log(`  chat ID   : ${env.TELEGRAM_CHAT_ID}`);
  console.log(`  ticker    : ${ticker}  action: ${action}`);
  console.log(`  base URL  : ${env.APPROVAL_BASE_URL}${isLocalhost ? "  (overridden from localhost)" : ""}\n`);

  // Build a realistic mock recommendation.
  // The UUID is generated here (normally done by insertRecommendation in D1).
  const mockId = crypto.randomUUID();

  const mockRec: Recommendation = {
    id: mockId,
    ticker,
    action,
    reasoning: [
      `⚠️ TEST CARD — buttons are non-functional (UUID not in D1). Use \`npm run test:approval\` for a live end-to-end test.`,
      ``,
      `Three insiders at ${ticker} made open-market purchases totalling $2.1M over the last 4 trading days — CEO Jane Doe ($1.5M), Director Alice Smith ($400K), and Director Bob Jones ($200K).`,
      ``,
      `Historical pattern: the last two cluster-buy events at this company preceded 15–25% price appreciation within 90 days.`,
      ``,
      `Fundamental backdrop: Q4 earnings beat by 18%, gross margin expanded 320bps YoY. Analyst consensus is Buy with a $165 PT vs current $142.`,
      ``,
      `Risk: broad market is near resistance, upcoming FOMC meeting could create short-term volatility.`,
      ``,
      `Recommendation: ${action} $10,000 notional. Position size is within the 2% portfolio risk limit. Stop-loss at $128 (10% drawdown from entry).`,
    ].join("\n"),
    signalId: 1,
    status: "PENDING",
    notional: 10_000,
    createdAt: new Date().toISOString(),
  };

  const currentPrice = 142.37;

  console.log(hr());
  console.log(`  Sending card for recommendation ${mockId.slice(0, 8)}…`);
  console.log(hr());

  const start = Date.now();
  try {
    await sendApprovalMessage(env, mockRec, currentPrice);
    const elapsed = Date.now() - start;
    console.log(`\n  \x1b[32m✓\x1b[0m Message sent successfully in ${elapsed} ms`);
  console.log(`\n  Check your Telegram chat for the approval card.`);
  console.log(`\n  \x1b[33m⚠  TEST MESSAGE — do not tap the buttons.\x1b[0m`);
  console.log(`  This UUID was never written to D1. Tapping Approve will return`);
  console.log(`  "Recommendation not found." — that is expected for test cards.`);
  console.log(`\n  The buttons link to (for reference only):`);
  console.log(`    ✅ Approve: ${env.APPROVAL_BASE_URL}/approve?id=${mockId}`);
  console.log(`    ❌ Reject : ${env.APPROVAL_BASE_URL}/reject?id=${mockId}`);
  } catch (err) {
    const elapsed = Date.now() - start;
    console.error(`\n  \x1b[31m✗\x1b[0m sendApprovalMessage() failed after ${elapsed} ms:`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    console.error(`\n  Common causes:`);
    console.error(`    • TELEGRAM_BOT_TOKEN is invalid or the bot hasn't been started`);
    console.error(`    • TELEGRAM_CHAT_ID is wrong — open the bot and send /start first`);
    console.error(`    • The bot doesn't have permission to message that chat/group`);
    process.exit(1);
  }

  // ── Bonus: verify the bot identity ──────────────────────────────────────
  console.log(`\n${hr()}`);
  console.log("  Verifying bot identity via getMe:");
  console.log(hr());

  try {
    const meRes = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`
    );
    const me = await meRes.json() as { ok: boolean; result?: { username: string; first_name: string; id: number } };
    if (me.ok && me.result) {
      console.log(`  \x1b[32m✓\x1b[0m Bot: @${me.result.username} (${me.result.first_name}, id=${me.result.id})`);
    } else {
      console.log(`  (getMe returned ok=false — token may be partially invalid)`);
    }
  } catch {
    console.log("  (Could not reach getMe — skipping identity check)");
  }

  // ── Step 3: sendPortfolioSummary() with live Alpaca data ────────────────
  console.log(`\n${hr()}`);
  console.log("  Step 3: sendPortfolioSummary() — live Alpaca paper account");
  console.log(hr());

  try {
    console.log("  Fetching account info and positions from Alpaca…");
    const [account, positions] = await Promise.all([
      getAccount(env),
      getPortfolio(env),
    ]);
    console.log(`  ✓ Net worth: $${account.portfolio_value.toLocaleString(undefined, { minimumFractionDigits: 2 })}`);
    console.log(`  ✓ Cash: $${account.cash.toLocaleString(undefined, { minimumFractionDigits: 2 })}`);
    console.log(`  ✓ Buying power: $${account.buying_power.toLocaleString(undefined, { minimumFractionDigits: 2 })}`);
    console.log(`  ✓ Open positions: ${positions.length}`);

    const symbols = positions.map((p) => p.symbol);
    const prices = symbols.length > 0 ? await getPositionPrices(env, symbols) : {};
    if (symbols.length > 0) {
      console.log(`  ✓ Live prices fetched for: ${Object.keys(prices).join(", ")}`);
    }

    const sendStart = Date.now();
    await sendPortfolioSummary(env, account, positions, prices);
    console.log(`\n  \x1b[32m✓\x1b[0m Portfolio summary sent in ${Date.now() - sendStart} ms`);
    console.log(`  Check your Telegram chat for the account summary.`);
  } catch (err) {
    console.error(`\n  \x1b[31m✗\x1b[0m sendPortfolioSummary() failed:`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  console.log(`\n${hr("═")}`);
  console.log("  Done.");
  console.log(hr("═"));
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
