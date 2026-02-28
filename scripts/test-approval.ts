/**
 * End-to-end smoke test for the Telegram approval → Alpaca order flow.
 *
 * What this does:
 *  1. Seeds a mock signal row into the remote D1 database.
 *  2. Seeds a PENDING recommendation row with a known UUID.
 *  3. Hits GET /approve?id=<uuid> on the live deployed Worker.
 *  4. Asserts the response confirms the trade was executed.
 *  5. Calls the Alpaca orders API to verify the BUY order was submitted.
 *
 * No real money is involved — all orders go to Alpaca's paper-trading account.
 * The $100 BUY order for AAPL will remain open until market hours (9:30 AM ET)
 * when it will fill automatically. Cancel it in the Alpaca paper dashboard if
 * you don't want the position.
 *
 * Usage:
 *   npx tsx scripts/test-approval.ts
 *   npm run test:approval
 */

import { execSync } from "child_process";
import { getOrders, getPositionPrices } from "../src/tools/alpaca";
import { loadEnv } from "./lib/loadEnv";

const DB_NAME = "insider-trader";
const TEST_TICKER = "AAPL";
const TEST_NOTIONAL = 500.00;
// Stop/limit percentages — stop 8% below current price, target 15% above
const STOP_PCT = 0.08;
const TARGET_PCT = 0.15;

function hr(char = "─", width = 60) {
  return char.repeat(width);
}

/** Run a wrangler D1 command against the remote database and return parsed JSON. */
function d1(sql: string): unknown[] {
  const raw = execSync(
    `npx wrangler d1 execute ${DB_NAME} --remote --command ${JSON.stringify(sql)} --json`,
    { cwd: process.cwd(), encoding: "utf-8", env: process.env }
  );
  return JSON.parse(raw) as unknown[];
}

