/**
 * Scoring tool — converts Filing[] into ScoredSignal[] using a multi-factor model.
 *
 * Rules (applied in order):
 *  1. GATE:     Only open-market purchases (transactionType === "P") qualify.
 *               All other transaction types are discarded before scoring.
 *  2. Role:     CEO/CFO/President = 40 | Director = 25 | VP/Officer = 15 | Other = 5
 *  3. Value:    >$1 M = 20 | >$100 K = 10 | >$10 K = 5 | else = 0
 *  4. Cluster:  2+ *different* insiders buying the same ticker within 5 calendar days = +20
 *  5. Recency:  transactionDate == today = +20 | == yesterday = +10 | else = 0
 *  6. Cap at 100. Drop signals with score < 50. Sort descending.
 *
 * Public API:
 *  scoreSignals(filings: Filing[]): ScoredSignal[]
 */

import type { Filing, ScoredSignal } from "../types";

// ---------- Role scoring ----------

/**
 * Patterns are tested case-insensitively in priority order.
 * "President" can appear as a standalone title or inside "EVP" — we use word boundaries
 * to avoid false positives (e.g. "Vice President" should not be caught by the CEO regex).
 */
const ROLE_PATTERNS: Array<{ re: RegExp; pts: number }> = [
  {
    re: /\b(CEO|CHIEF\s+EXECUTIVE|CFO|CHIEF\s+FINANCIAL|PRESIDENT|COO|CHIEF\s+OPERATING|CTO|CHIEF\s+TECHNOLOGY|CSO|CRO|CHAIRMAN)\b/i,
    pts: 40,
  },
  { re: /\bdirector\b/i, pts: 25 },
  {
    re: /\b(VP|VICE\s+PRES|SVP|EVP|OFFICER|TREASURER|SECRETARY|CONTROLLER|COMPTROLLER)\b/i,
    pts: 15,
  },
];

function scoreRole(role: string): number {
  for (const { re, pts } of ROLE_PATTERNS) {
    if (re.test(role)) return pts;
  }
  return 5;
}

// ---------- Value scoring ----------

function scoreValue(transactionValue: number): number {
  if (transactionValue > 1_000_000) return 20;
  if (transactionValue > 100_000) return 10;
  if (transactionValue > 10_000) return 5;
  return 0;
}

// ---------- Recency scoring ----------

function utcDateString(offsetDays = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function scoreRecency(transactionDate: string): number {
  if (transactionDate === utcDateString(0)) return 20;
  if (transactionDate === utcDateString(-1)) return 10;
  return 0;
}

// ---------- Cluster detection ----------

/**
 * Calendar-day difference between two "YYYY-MM-DD" strings.
 * Uses UTC midnight to avoid DST shifts.
 */
function calendarDayDiff(a: string, b: string): number {
  const msPerDay = 864e5;
  return Math.abs(Date.parse(a) - Date.parse(b)) / msPerDay;
}

/**
 * A stable per-filing key used to track cluster membership.
 * Includes insiderName so two transactions by the same person on the same ticker
 * on the same day don't artificially inflate the cluster count.
 */
function filingKey(f: Filing): string {
  return `${f.ticker}\x00${f.insiderName}\x00${f.transactionDate}`;
}

/**
 * Returns the set of filingKey()s that qualify for the cluster bonus.
 * A filing qualifies when at least one *other* insider bought the same ticker
 * within 5 calendar days of its transactionDate.
 */
function detectClusters(filings: Filing[]): Set<string> {
  // Group purchases by ticker
  const byTicker = new Map<string, Filing[]>();
  for (const f of filings) {
    const g = byTicker.get(f.ticker);
    if (g) g.push(f); else byTicker.set(f.ticker, [f]);
  }

  const clustered = new Set<string>();

  for (const group of byTicker.values()) {
    if (group.length < 2) continue;

    // O(n²) — group sizes are tiny in practice (at most a handful per ticker per day)
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];

        if (
          a.insiderName !== b.insiderName &&
          calendarDayDiff(a.transactionDate, b.transactionDate) <= 5
        ) {
          clustered.add(filingKey(a));
          clustered.add(filingKey(b));
        }
      }
    }
  }

  return clustered;
}

// ---------- Formatting ----------

function fmtUSD(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

// ---------- Core signal builder ----------

function buildSignal(filing: Filing, inCluster: boolean): ScoredSignal {
  const roleFactor = scoreRole(filing.insiderRole);
  const valueFactor = scoreValue(filing.transactionValue);
  const clusterBonus = inCluster ? 20 : 0;
  const recencyFactor = scoreRecency(filing.transactionDate);

  const raw = roleFactor + valueFactor + clusterBonus + recencyFactor;
  const score = Math.min(raw, 100);
  const capped = raw > 100;

  const breakdownSummary = [
    `role(${filing.insiderRole})=+${roleFactor}`,
    `value(${fmtUSD(filing.transactionValue)})=+${valueFactor}`,
    `cluster=${inCluster ? "+20" : "0"}`,
    `recency(${filing.transactionDate})=+${recencyFactor}`,
    `total=${score}${capped ? " (capped from " + raw + ")" : ""}`,
  ].join(" | ");

  return {
    filing,
    score,
    scoreBreakdown: { roleFactor, valueFactor, clusterBonus, recencyFactor },
    breakdownSummary,
  };
}

// ---------- Public API ----------

/**
 * Scores a batch of Form 4 filings using the multi-factor model described above.
 *
 * @param filings - Raw Filing objects as returned by fetchForm4s().
 * @param limit   - Maximum number of signals to return (default 10, highest scores first).
 * @returns All open-market-purchase ScoredSignals sorted by score descending, up to `limit`.
 *          No minimum score threshold is applied — every purchase is passed to the LLM.
 */
export function scoreSignals(filings: Filing[], limit = 10): ScoredSignal[] {
  // Gate: only open-market purchases qualify — discard everything else
  const purchases = filings.filter((f) => f.transactionType === "P");
  if (purchases.length === 0) return [];

  const clustered = detectClusters(purchases);

  return purchases
    .map((f) => buildSignal(f, clustered.has(filingKey(f))))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** @deprecated Use scoreSignals() */
export function scoreFiling(filing: Filing): ScoredSignal {
  // Does not apply the min-score filter; useful for inspecting a single filing's breakdown.
  return buildSignal(filing, false);
}

/** @deprecated Use scoreSignals() */
export async function scoreFilings(filings: Filing[]): Promise<ScoredSignal[]> {
  return scoreSignals(filings);
}
