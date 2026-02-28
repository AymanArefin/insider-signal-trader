/**
 * Live end-to-end flow test — Telegram card → tap Approve → Alpaca order
 *
 * What this does:
 *  1. Fetches the current price for TEST_TICKER from Alpaca.
 *  2. Seeds a real signal + PENDING recommendation into remote D1.
 *  3. Sends a Telegram approval card with the *real* UUID (buttons are live).
 *  4. Waits up to POLL_TIMEOUT_MS for you to tap ✅ Approve in Telegram.
 *  5. Polls Alpaca for a new BUY order and prints the result when found.
 *
 * This proves that tapping the Telegram button actually reaches the live
 * Worker and submits the order to Alpaca — no manual curl needed.
 *
 * Usage:
 *   npx tsx scripts/test-live-flow.ts
 *   npm run test:live
 *
 * Options (env vars):
 *   TEST_TICKER   Override the ticker symbol   (default: AAPL)
 *   TEST_NOTIONAL Override the order size      (default: 500)
 */

import { execSync } from "child_process";
import { getOrders, getPositionPrices } from "../src/tools/alpaca";
import { sendApprovalMessage } from "../src/tools/telegram";
import { loadEnv } from "./lib/loadEnv";
import type { Recommendation } from "../src/types";

const DB_NAME = "insider-trader";
const TEST_TICKER = process.env.TEST_TICKER ?? "AAPL";
const TEST_NOTIONAL = Number(process.env.TEST_NOTIONAL ?? "500");
const STOP_PCT = 0.08;
const TARGET_PCT = 0.15;

/** How long to wait for you to tap Approve before giving up (ms). */
const POLL_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
const POLL_INTERVAL_MS = 5_000;         // check Alpaca every 5 s

function hr(char = "─", width = 60) {
  return char.repeat(width);
}

function d1(sql: string): unknown[] {
  const raw = execSync(
    `npx wrangler d1 execute ${DB_NAME} --remote --command ${JSON.stringify(sql)} --json`,
    { cwd: process.cwd(), encoding: "utf-8", env: process.env }
  );
  return JSON.parse(raw) as unknown[];
}

/** Snapshot of open BUY orders for TEST_TICKER before we send the card. */
async function getExistingOrderIds(env: ReturnType<typeof loadEnv>): Promise<Set<string>> {
  const orders = await getOrders(env, "open");
  return new Set(
    orders.filter((o) => o.symbol === TEST_TICKER && o.side === "buy").map((o) => o.id)
  );
}