async function main() {
  const env = loadEnv();

  console.log(hr("═"));
  console.log("  test-approval — end-to-end approval flow smoke test");
  console.log(hr("═"));
  // ── Step 0: Fetch current price to derive bracket levels ─────────────────
  const prices = await getPositionPrices(env, [TEST_TICKER]);
  const currentPrice = prices[TEST_TICKER];
  if (!currentPrice) {
    console.error(`  ✗ Could not fetch current price for ${TEST_TICKER}`);
    process.exit(1);
  }
  const TEST_STOP_PRICE = parseFloat((currentPrice * (1 - STOP_PCT)).toFixed(2));
  const TEST_TAKE_PROFIT_PRICE = parseFloat((currentPrice * (1 + TARGET_PCT)).toFixed(2));

  console.log(`  Worker URL   : ${env.APPROVAL_BASE_URL}`);
  console.log(`  Ticker       : ${TEST_TICKER}  notional: $${TEST_NOTIONAL}`);
  console.log(`  Current Price: $${currentPrice.toFixed(2)}`);
  console.log(`  Stop-Loss    : $${TEST_STOP_PRICE}  (−${(STOP_PCT * 100).toFixed(0)}%)`);
  console.log(`  Take-Profit  : $${TEST_TAKE_PROFIT_PRICE}  (+${(TARGET_PCT * 100).toFixed(0)}%)`);
  console.log(`  Database     : ${DB_NAME} (remote)\n`);

  // ── Step 1: Seed a mock signal ───────────────────────────────────────────
  console.log(hr());
  console.log("  Step 1: Insert mock signal into D1 (remote)");
  console.log(hr());

  const today = new Date().toISOString().slice(0, 10);
  d1(
    `INSERT INTO signals (ticker, insider_name, insider_role, transaction_date, transaction_value, score, raw_filing) ` +
    `VALUES ('${TEST_TICKER}', '[TEST] Smoke Test', 'CEO', '${today}', 1000000, 80, '{}')`
  );

  const idRows = d1(`SELECT last_insert_rowid() AS signal_id`) as Array<{ results: Array<{ signal_id: number }> }>;
  const signalId = idRows[0]?.results?.[0]?.signal_id;
  if (!signalId) {
    console.error("  ✗ Could not retrieve signal_id after insert");
    process.exit(1);
  }
  console.log(`  ✓ Signal inserted  signal_id=${signalId}`);

  // ── Step 2: Seed a PENDING recommendation ────────────────────────────────
  console.log(`\n${hr()}`);
  console.log("  Step 2: Insert PENDING recommendation into D1 (remote)");
  console.log(hr());

  const recId = crypto.randomUUID();
  d1(
    `INSERT INTO recommendations (id, ticker, action, reasoning, signal_id, status, notional, stop_price, take_profit_price) ` +
    `VALUES ('${recId}', '${TEST_TICKER}', 'BUY', '[TEST] approval smoke test — safe to ignore', ${signalId}, 'PENDING', ${TEST_NOTIONAL}, ${TEST_STOP_PRICE}, ${TEST_TAKE_PROFIT_PRICE})`
  );
  console.log(`  ✓ Recommendation inserted  id=${recId}  stop=$${TEST_STOP_PRICE}  target=$${TEST_TAKE_PROFIT_PRICE}`);

  // ── Step 3: Hit the approve endpoint ─────────────────────────────────────
  console.log(`\n${hr()}`);
  console.log("  Step 3: GET /approve?id=<uuid> on live Worker");
  console.log(hr());

  const approveUrl = `${env.APPROVAL_BASE_URL}/approve?id=${recId}`;
  console.log(`  URL: ${approveUrl}\n`);

  let approveBody: string;
  let approveStatus: number;
  const approveStart = Date.now();
  try {
    const res = await fetch(approveUrl);
    approveStatus = res.status;
    approveBody = await res.text();
  } catch (err) {
    console.error(`  ✗ fetch() failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const elapsed = Date.now() - approveStart;
  console.log(`  HTTP ${approveStatus}  (${elapsed} ms)`);
  console.log(`  Body: "${approveBody}"`);

  if (approveStatus !== 200) {
    console.error(`\n  ✗ Expected HTTP 200, got ${approveStatus}`);
    console.error(`  Common causes:`);
    console.error(`    • Recommendation already resolved (re-run the script to get a fresh UUID)`);
    console.error(`    • Worker is not deployed — run: npm run deploy`);
    if (approveBody.includes("insufficient buying power") || approveBody.includes("buying_power")) {
      console.error(`    • Alpaca paper account has insufficient buying power`);
      console.error(`      → Reset it at: https://app.alpaca.markets/paper-trading (gear icon → Reset Account)`);
    }
    process.exit(1);
  }

  if (!approveBody.includes("Trade executed")) {
    console.error(`\n  ✗ Expected "Trade executed" in response body`);
    process.exit(1);
  }

  console.log(`\n  \x1b[32m✓\x1b[0m Approval accepted — Worker submitted the order to Alpaca`);

  // ── Step 4: Verify order in Alpaca ────────────────────────────────────────
  console.log(`\n${hr()}`);
  console.log("  Step 4: Verify order via Alpaca GET /v2/orders?status=open");
  console.log(hr());

  let orders: Awaited<ReturnType<typeof getOrders>>;
  try {
    orders = await getOrders(env, "open");
  } catch (err) {
    console.error(`  ✗ getOrders() failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  console.log(`  ✓ ${orders.length} open order(s) found in Alpaca\n`);

  const testOrder = orders.find(
    (o) => o.symbol === TEST_TICKER && o.side === "buy"
  );

  if (!testOrder) {
    console.error(`  ✗ No open BUY ${TEST_TICKER} order found — Alpaca may have rejected it`);
    console.error(`  All open orders: ${orders.map((o) => `${o.side} ${o.symbol}`).join(", ") || "(none)"}`);
    process.exit(1);
  }

  console.log(`  \x1b[32m✓\x1b[0m BUY ${TEST_TICKER} order confirmed in Alpaca`);
  console.log(`    Order ID : ${testOrder.id}`);
  console.log(`    Status   : ${testOrder.status}`);
  console.log(`    Notional : $${testOrder.notional ?? "(notional not set)"}`);
  console.log(`    Created  : ${testOrder.created_at}`);

  if (testOrder.status === "new" || testOrder.status === "pending_new" || testOrder.status === "accepted") {
    console.log(`\n  Note: order is pending — it will fill at market open (9:30 AM ET).`);
    console.log(`  To cancel: visit https://app.alpaca.markets/paper-trading or run`);
    console.log(`    curl -X DELETE https://paper-api.alpaca.markets/v2/orders/${testOrder.id} \\`);
    console.log(`      -H "APCA-API-KEY-ID: ${env.ALPACA_API_KEY.slice(0, 6)}..." \\`);
    console.log(`      -H "APCA-API-SECRET-KEY: <secret>"`);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${hr("═")}`);
  console.log("  ALL CHECKS PASSED");
  console.log(hr("═"));
  console.log(`  signal_id        : ${signalId}`);
  console.log(`  recommendation   : ${recId}`);
  console.log(`  stop_price       : $${TEST_STOP_PRICE}`);
  console.log(`  take_profit_price: $${TEST_TAKE_PROFIT_PRICE}`);
  console.log(`  alpaca order id  : ${testOrder.id}`);
  console.log(`  alpaca status    : ${testOrder.status}`);
  console.log(hr("═"));
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
