/**
 * DB tool — all D1 database access for the insider-signal-trader project.
 *
 * This is the ONLY file that issues SQL. All callers receive typed domain
 * objects; no raw SQL leaks outside this module.
 *
 * Tables:  signals · recommendations · positions
 *
 * Public API:
 *  insertSignal(db, signal)                              → void   (sets signal.signalId as side-effect)
 *  insertRecommendation(db, rec)                         → string (UUID primary key)
 *  getRecommendation(db, id)                             → Recommendation | null
 *  updateRecommendationStatus(db, id, status, resolvedAt)→ void
 *  logTrade(db, trade)                                   → void
 *  getOpenPositions(db)                                  → TradeLog[]
 *  getPositionsWithThesis(db)                            → PositionWithThesis[]
 */

import type { PositionWithThesis, Recommendation, ScoredSignal, TradeLog } from "../types";

// ---------- Private DB row shapes (snake_case mirrors column names) ----------

interface RecommendationRow {
  id: string;
  ticker: string;
  action: string;
  reasoning: string;
  signal_id: number;
  status: string;
  notional: number;
  stop_price: number | null;
  take_profit_price: number | null;
  created_at: string;
  resolved_at: string | null;
}

interface PositionRow {
  id: number;
  ticker: string;
  side: string;
  qty: number;
  price: number;
  notional: number;
  alpaca_order_id: string;
  recommendation_id: string;
  executed_at: string;
}

// ---------- Row → domain mappers ----------

function toRecommendation(row: RecommendationRow): Recommendation {
  return {
    id: row.id,
    ticker: row.ticker,
    action: row.action as Recommendation["action"],
    reasoning: row.reasoning,
    signalId: row.signal_id,
    status: row.status as Recommendation["status"],
    notional: row.notional,
    stopPrice: row.stop_price ?? undefined,
    takeProfitPrice: row.take_profit_price ?? undefined,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? undefined,
  };
}

function toTradeLog(row: PositionRow): TradeLog {
  return {
    id: row.id,
    ticker: row.ticker,
    side: row.side as TradeLog["side"],
    qty: row.qty,
    price: row.price,
    notional: row.notional,
    alpacaOrderId: row.alpaca_order_id,
    recommendationId: row.recommendation_id,
    executedAt: row.executed_at,
  };
}

// ---------- Helpers ----------

/**
 * Throws a descriptive Error when a D1 statement returns `success: false`.
 * D1 can return a failed result without throwing in some edge cases.
 */
function assertSuccess(result: D1Result, context: string): void {
  if (!result.success) {
    throw new Error(`D1 write failed [${context}]: ${result.error ?? "unknown error"}`);
  }
}

// ---------- Public API ----------

/**
 * Inserts a scored signal into the `signals` table.
 *
 * Side-effect: sets `signal.signalId` to the auto-incremented integer row ID
 * so the caller can immediately reference it when creating a recommendation.
 * `raw_filing` stores the full Filing as JSON for auditability.
 */
export async function insertSignal(db: D1Database, signal: ScoredSignal): Promise<void> {
  const result = await db
    .prepare(
      `INSERT INTO signals
         (ticker, insider_name, insider_role, transaction_date, transaction_value, score, raw_filing)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      signal.filing.ticker,
      signal.filing.insiderName,
      signal.filing.insiderRole,
      signal.filing.transactionDate,
      signal.filing.transactionValue,
      signal.score,
      JSON.stringify(signal.filing)
    )
    .run();

  assertSuccess(result, "insertSignal");
  // Populate signalId on the object so callers can reference it in insertRecommendation
  signal.signalId = result.meta.last_row_id;
}

/**
 * Inserts a new recommendation with status PENDING.
 * Generates a UUID primary key with `crypto.randomUUID()` so the ID is safe to
 * embed in approval deep-links without leaking sequential row numbers.
 *
 * @returns The generated UUID string that becomes the recommendation's `id`.
 */
export async function insertRecommendation(
  db: D1Database,
  rec: Omit<Recommendation, "id">
): Promise<string> {
  const id = crypto.randomUUID();

  const result = await db
    .prepare(
      `INSERT INTO recommendations
         (id, ticker, action, reasoning, signal_id, status, notional, stop_price, take_profit_price)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      rec.ticker,
      rec.action,
      rec.reasoning,
      rec.signalId,
      rec.status,
      rec.notional,
      rec.stopPrice ?? null,
      rec.takeProfitPrice ?? null
    )
    .run();

  assertSuccess(result, "insertRecommendation");
  return id;
}

/**
 * Fetches a single recommendation by its UUID primary key.
 * Returns null when no row is found (e.g. expired / unknown ID in approval link).
 */