async function main() {
  const env = loadEnv();

  console.log(hr("═"));
  console.log("  test-live-flow — Telegram card with real approval buttons");
  console.log(hr("═"));

  // ── Step 0: Current price ────────────────────────────────────────────────
  const prices = await getPositionPrices(env, [TEST_TICKER]);
  const currentPrice = prices[TEST_TICKER];
  if (!currentPrice) {
    console.error(`  ✗ Could not fetch current price for ${TEST_TICKER}`);
    process.exit(1);
  }
  const stopPrice = parseFloat((currentPrice * (1 - STOP_PCT)).toFixed(2));
  const takeProfitPrice = parseFloat((currentPrice * (1 + TARGET_PCT)).toFixed(2));

  console.log(`  Ticker        : ${TEST_TICKER}  notional: $${TEST_NOTIONAL}`);
  console.log(`  Current Price : $${currentPrice.toFixed(2)}`);
  console.log(`  Stop-Loss     : $${stopPrice}  (−${(STOP_PCT * 100).toFixed(0)}%)`);
  console.log(`  Take-Profit   : $${takeProfitPrice}  (+${(TARGET_PCT * 100).toFixed(0)}%)\n`);

  // Snapshot existing orders so we can detect the new one after approval.
  const existingIds = await getExistingOrderIds(env);

  // ── Step 1: Seed signal ──────────────────────────────────────────────────
  console.log(hr());
  console.log("  Step 1: Insert mock signal into D1 (remote)");
  console.log(hr());

  const today = new Date().toISOString().slice(0, 10);
  d1(
    `INSERT INTO signals (ticker, insider_name, insider_role, transaction_date, transaction_value, score, raw_filing) ` +
    `VALUES ('${TEST_TICKER}', '[LIVE TEST] Smoke Test', 'CEO', '${today}', 1000000, 80, '{}')`
  );

  const idRows = d1(`SELECT last_insert_rowid() AS signal_id`) as Array<{
    results: Array<{ signal_id: number }>;
  }>;
  const signalId = idRows[0]?.results?.[0]?.signal_id;
  if (!signalId) {
    console.error("  ✗ Could not retrieve signal_id after insert");
    process.exit(1);
  }
  console.log(`  ✓ Signal inserted  signal_id=${signalId}`);

  // ── Step 2: Seed PENDING recommendation ──────────────────────────────────
  console.log(`\n${hr()}`);
  console.log("  Step 2: Insert PENDING recommendation into D1 (remote)");
  console.log(hr());

  const recId = crypto.randomUUID();
  d1(
    `INSERT INTO recommendations (id, ticker, action, reasoning, signal_id, status, notional, stop_price, take_profit_price) ` +
    `VALUES ('${recId}', '${TEST_TICKER}', 'BUY', '[LIVE TEST] tap Approve to place real paper order', ${signalId}, 'PENDING', ${TEST_NOTIONAL}, ${stopPrice}, ${takeProfitPrice})`
  );
  console.log(`  ✓ Recommendation inserted  id=${recId}`);

  // ── Step 3: Send real Telegram approval card ──────────────────────────────
  console.log(`\n${hr()}`);
  console.log("  Step 3: Sending LIVE Telegram approval card (buttons work!)");
  console.log(hr());

  const mockRec: Recommendation = {
    id: recId,
    ticker: TEST_TICKER,
    action: "BUY",
    reasoning: [
      `🔴 LIVE TEST CARD — tapping ✅ Approve WILL place a real paper trade.`,
      ``,
      `This is a smoke test to verify the full Telegram → Worker → Alpaca flow.`,
      `Signal: [LIVE TEST] insider buy of $1M seeded into D1.`,
      ``,
      `BUY $${TEST_NOTIONAL} notional with bracket: stop $${stopPrice}, target $${takeProfitPrice}.`,
    ].join("\n"),
    signalId,
    status: "PENDING",
    notional: TEST_NOTIONAL,
    stopPrice,
    takeProfitPrice,
    createdAt: new Date().toISOString(),
  };

  try {
    await sendApprovalMessage(env, mockRec, currentPrice);
    console.log(`  ✓ Card sent to Telegram chat ${env.TELEGRAM_CHAT_ID}`);
  } catch (err) {
    console.error(`  ✗ sendApprovalMessage failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  console.log(`\n  Approve URL : ${env.APPROVAL_BASE_URL}/approve?id=${recId}`);
  console.log(`  Reject URL  : ${env.APPROVAL_BASE_URL}/reject?id=${recId}\n`);

  // ── Step 4: Poll Alpaca waiting for the order ─────────────────────────────
  console.log(hr());
  console.log(`  Step 4: Waiting up to ${POLL_TIMEOUT_MS / 1000}s for you to tap ✅ Approve…`);
  console.log(hr());
  console.log(`  Open Telegram and tap the ✅ Approve button on the card just sent.\n`);

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let newOrder: Awaited<ReturnType<typeof getOrders>>[number] | undefined;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    let orders: Awaited<ReturnType<typeof getOrders>>;
    try {
      orders = await getOrders(env, "open");
    } catch {
      process.stdout.write(".");
      continue;
    }

    newOrder = orders.find(
      (o) => o.symbol === TEST_TICKER && o.side === "buy" && !existingIds.has(o.id)
    );

    if (newOrder) break;

    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    process.stdout.write(`\r  Polling Alpaca… ${remaining}s remaining  `);
  }

  process.stdout.write("\n");

  if (!newOrder) {
    console.error(`\n  ✗ Timed out — no new BUY ${TEST_TICKER} order appeared in Alpaca.`);
    console.error(`  Either you didn't tap Approve, or the Worker returned an error.`);
    console.error(`  Check the Worker logs: npx wrangler tail`);
    console.error(`  Approve URL: ${env.APPROVAL_BASE_URL}/approve?id=${recId}`);
    process.exit(1);
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n${hr("═")}`);
  console.log("  ✅  FULL FLOW VERIFIED — tap → Worker → Alpaca works end-to-end");
  console.log(hr("═"));
  console.log(`  signal_id         : ${signalId}`);
  console.log(`  recommendation id : ${recId}`);
  console.log(`  stop_price        : $${stopPrice}`);
  console.log(`  take_profit_price : $${takeProfitPrice}`);
  console.log(`  alpaca order id   : ${newOrder.id}`);
  console.log(`  alpaca status     : ${newOrder.status}`);
  console.log(hr("═"));
  console.log(`\n  Note: order is pending market open (9:30 AM ET).`);
  console.log(`  Cancel it at: https://app.alpaca.markets/paper-trading`);
  console.log(`    or: curl -X DELETE https://paper-api.alpaca.markets/v2/orders/${newOrder.id} \\`);
  console.log(`      -H "APCA-API-KEY-ID: ${env.ALPACA_API_KEY.slice(0, 6)}..." -H "APCA-API-SECRET-KEY: <secret>"`);
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
