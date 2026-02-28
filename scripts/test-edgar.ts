/**
 * Smoke-test for fetchForm4s().
 *
 * Hits the live SEC EDGAR EFTS API for yesterday's Form 4 filings,
 * prints a summary of all results, and dumps the first 3 in detail.
 *
 * Usage:
 *   npx tsx scripts/test-edgar.ts
 *   npm run test:edgar
 */

import { fetchForm4s } from "../src/tools/edgar";
import type { Filing } from "../src/types";

function hr(char = "─", width = 60) {
  return char.repeat(width);
}

function printFiling(f: Filing, index: number) {
  console.log(`\n  [${index + 1}] ${f.ticker}  —  ${f.insiderName}`);
  console.log(`       role  : ${f.insiderRole}`);
  console.log(`       type  : ${f.transactionType} (${txLabel(f.transactionType)})`);
  console.log(`       date  : ${f.transactionDate}`);
  console.log(`       shares: ${f.sharesTraded.toLocaleString()}`);
  console.log(`       price : $${f.pricePerShare.toFixed(2)}`);
  console.log(`       value : $${f.transactionValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
}

function txLabel(type: string): string {
  const labels: Record<string, string> = {
    P: "open-market purchase",
    S: "sale",
    A: "award / acquisition",
    D: "disposition",
  };
  return labels[type] ?? type;
}

async function main() {
  console.log(hr("═"));
  console.log("  test-edgar — fetchForm4s()");
  console.log(hr("═"));

  const start = Date.now();

  let filings: Filing[];
  try {
    filings = await fetchForm4s();
  } catch (err) {
    console.error("\n✗ fetchForm4s() threw an error:");
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const elapsed = Date.now() - start;

  console.log(`\n✓ Fetched ${filings.length} filing(s) in ${elapsed} ms`);

  // Breakdown by transaction type
  const byType = filings.reduce<Record<string, number>>((acc, f) => {
    acc[f.transactionType] = (acc[f.transactionType] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`  Type breakdown: ${Object.entries(byType).map(([k, v]) => `${k}=${v}`).join("  ")}`);

  // Unique tickers
  const tickers = new Set(filings.map((f) => f.ticker));
  console.log(`  Unique tickers : ${tickers.size}`);

  // Unique insiders
  const insiders = new Set(filings.map((f) => f.insiderName));
  console.log(`  Unique insiders: ${insiders.size}`);

  if (filings.length === 0) {
    console.log("\n  (No filings returned — possibly a weekend/holiday or EDGAR is down.)");
    return;
  }

  // Show first 3 filings in detail
  const preview = filings.slice(0, 3);
  console.log(`\n${hr()}`);
  console.log(`  First ${preview.length} filing(s):`);
  console.log(hr());
  preview.forEach(printFiling);

  // Show purchases specifically (what the scoring gate lets through)
  const purchases = filings.filter((f) => f.transactionType === "P");
  if (purchases.length > 0) {
    console.log(`\n${hr()}`);
    console.log(`  Open-market purchases (${purchases.length}) — these pass the scoring gate:`);
    console.log(hr());
    purchases.slice(0, 3).forEach(printFiling);
  } else {
    console.log("\n  (No open-market purchases in this batch.)");
  }

  console.log(`\n${hr("═")}`);
  console.log("  Done.");
  console.log(hr("═"));
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
