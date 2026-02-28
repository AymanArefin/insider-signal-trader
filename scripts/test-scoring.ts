/**
 * Unit-test for scoreSignals().
 *
 * Runs against mock filings that exercise every branch of the scoring model:
 *
 *   Case 1 — CEO open-market purchase > $1M, filed today
 *             Expected: role=40  value=20  cluster=0  recency=20  → score=80  ✓ PASS
 *
 *   Case 2 — Director cluster buy (ticker: CLUSTER), filed yesterday
 *             Expected: role=25  value=10  cluster=20  recency=10 → score=65  ✓ PASS
 *
 *   Case 3 — Director cluster buy (ticker: CLUSTER), filed today
 *             Expected: role=25  value=5   cluster=20  recency=20 → score=70  ✓ PASS
 *             (Cases 2 & 3 are different insiders buying CLUSTER within 5 days — each gets +20 cluster)
 *
 *   Case 4 — Officer (VP) tiny purchase, filed 10 days ago — score < 50
 *             Expected: role=15  value=0   cluster=0   recency=0  → score=15  ✗ FILTERED
 *
 *   Case 5 — Option exercise / award (transactionType "A"), CEO, $2M — discarded by gate
 *             Expected: dropped before scoring                              ✗ DISCARDED
 *
 *   Case 6 — Sale (transactionType "S") — discarded by gate
 *             Expected: dropped before scoring                              ✗ DISCARDED
 *
 * Usage:
 *   npx tsx scripts/test-scoring.ts
 *   npm run test:scoring
 */

import { scoreSignals } from "../src/tools/scoring";
import type { Filing, ScoredSignal } from "../src/types";

// ---------- Date helpers ----------

function utcOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const TODAY = utcOffset(0);
const YESTERDAY = utcOffset(-1);
const DAYS_AGO_10 = utcOffset(-10);

// ---------- Mock filings ----------

const mockFilings: Filing[] = [
  // ── Case 1: CEO, >$1M, open-market purchase, today ──────────────────────
  {
    ticker: "MEGA",
    insiderName: "Jane Doe",
    insiderRole: "Chief Executive Officer (CEO)",
    transactionDate: TODAY,
    transactionType: "P",
    transactionValue: 1_500_000,
    sharesTraded: 10_000,
    pricePerShare: 150.0,
    rawXml: "<mockXml/>",
  },

  // ── Case 2: Director A buys CLUSTER, yesterday ──────────────────────────
  {
    ticker: "CLUSTER",
    insiderName: "Alice Smith",
    insiderRole: "Director",
    transactionDate: YESTERDAY,
    transactionType: "P",
    transactionValue: 200_000,
    sharesTraded: 2_000,
    pricePerShare: 100.0,
    rawXml: "<mockXml/>",
  },

  // ── Case 3: Director B buys CLUSTER, today (triggers cluster for both 2 & 3) ─
  {
    ticker: "CLUSTER",
    insiderName: "Bob Jones",
    insiderRole: "Director",
    transactionDate: TODAY,
    transactionType: "P",
    transactionValue: 75_000,
    sharesTraded: 750,
    pricePerShare: 100.0,
    rawXml: "<mockXml/>",
  },

  // ── Case 4: VP, tiny buy, 10 days ago — should be filtered (score < 50) ─
  {
    ticker: "SMALL",
    insiderName: "Carol White",
    insiderRole: "Vice President of Operations",
    transactionDate: DAYS_AGO_10,
    transactionType: "P",
    transactionValue: 8_500,
    sharesTraded: 100,
    pricePerShare: 85.0,
    rawXml: "<mockXml/>",
  },

  // ── Case 5: Option exercise — transactionType "A" → discarded by gate ───
  {
    ticker: "OPTS",
    insiderName: "Dave Black",
    insiderRole: "CEO",
    transactionDate: TODAY,
    transactionType: "A",
    transactionValue: 2_000_000,
    sharesTraded: 50_000,
    pricePerShare: 40.0,
    rawXml: "<mockXml/>",
  },

  // ── Case 6: Open-market sale — transactionType "S" → discarded by gate ─
  {
    ticker: "SELL",
    insiderName: "Eve Green",
    insiderRole: "CFO",
    transactionDate: TODAY,
    transactionType: "S",
    transactionValue: 500_000,
    sharesTraded: 5_000,
    pricePerShare: 100.0,
    rawXml: "<mockXml/>",
  },
];

// ---------- Expected outcomes (for assertion) ----------

interface TestCase {
  label: string;
  ticker: string;
  insiderName: string;
  expectedScore: number | null; // null = must be absent from results
  expectedBreakdown?: {
    roleFactor?: number;
    valueFactor?: number;
    clusterBonus?: number;
    recencyFactor?: number;
  };
}

