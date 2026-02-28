/**
 * FormScannerAgent — Durable Object agent responsible for the daily scan pipeline.
 *
 * Triggered by the Worker's cron handler (9:35 AM ET weekdays) via POST /scan.
 *
 * Pipeline (run method):
 *  1. fetchForm4s()    — pull yesterday's SEC Form 4 filings from EDGAR EFTS.
 *  2. scoreSignals()   — score and filter: open-market purchases only, score ≥ 50.
 *  3. insertSignal()   — persist each qualifying signal to D1; populates signalId.
 *
 * Persistent state tracks the timestamp of the last completed scan and the IDs of
 * signals that are awaiting a DecisionAgent recommendation.
 */

import { Agent } from "@cloudflare/agents";
import type { Env, ScoredSignal } from "../types";
import { fetchForm4s } from "../tools/edgar";
import { scoreSignals } from "../tools/scoring";
import { insertSignal } from "../tools/db";

interface FormScannerState {
  /** ISO-8601 UTC timestamp of the last completed scan run. */
  lastScannedAt: string | null;
  /** Signal IDs written to D1 that have not yet been processed by DecisionAgent. */
  pendingSignalIds: number[];
}

export class FormScannerAgent extends Agent<Env, FormScannerState> {
  /**
   * `initialState` is read by the Agents SDK when there is no persisted state
   * (i.e. the very first time this Durable Object is created). After that,
   * `this.state` reflects the last value passed to `this.setState()`.
   */
  initialState: FormScannerState = {
    lastScannedAt: null,
    pendingSignalIds: [],
  };

  // Convenience typed accessor — guards against null/undefined from stale persisted state
  private get s(): FormScannerState {
    const raw = this.state as Partial<FormScannerState> | null;
    return {
      lastScannedAt: raw?.lastScannedAt ?? null,
      pendingSignalIds: Array.isArray(raw?.pendingSignalIds) ? raw.pendingSignalIds : [],
    };
  }

  // ---------- Main pipeline ----------

  /**
   * Executes the full daily scan pipeline:
   *   EDGAR → score → D1 insert
   *
   * Returns the array of qualifying ScoredSignals so the caller
   * (e.g. DecisionAgent or tests) can act on them directly.
   *
   * Per-signal D1 failures are caught individually and logged without
   * aborting the rest of the batch.
   *
   * @param env Worker environment (provides D1 binding).
   */
  async run(env: Env): Promise<ScoredSignal[]> {
    const runStartedAt = new Date().toISOString();
    console.log(`[FormScanner] Scan started at ${runStartedAt}`);

    // ── Step 1: Fetch Form 4 filings from EDGAR ──────────────────────────────
    // First try yesterday; if no open-market purchases found, expand to 3 days
    // so long weekends and light filing days still produce signals.
    let filings;
    try {
      filings = await fetchForm4s(1);
    } catch (err) {
      console.error(`[FormScanner] EDGAR fetch failed: ${String(err)}`);
      throw err;
    }
    console.log(`[FormScanner] Step 1 complete — fetched ${filings.length} Form 4 filing(s) (1-day window)`);

    // ── Step 1b: 3-day fallback if yesterday had no open-market purchases ─────
    const hadPurchases = filings.some((f) => f.transactionType === "P");
    if (!hadPurchases) {
      console.log("[FormScanner] No purchases yesterday — expanding to 3-day lookback");
      try {
        filings = await fetchForm4s(3);
        console.log(`[FormScanner] Step 1b complete — fetched ${filings.length} filing(s) (3-day window)`);
      } catch (err) {
        console.error(`[FormScanner] 3-day EDGAR fetch failed: ${String(err)}`);
        // Fall through with whatever we have
      }
    }

    // ── Step 2: Score ─────────────────────────────────────────────────────────
    const signals = scoreSignals(filings);
    const purchases = filings.filter((f) => f.transactionType === "P").length;
    console.log(
      `[FormScanner] Step 2 complete — ${signals.length} signal(s) scored` +
        ` from ${purchases} open-market purchase(s) (${filings.length - purchases} non-purchases discarded)`
    );

    if (signals.length === 0) {
      this.setState({ ...this.s, lastScannedAt: runStartedAt });
      console.log("[FormScanner] No open-market purchases found even in 3-day window — scan complete");
      return [];
    }

    // ── Step 3: Persist to D1 ────────────────────────────────────────────────
    const persistedIds: number[] = [];

    for (const signal of signals) {
      try {
        // insertSignal() sets signal.signalId as a side-effect (last_insert_rowid)
        await insertSignal(env.DB, signal);
        const id = signal.signalId!;
        persistedIds.push(id);
        console.log(
          `[FormScanner] Persisted signal #${id}` +
            ` — ${signal.filing.ticker} (${signal.filing.insiderRole})` +
            ` score=${signal.score} | ${signal.breakdownSummary}`
        );
      } catch (err) {
        console.error(
          `[FormScanner] Failed to persist signal for` +
            ` ${signal.filing.ticker} / ${signal.filing.insiderName}: ${String(err)}`
        );
      }
    }

    const failed = signals.length - persistedIds.length;
    console.log(
      `[FormScanner] Step 3 complete — ${persistedIds.length} signal(s) persisted` +
        (failed > 0 ? `, ${failed} failed (see errors above)` : "")
    );

    // ── Update persistent state ───────────────────────────────────────────────
    this.setState({
      lastScannedAt: runStartedAt,
      pendingSignalIds: [...this.s.pendingSignalIds, ...persistedIds],
    });

    console.log("[FormScanner] Scan complete");
    return signals;
  }

  // ---------- HTTP handler ----------

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // POST …/scan — invoked by the cron handler in index.ts
    if (request.method === "POST" && url.pathname.endsWith("/scan")) {
      try {
        const signals = await this.run(this.env);

        return Response.json({
          ok: true,
          scannedAt: this.s.lastScannedAt,
          signalCount: signals.length,
          // rawXml is stripped for inter-agent transport to keep payloads small.
          // All other ScoredSignal fields (filing, score, scoreBreakdown,
          // breakdownSummary, signalId) are preserved for DecisionAgent.
          signals: signals.map((s) => ({
            filing: {
              ticker: s.filing.ticker,
              insiderName: s.filing.insiderName,
              insiderRole: s.filing.insiderRole,
              transactionDate: s.filing.transactionDate,
              transactionType: s.filing.transactionType,
              transactionValue: s.filing.transactionValue,
              sharesTraded: s.filing.sharesTraded,
              pricePerShare: s.filing.pricePerShare,
              rawXml: "",
            },
            score: s.score,
            scoreBreakdown: s.scoreBreakdown,
            breakdownSummary: s.breakdownSummary,
            signalId: s.signalId ?? null,
          })),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[FormScanner] Pipeline failed: ${message}`);
        return Response.json({ ok: false, error: message }, { status: 500 });
      }
    }

    // GET …/status — lightweight health check
    if (request.method === "GET" && url.pathname.endsWith("/status")) {
      return Response.json({
        lastScannedAt: this.s.lastScannedAt,
        pendingSignalCount: this.s.pendingSignalIds.length,
      });
    }

    return new Response("Not found", { status: 404 });
  }
}