export async function getRecommendation(
  db: D1Database,
  id: string
): Promise<Recommendation | null> {
  const row = await db
    .prepare(`SELECT * FROM recommendations WHERE id = ?`)
    .bind(id)
    .first<RecommendationRow>();

  return row ? toRecommendation(row) : null;
}

/**
 * Transitions a recommendation through its state machine.
 * `resolvedAt` should be an ISO-8601 UTC string; pass `new Date().toISOString()`
 * at the call site for consistency.
 *
 * Valid transitions (enforced by the DB CHECK constraint):
 *   PENDING → APPROVED | REJECTED | EXPIRED
 *   APPROVED → EXECUTED
 */
export async function updateRecommendationStatus(
  db: D1Database,
  id: string,
  status: string,
  resolvedAt: string
): Promise<void> {
  const result = await db
    .prepare(
      `UPDATE recommendations
       SET status = ?, resolved_at = ?
       WHERE id = ?`
    )
    .bind(status, resolvedAt, id)
    .run();

  assertSuccess(result, `updateRecommendationStatus(${id} → ${status})`);

  if (result.meta.changes === 0) {
    throw new Error(
      `updateRecommendationStatus: no row found for id="${id}" — ` +
        `it may have already been resolved or never existed`
    );
  }
}

/**
 * Records an executed trade in the `positions` table.
 * The `positions` table is an append-only audit log; it does not track whether
 * a position has subsequently been closed. Cross-reference with Alpaca's live
 * portfolio (getPortfolio) to determine current open positions.
 */
export async function logTrade(db: D1Database, trade: TradeLog): Promise<void> {
  const result = await db
    .prepare(
      `INSERT INTO positions
         (ticker, side, qty, price, notional, alpaca_order_id, recommendation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      trade.ticker,
      trade.side,
      trade.qty,
      trade.price,
      trade.notional,
      trade.alpacaOrderId,
      trade.recommendationId
    )
    .run();

  assertSuccess(result, "logTrade");
}

/**
 * Returns all recorded trade positions joined with their recommendation,
 * ordered most-recent first.
 *
 * Note: this reflects what the system has *executed*, not necessarily what is
 * currently open in Alpaca. Use getPortfolio(env) from tools/alpaca.ts to get
 * the live position state, then reconcile with this list if needed.
 */
export async function getOpenPositions(db: D1Database): Promise<TradeLog[]> {
  const { results } = await db
    .prepare(
      `SELECT p.*
       FROM   positions p
       JOIN   recommendations r ON r.id = p.recommendation_id
       WHERE  r.status = 'APPROVED'
       ORDER  BY p.executed_at DESC`
    )
    .all<PositionRow>();

  return results.map(toTradeLog);
}

// ---------- Private row shape for thesis join ----------

interface PositionWithThesisRow {
  ticker: string;
  qty: number;
  entry_price: number;
  notional: number;
  executed_at: string;
  recommendation_id: string;
  original_reasoning: string;
  insider_name: string;
  insider_role: string;
  signal_value: number;
  signal_score: number;
  stop_price: number | null;
  take_profit_price: number | null;
}

/**
 * Returns each executed position enriched with the original buy thesis.
 *
 * Joins three tables:
 *   positions → recommendations  (for the LLM reasoning that triggered the BUY)
 *   recommendations → signals    (for the raw insider data: name, role, value, score)
 *
 * This is what the DecisionAgent uses each day to decide whether to hold or sell:
 * Claude sees not just the current P&L but also *why* the position was entered,
 * which lets it judge whether the original insider thesis still holds.
 */
export async function getPositionsWithThesis(
  db: D1Database
): Promise<PositionWithThesis[]> {
  const { results } = await db
    .prepare(
      `SELECT
         p.ticker,
         p.qty,
         p.price             AS entry_price,
         p.notional,
         p.executed_at,
         p.recommendation_id,
         r.reasoning         AS original_reasoning,
         r.stop_price,
         r.take_profit_price,
         s.insider_name,
         s.insider_role,
         s.transaction_value AS signal_value,
         s.score             AS signal_score
       FROM   positions p
       JOIN   recommendations r ON r.id = p.recommendation_id
       JOIN   signals         s ON s.id = r.signal_id
       WHERE  r.status = 'APPROVED'
       ORDER  BY p.executed_at DESC`
    )
    .all<PositionWithThesisRow>();

  return results.map((row) => ({
    ticker: row.ticker,
    qty: row.qty,
    entryPrice: row.entry_price,
    notional: row.notional,
    executedAt: row.executed_at,
    recommendationId: row.recommendation_id,
    originalReasoning: row.original_reasoning,
    insiderName: row.insider_name,
    insiderRole: row.insider_role,
    signalValue: row.signal_value,
    signalScore: row.signal_score,
    stopPrice: row.stop_price ?? undefined,
    takeProfitPrice: row.take_profit_price ?? undefined,
  }));
}
