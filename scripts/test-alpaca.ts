/**
 * Smoke-test for the Alpaca tool functions.
 *
 * Calls getPortfolio(), getPositionPrices(), and getBuyingPower() against the
 * live paper-trading account using credentials from .dev.vars. No orders are placed.
 *
 * Usage:
 *   npx tsx scripts/test-alpaca.ts
 *   npm run test:alpaca
 */

import { getBuyingPower, getPortfolio, getPositionPrices } from "../src/tools/alpaca";
import { loadEnv } from "./lib/loadEnv";
import type { AlpacaPosition } from "../src/types";

function hr(char = "─", width = 60) {
  return char.repeat(width);
}

function fmtMoney(s: string): string {
  const n = parseFloat(s);
  if (isNaN(n)) return s;
  const sign = n >= 0 ? "+" : "";
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function printPosition(p: AlpacaPosition, prices: Record<string, number>) {
  const currentPrice = prices[p.symbol];
  const plPct = (parseFloat(p.unrealized_plpc) * 100).toFixed(2);
  const plSign = parseFloat(p.unrealized_pl) >= 0 ? "\x1b[32m" : "\x1b[31m";

  console.log(`\n  ${p.symbol.padEnd(6)}  ${p.side.toUpperCase().padEnd(5)}  qty=${p.qty}`);
  console.log(`    avg entry : $${parseFloat(p.avg_entry_price).toFixed(2)}`);
  if (currentPrice !== undefined) {
    console.log(`    cur price : $${currentPrice.toFixed(2)}`);
  }
  console.log(`    mkt value : $${parseFloat(p.market_value).toLocaleString(undefined, { minimumFractionDigits: 2 })}`);
  console.log(`    unrealized: ${plSign}${fmtMoney(p.unrealized_pl)} (${plPct}%)\x1b[0m`);
}

async function main() {
  const env = loadEnv();

  console.log(hr("═"));
  console.log("  test-alpaca — getBuyingPower() + getPortfolio() + getPositionPrices()");
  console.log(hr("═"));
  console.log(`  base URL  : ${env.ALPACA_BASE_URL}`);
  console.log(`  data URL  : ${env.ALPACA_DATA_URL}`);
  console.log(`  key       : ${env.ALPACA_API_KEY.slice(0, 6)}…\n`);

  // ── 1. Fetch buying power ───────────────────────────────────────────────
  console.log(hr());
  console.log("  Step 1: getBuyingPower()");
  console.log(hr());

  let buyingPower: number;
  try {
    buyingPower = await getBuyingPower(env);
    const formatted = buyingPower.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    if (buyingPower > 0) {
      console.log(`  \x1b[32m✓\x1b[0m buying_power = $${formatted}`);
    } else {
      console.log(`  \x1b[33m⚠\x1b[0m buying_power = $${formatted}  (account may be fully invested)`);
    }
  } catch (err) {
    console.error(`  \x1b[31m✗\x1b[0m getBuyingPower() failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // ── 2. Fetch portfolio ──────────────────────────────────────────────────
  console.log(`\n${hr()}`);
  console.log("  Step 2: getPortfolio()");
  console.log(hr());

  let positions: AlpacaPosition[];
  try {
    positions = await getPortfolio(env);
    console.log(`  ✓ ${positions.length} position(s) found`);
  } catch (err) {
    console.error(`  ✗ getPortfolio() failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (positions.length === 0) {
    console.log("  (Paper account is flat — no open positions.)");
  }

  // ── 3. Fetch current prices ─────────────────────────────────────────────
  console.log(`\n${hr()}`);
  console.log("  Step 3: getPositionPrices()");
  console.log(hr());

  // Use tickers from the portfolio; fall back to a set of well-known symbols
  const symbols = positions.length > 0
    ? positions.map((p) => p.symbol)
    : ["AAPL", "MSFT", "NVDA", "TSLA", "SPY"];

  console.log(`  Fetching prices for: ${symbols.join(", ")}`);

  let prices: Record<string, number>;
  try {
    prices = await getPositionPrices(env, symbols);
    console.log(`  ✓ Received prices for ${Object.keys(prices).length} symbol(s)`);
  } catch (err) {
    console.error(`  ✗ getPositionPrices() failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // ── 4. Print combined portfolio view ───────────────────────────────────
  if (positions.length > 0) {
    console.log(`\n${hr()}`);
    console.log("  Portfolio with live prices:");
    console.log(hr());
    for (const p of positions) {
      printPosition(p, prices);
    }

    const totalMarketValue = positions.reduce((sum, p) => sum + parseFloat(p.market_value), 0);
    const totalUnrealizedPL = positions.reduce((sum, p) => sum + parseFloat(p.unrealized_pl), 0);
    const plSign = totalUnrealizedPL >= 0 ? "\x1b[32m" : "\x1b[31m";

    console.log(`\n  ${hr()}`);
    console.log(`  Total market value : $${totalMarketValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}`);
    console.log(`  Total unrealized P/L: ${plSign}${fmtMoney(totalUnrealizedPL.toFixed(2))}\x1b[0m`);
  }

  // ── 5. Print raw prices table ───────────────────────────────────────────
  console.log(`\n${hr()}`);
  console.log("  Current prices:");
  console.log(hr());
  for (const [sym, price] of Object.entries(prices)) {
    console.log(`  ${sym.padEnd(6)}  $${price.toFixed(2)}`);
  }

  const missing = symbols.filter((s) => prices[s] === undefined);
  if (missing.length > 0) {
    console.log(`\n  (No price data for: ${missing.join(", ")})`);
  }

  console.log(`\n${hr("═")}`);
  console.log("  Done.");
  console.log(hr("═"));
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