const TEST_CASES: TestCase[] = [
  {
    label: "Case 1 — CEO $1.5M purchase today",
    ticker: "MEGA",
    insiderName: "Jane Doe",
    expectedScore: 80,
    expectedBreakdown: { roleFactor: 40, valueFactor: 20, clusterBonus: 0, recencyFactor: 20 },
  },
  {
    label: "Case 2 — Director cluster buy CLUSTER (yesterday)",
    ticker: "CLUSTER",
    insiderName: "Alice Smith",
    expectedScore: 65,
    expectedBreakdown: { roleFactor: 25, valueFactor: 10, clusterBonus: 20, recencyFactor: 10 },
  },
  {
    label: "Case 3 — Director cluster buy CLUSTER (today)",
    ticker: "CLUSTER",
    insiderName: "Bob Jones",
    expectedScore: 70,
    expectedBreakdown: { roleFactor: 25, valueFactor: 5, clusterBonus: 20, recencyFactor: 20 },
  },
  {
    label: "Case 4 — VP $8.5K buy 10 days ago (score<50, filtered)",
    ticker: "SMALL",
    insiderName: "Carol White",
    expectedScore: null,
  },
  {
    label: "Case 5 — Option exercise type=A (gate discarded)",
    ticker: "OPTS",
    insiderName: "Dave Black",
    expectedScore: null,
  },
  {
    label: "Case 6 — Sale type=S (gate discarded)",
    ticker: "SELL",
    insiderName: "Eve Green",
    expectedScore: null,
  },
];

// ---------- Helpers ----------

function hr(char = "─", width = 60) {
  return char.repeat(width);
}

function findResult(results: ScoredSignal[], ticker: string, name: string): ScoredSignal | undefined {
  return results.find((s) => s.filing.ticker === ticker && s.filing.insiderName === name);
}

function pass(msg: string) {
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
}

function fail(msg: string) {
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
}

// ---------- Main ----------

function runTests() {
  console.log(hr("═"));
  console.log("  test-scoring — scoreSignals()");
  console.log(hr("═"));
  console.log(`  Dates:  today=${TODAY}  yesterday=${YESTERDAY}  10daysAgo=${DAYS_AGO_10}\n`);

  const results = scoreSignals(mockFilings);

  console.log(`  scoreSignals() returned ${results.length} signal(s) (expected 3)\n`);
  console.log(hr());

  let passed = 0;
  let failed = 0;

  for (const tc of TEST_CASES) {
    console.log(`\n  ${tc.label}`);
    const result = findResult(results, tc.ticker, tc.insiderName);

    if (tc.expectedScore === null) {
      // This filing should NOT appear in results
      if (result === undefined) {
        pass(`Correctly absent from results`);
        passed++;
      } else {
        fail(`Should have been filtered but appeared with score=${result.score}`);
        failed++;
      }
    } else {
      // This filing SHOULD appear with the given score
      if (result === undefined) {
        fail(`Missing from results — expected score=${tc.expectedScore}`);
        failed++;
        continue;
      }

      if (result.score === tc.expectedScore) {
        pass(`score=${result.score} ✓`);
        passed++;
      } else {
        fail(`score=${result.score} but expected ${tc.expectedScore}`);
        failed++;
      }

      // Check individual breakdown factors if specified
      if (tc.expectedBreakdown) {
        for (const [key, expected] of Object.entries(tc.expectedBreakdown)) {
          const actual = result.scoreBreakdown[key as keyof typeof result.scoreBreakdown];
          if (actual === expected) {
            pass(`  ${key}=${actual} ✓`);
            passed++;
          } else {
            fail(`  ${key}=${actual} but expected ${expected}`);
            failed++;
          }
        }
      }

      console.log(`       breakdown: ${result.breakdownSummary}`);
    }
  }

  console.log(`\n${hr()}`);
  console.log(`\n  Sorted results (score desc):`);
  console.log(hr());
  for (const s of results) {
    console.log(`  [${s.score.toString().padStart(3)}]  ${s.filing.ticker.padEnd(8)} ${s.filing.insiderName}`);
    console.log(`         ${s.breakdownSummary}`);
  }

  console.log(`\n${hr("═")}`);
  const total = passed + failed;
  if (failed === 0) {
    console.log(`\x1b[32m  All ${total} assertions passed.\x1b[0m`);
  } else {
    console.log(`\x1b[31m  ${failed} of ${total} assertions FAILED.\x1b[0m`);
  }
  console.log(hr("═"));

  if (failed > 0) process.exit(1);
}

runTests();
