/**
 * DecisionAgent — Durable Object agent that turns scored insider signals into
 * human-reviewed trade recommendations.
 *
 * Pipeline (decide method):
 *  1. Fetch live portfolio + prices from Alpaca; fetch DB positions for days-held.
 *  2. Build a portfolio summary and a signals summary.
 *  3. Call Claude (Anthropic Messages API) with the combined context.
 *  4. Parse + validate LLM JSON output with Zod.
 *  5. For each actionable decision (BUY / SELL):
 *       a. insertRecommendation() → D1, status PENDING, returns UUID.
 *       b. sendApprovalMessage() → Telegram card with ✅/❌ buttons.
 *       c. schedule(expiry) → auto-expire if no human response.
 *
 * Persistent state tracks pending recommendation UUIDs so the expiry callback
 * can remove them after they resolve.
 */

import { Agent } from "@cloudflare/agents";
import { z } from "zod";
import type { AlpacaPosition, Env, PositionWithThesis, Recommendation, ScoredSignal } from "../types";
import { getBuyingPower, getPortfolio, getPositionPrices } from "../tools/alpaca";
import {
  getPositionsWithThesis,
  insertRecommendation,
  updateRecommendationStatus,
} from "../tools/db";
import { sendApprovalMessage, sendMessage } from "../tools/telegram";

// ---------- State ----------

interface DecisionState {
  /** UUIDs of recommendations that are still PENDING human approval. */
  pendingRecommendationIds: string[];
}

// ---------- Zod schemas ----------

/**
 * Validates and normalises a single decision from the LLM output.
 * The ticker transform upper-cases it so "aapl" → "AAPL".
 */
const LlmDecisionSchema = z.object({
  action: z.enum(["BUY", "SELL", "HOLD"]),
  ticker: z.string().min(1).transform((s) => s.toUpperCase().trim()),
  reasoning: z.string().min(1),
  notional: z.number().positive().optional(),
  qty: z.number().positive().optional(),
  // Accept number, null, or missing — treat null/0/negative as "not provided"
  // so we fall back to a plain market order when the LLM omits bracket levels.
  stopPrice: z.number().nullable().optional().transform((v) => (v != null && v > 0 ? v : undefined)),
  takeProfitPrice: z.number().nullable().optional().transform((v) => (v != null && v > 0 ? v : undefined)),
});
type LlmDecision = z.infer<typeof LlmDecisionSchema>;

const LlmDecisionsSchema = z.array(LlmDecisionSchema);

const AnthropicResponseSchema = z.object({
  content: z.array(
    z.object({ type: z.string(), text: z.string().optional() })
  ),
});

// ---------- Constants ----------

const ANTHROPIC_MODEL = "claude-opus-4-5";
const ANTHROPIC_MAX_TOKENS = 2048;

const SYSTEM_PROMPT =
  `You are a paper trading agent using SEC insider signals to make buy and sell decisions. ` +
  `You receive two sections of context:\n` +
  `1. PORTFOLIO: currently held positions with live P&L, days held, and — crucially — ` +
  `the original thesis (why the position was entered and which insider triggered it).\n` +
  `2. SIGNALS: new insider buy signals scored today.\n\n` +
  `Decision rules:\n` +
  `- BUY: only for tickers NOT already in the portfolio. Explain why the insider signal is compelling.\n` +
  `  For every BUY you MUST include stopPrice and takeProfitPrice based on your assessment of the ` +
  `trade's risk/reward. Use the insider signal context, typical stock volatility, and the following ` +
  `guidelines as a starting point:\n` +
  `    • stopPrice: entry price × (1 - stop_pct), where stop_pct is 5–12% depending on volatility.\n` +
  `    • takeProfitPrice: entry price × (1 + target_pct), where target_pct is 10–25%.\n` +
  `  Adjust these levels if the signal context suggests higher or lower conviction.\n` +
  `- SELL: evaluate each held position against its original thesis. Recommend SELL if: ` +
  `(a) P&L has deteriorated significantly (worse than -10%), ` +
  `(b) the position has been held >30 days with no meaningful gain, or ` +
  `(c) the original insider thesis appears to have played out or been invalidated. ` +
  `Reference the original reasoning in your explanation.\n` +
  `- HOLD: the thesis is intact and the position is within normal volatility.\n\n` +
  `Output ONLY a JSON array — no prose outside the array:\n` +
  `[{"action": "BUY"|"SELL"|"HOLD", "ticker": string, "reasoning": string, ` +
  `"notional"?: number, "qty"?: number, "stopPrice"?: number, "takeProfitPrice"?: number}]`;

// ---------- Agent class ----------

export class DecisionAgent extends Agent<Env, DecisionState> {
  initialState: DecisionState = {
    pendingRecommendationIds: [],
  };

  private get s(): DecisionState {
    const raw = this.state as Partial<DecisionState> | null;
    return {
      pendingRecommendationIds: Array.isArray(raw?.pendingRecommendationIds)
        ? raw.pendingRecommendationIds
        : [],
    };
  }

  // ---------- Summary builders ----------

  private buildPortfolioSummary(
    positions: AlpacaPosition[],
    prices: Record<string, number>,
    theses: PositionWithThesis[],
    buyingPower: number
  ): string {
    const bpLine = `Available buying power: $${buyingPower.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (positions.length === 0) return `${bpLine}\nOpen Positions: none`;

    // Build a lookup from ticker → thesis data (most recent entry if multiple)
    const thesisByTicker = new Map<string, PositionWithThesis>();
    for (const t of theses) {
      if (!thesisByTicker.has(t.ticker)) thesisByTicker.set(t.ticker, t);
    }

    const now = Date.now();

    const lines = positions.flatMap((pos) => {
      const entry = parseFloat(pos.avg_entry_price);
      const plPct = parseFloat(pos.unrealized_plpc) * 100;
      const plSign = plPct >= 0 ? "+" : "";
      const currentPrice = prices[pos.symbol];
      const currentStr =
        currentPrice !== undefined ? `$${currentPrice.toFixed(2)}` : "N/A";

      const thesis = thesisByTicker.get(pos.symbol);
      const daysHeld = thesis?.executedAt
        ? Math.floor((now - Date.parse(thesis.executedAt)) / 864e5)
        : "?";

      const header =
        `  ${pos.symbol.padEnd(6)}` +
        `  entry=$${entry.toFixed(2)}` +
        `  current=${currentStr}` +
        `  P&L=${plSign}${plPct.toFixed(2)}%` +
        `  held=${daysHeld}d`;

      if (!thesis) return [header];

      // Attach the original thesis so Claude can judge if it still holds
      const fmtVal =
        thesis.signalValue >= 1_000_000
          ? `$${(thesis.signalValue / 1_000_000).toFixed(2)}M`
          : `$${(thesis.signalValue / 1_000).toFixed(0)}K`;

      const thesisLines = [
        `    Original signal: ${thesis.insiderRole} ${thesis.insiderName} bought ${fmtVal} (score=${thesis.signalScore})`,
        `    Original reasoning: ${thesis.originalReasoning}`,
      ];

      return [header, ...thesisLines];
    });

    return `${bpLine}\nOpen Positions (${positions.length}):\n${lines.join("\n")}`;
  }

  private buildSignalsSummary(signals: ScoredSignal[]): string {
    if (signals.length === 0) return "Insider Buy Signals: none";

    const lines = signals.flatMap((s, i) => {
      const f = s.filing;
      const val =
        f.transactionValue >= 1_000_000
          ? `$${(f.transactionValue / 1_000_000).toFixed(2)}M`
          : `$${(f.transactionValue / 1_000).toFixed(0)}K`;
      return [
        `  ${i + 1}. ${f.ticker}  score=${s.score}  ${f.insiderRole}: ${f.insiderName}  ${val} on ${f.transactionDate}`,
        `     ${s.breakdownSummary}`,
      ];
    });

    return `Insider Buy Signals (${signals.length}):\n${lines.join("\n")}`;
  }

  // ---------- Anthropic LLM call ----------

  private async callAnthropic(userMessage: string): Promise<string> {
    let res: Response;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": this.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: ANTHROPIC_MAX_TOKENS,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userMessage }],
        }),
      });
    } catch (err) {
      throw new Error(`Anthropic network error: ${String(err)}`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Anthropic API HTTP ${res.status} ${res.statusText}: ${body}`
      );
    }

    let rawJson: unknown;
    try {
      rawJson = await res.json();
    } catch {
      throw new Error("Anthropic API returned non-JSON body");
    }

    const parsed = AnthropicResponseSchema.safeParse(rawJson);
    if (!parsed.success) {
      throw new Error(
        `Anthropic response shape unexpected: ${parsed.error.message}`
      );
    }

    return parsed.data.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("")
      .trim();
  }

  // ---------- LLM output parser ----------

  /**
   * Extracts and validates the JSON array from the LLM's raw text response.
   * Handles Claude wrapping output in a markdown ```json … ``` fence.
   */
  private extractDecisions(rawText: string): LlmDecision[] {
    const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    const candidate = fenceMatch ? fenceMatch[1].trim() : rawText;

    const start = candidate.indexOf("[");
    const end = candidate.lastIndexOf("]");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error(
        `LLM did not return a JSON array. Preview: ${rawText.slice(0, 300)}`
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate.slice(start, end + 1));
    } catch (err) {
      throw new Error(
        `LLM output is not valid JSON: ${String(err)}\nPreview: ${rawText.slice(0, 300)}`
      );
    }

    const validated = LlmDecisionsSchema.safeParse(parsed);
    if (!validated.success) {
      const issues = validated.error.issues
        .map((i) => `[${i.path.join(".")}] ${i.message}`)
        .join("; ");
      throw new Error(`LLM decisions schema mismatch: ${issues}`);
    }

    return validated.data;
  }

  // ---------- Main pipeline ----------

  /**
   * Runs the full decision pipeline for a batch of scored signals.
   *
   * @param scoredSignals  Qualifying signals from FormScannerAgent (already in D1).
   * @param env            Worker environment — passed explicitly so this method
   *                       is callable from outside (e.g. tests or the HTTP handler).
   */
  async decide(scoredSignals: ScoredSignal[], env: Env): Promise<void> {
    console.log(
      `[DecisionAgent] Pipeline start — ${scoredSignals.length} signal(s)`
    );

    // ── Step 1: Parallel fetch of live portfolio + buying power + DB theses ───
    const [positions, buyingPower, theses] = await Promise.all([
      getPortfolio(env).catch((err) => {
        console.error(`[DecisionAgent] getPortfolio failed: ${String(err)}`);
        return [] as AlpacaPosition[];
      }),
      getBuyingPower(env).catch((err) => {
        console.error(`[DecisionAgent] getBuyingPower failed: ${String(err)}`);
        return 0;
      }),
      getPositionsWithThesis(env.DB).catch((err) => {
        console.error(`[DecisionAgent] getPositionsWithThesis failed: ${String(err)}`);
        return [] as PositionWithThesis[];
      }),
    ]);

    const symbols = positions.map((p) => p.symbol);

    const prices =
      symbols.length > 0
        ? await getPositionPrices(env, symbols).catch((err) => {
            console.error(
              `[DecisionAgent] getPositionPrices failed: ${String(err)}`
            );
            return {} as Record<string, number>;
          })
        : {};

    console.log(
      `[DecisionAgent] Step 1 complete — ${positions.length} position(s), ` +
        `prices for ${Object.keys(prices).length} symbol(s), ` +
        `buying_power=$${buyingPower.toFixed(2)}, ` +
        `${theses.length} thesis record(s) from D1`
    );

    // ── Step 2: Build context strings ────────────────────────────────────────
    const portfolioSummary = this.buildPortfolioSummary(
      positions,
      prices,
      theses,
      buyingPower
    );
    const signalsSummary = this.buildSignalsSummary(scoredSignals);

    const userMessage = [
      portfolioSummary,
      "",
      signalsSummary,
      "",
      "Based on the above signals and portfolio state, provide your trading decisions.",
    ].join("\n");

    console.log("[DecisionAgent] Step 2 complete — context built, calling LLM");
    console.log(`[DecisionAgent] User message:\n${userMessage}`);

    // ── Step 3: LLM call ──────────────────────────────────────────────────────
    let rawOutput: string;
    try {
      rawOutput = await this.callAnthropic(userMessage);
    } catch (err) {
      console.error(`[DecisionAgent] LLM call failed: ${String(err)}`);
      throw err;
    }

    console.log(
      `[DecisionAgent] LLM response (first 400 chars): ${rawOutput.slice(0, 400)}`
    );

    let decisions: LlmDecision[];
    try {
      decisions = this.extractDecisions(rawOutput);
    } catch (err) {
      console.error(`[DecisionAgent] LLM output parse failed: ${String(err)}`);
      throw err;
    }

    console.log(
      `[DecisionAgent] Step 3 complete — ${decisions.length} decision(s) parsed`
    );

    // ── Step 4: Persist + notify per decision ─────────────────────────────────
    const portfolioTickers = new Set(symbols);

    // ticker → signalId lookup for linking recs to their originating signal
    const signalIdByTicker = new Map<string, number>(
      scoredSignals
        .filter((s) => s.signalId !== undefined)
        .map((s) => [s.filing.ticker, s.signalId!])
    );
    // Fallback: use any persisted signal ID from this batch (for SELL recs)
    const fallbackSignalId = scoredSignals.find((s) => s.signalId)?.signalId ?? 1;


    const newPendingIds: string[] = [];
    const expirySeconds =
      (Number(env.APPROVAL_EXPIRY_HOURS) || 23) * 3600;

    // Track how much buying power has been earmarked by earlier BUYs in this
    // same run so we don't queue up more orders than the account can fund.
    let remainingBuyingPower = buyingPower;

    for (const decision of decisions) {
      if (decision.action === "HOLD") {
        console.log(
          `[DecisionAgent] HOLD ${decision.ticker} — no action needed`
        );
        continue;
      }

      // Guard: BUY only for tickers not already held
      if (decision.action === "BUY" && portfolioTickers.has(decision.ticker)) {
        console.log(
          `[DecisionAgent] Skipping BUY ${decision.ticker} — already in portfolio`
        );
        continue;
      }

      // Guard: SELL only for tickers actually held
      if (
        decision.action === "SELL" &&
        !portfolioTickers.has(decision.ticker)
      ) {
        console.log(
          `[DecisionAgent] Skipping SELL ${decision.ticker} — not in portfolio`
        );
        continue;
      }

      // Resolve notional
      const position = positions.find((p) => p.symbol === decision.ticker);
      const currentPrice = prices[decision.ticker];

      let notional: number;
      if (decision.action === "BUY") {
        notional =
          decision.notional ?? (Number(env.POSITION_SIZE_USD) || 10_000);
      } else {
        // SELL: use Alpaca's reported market value; fall back to qty × price
        notional =
          position !== undefined
            ? parseFloat(position.market_value)
            : (decision.qty ?? 0) * (currentPrice ?? 0);
      }

      // Guard: BUY only when there is enough buying power to fund the order.
      // We deduct the notional from remainingBuyingPower immediately so that
      // multiple BUYs in the same run don't each see the full balance.
      if (decision.action === "BUY") {
        if (remainingBuyingPower < notional) {
          console.warn(
            `[DecisionAgent] Skipping BUY ${decision.ticker} — ` +
              `notional=$${notional.toFixed(2)} exceeds ` +
              `remaining buying power=$${remainingBuyingPower.toFixed(2)}`
          );
          continue;
        }
        remainingBuyingPower -= notional;
      }

      // signalId: prefer a matching signal for this ticker, fall back to batch
      const signalId =
        signalIdByTicker.get(decision.ticker) ?? fallbackSignalId;

      const rec: Omit<Recommendation, "id"> = {
        ticker: decision.ticker,
        action: decision.action,
        reasoning: decision.reasoning,
        signalId,
        status: "PENDING",
        notional,
        stopPrice: decision.stopPrice,
        takeProfitPrice: decision.takeProfitPrice,
      };

      // Persist to D1
      let recId: string;
      try {
        recId = await insertRecommendation(env.DB, rec);
        console.log(
          `[DecisionAgent] Persisted rec ${recId} — ` +
            `${decision.action} ${decision.ticker} notional=$${notional.toFixed(2)}`
        );
      } catch (err) {
        console.error(
          `[DecisionAgent] insertRecommendation failed for ` +
            `${decision.ticker}: ${String(err)}`
        );
        continue; // do not send Telegram if DB write failed
      }

      // Send Telegram approval card
      const fullRec: Recommendation = { ...rec, id: recId };
      try {
        await sendApprovalMessage(env, fullRec, currentPrice);
        console.log(`[DecisionAgent] Telegram approval card sent for ${recId}`);
      } catch (err) {
        // Non-fatal: recommendation is safely in D1; Telegram failure is observable
        console.error(
          `[DecisionAgent] sendApprovalMessage failed for ${recId}: ${String(err)}`
        );
      }

      // Schedule auto-expiry
      await this.schedule(expirySeconds, "expireRecommendation", {
        id: recId,
      });

      newPendingIds.push(recId);
    }

    // Persist updated pending IDs to agent state
    this.setState({
      pendingRecommendationIds: [
        ...this.s.pendingRecommendationIds,
        ...newPendingIds,
      ],
    });

    console.log(
      `[DecisionAgent] Pipeline complete — ${newPendingIds.length} recommendation(s) pending approval`
    );
  }

  // ---------- Scheduled callback: full pipeline ----------

  /**
   * Called by the Agents SDK scheduler on every user-configured recurring run.
   * Runs the full EDGAR → score → decide → Telegram pipeline.
   */
  async runPipelineFromScheduler(_payload: unknown): Promise<void> {
    const start = Date.now();
    console.log(`[DecisionAgent] Scheduled pipeline start`);

    // Step 1: Trigger FormScannerAgent
    const scannerStub = this.env.FORM_SCANNER.get(
      this.env.FORM_SCANNER.idFromName("daily-scanner")
    );

    let scanRes: Response;
    try {
      scanRes = await scannerStub.fetch(
        new Request("https://agent.internal/scan", {
          method: "POST",
          headers: { "x-partykit-room": "daily-scanner" },
        })
      );
    } catch (err) {
      const msg = String(err);
      console.error(`[DecisionAgent] FormScannerAgent unreachable: ${msg}`);
      await sendMessage(this.env, `🚨 *Pipeline Error*\n\nFormScannerAgent unreachable:\n\`${msg.slice(0, 300)}\``).catch(() => {});
      return;
    }

    let scanBody: { ok: boolean; error?: string; signalCount: number; signals: ScoredSignal[] };
    try {
      scanBody = await scanRes.json() as typeof scanBody;
    } catch (err) {
      await sendMessage(this.env, `🚨 *Pipeline Error*\n\nFormScannerAgent returned non-JSON (HTTP ${scanRes.status})`).catch(() => {});
      return;
    }

    if (!scanRes.ok || !scanBody.ok) {
      const msg = `Scan failed: ${scanBody.error ?? "unknown error"}`;
      console.error(`[DecisionAgent] ${msg}`);
      await sendMessage(this.env, `🚨 *Pipeline Error*\n\n${msg}`).catch(() => {});
      return;
    }

    console.log(`[DecisionAgent] Scan complete — ${scanBody.signalCount} signal(s)`);

    if (scanBody.signalCount === 0) {
      await sendMessage(
        this.env,
        `📭 *Daily Scan Complete*\n\nNo open-market insider purchases found in the last 3 days. No trades to evaluate today.`
      ).catch(() => {});
      return;
    }

    // Step 2: Run decide() directly (no HTTP round-trip needed)
    try {
      await this.decide(scanBody.signals, this.env);
    } catch (err) {
      const msg = String(err);
      console.error(`[DecisionAgent] decide() failed: ${msg}`);
      await sendMessage(this.env, `🚨 *Pipeline Error*\n\nDecision step failed:\n\`${msg.slice(0, 300)}\``).catch(() => {});
    }

    console.log(`[DecisionAgent] Scheduled pipeline done in ${Date.now() - start}ms`);
  }

  // ---------- Schedule management helpers ----------

  /** Cancel all existing pipeline schedules and set a new one. Returns schedule ID. */
  async setPipelineSchedule(cron: string, label: string): Promise<string> {
    // Remove any existing pipeline schedule
    const existing = this.getSchedules({ type: "cron" }).filter(
      (s) => s.callback === "runPipelineFromScheduler"
    );
    for (const s of existing) {
      await this.cancelSchedule(s.id);
    }
    const task = await this.schedule(cron, "runPipelineFromScheduler", { label });
    console.log(`[DecisionAgent] Pipeline schedule set: ${cron} (${label}) id=${task.id}`);
    return task.id;
  }

  /** Returns a human-readable summary of active pipeline schedules. */
  getPipelineSchedules(): Array<{ id: string; cron: string; nextRun: string; label: string }> {
    return this.getSchedules({ type: "cron" })
      .filter((s) => s.callback === "runPipelineFromScheduler")
      .map((s) => ({
        id: s.id,
        cron: (s as { cron?: string }).cron ?? "?",
        nextRun: new Date(s.time * 1000).toISOString(),
        label: String((s.payload as { label?: string })?.label ?? ""),
      }));
  }

  // ---------- Scheduled callback: auto-expiry ----------

  /**
   * Called by the Agents SDK scheduler after APPROVAL_EXPIRY_HOURS.
   * Transitions the recommendation to EXPIRED if it hasn't been resolved yet.
   * Errors are swallowed — the recommendation may already be APPROVED or REJECTED.
   */
  async expireRecommendation(payload: { id: string }): Promise<void> {
    console.log(
      `[DecisionAgent] Auto-expiring recommendation ${payload.id}`
    );
    try {
      await updateRecommendationStatus(
        this.env.DB,
        payload.id,
        "EXPIRED",
        new Date().toISOString()
      );
      this.setState({
        pendingRecommendationIds: this.s.pendingRecommendationIds.filter(
          (id) => id !== payload.id
        ),
      });
      console.log(`[DecisionAgent] Recommendation ${payload.id} expired`);
    } catch (err) {
      // Already resolved (APPROVED / REJECTED) — no action needed
      console.log(
        `[DecisionAgent] Could not expire ${payload.id} (likely already resolved): ${String(err)}`
      );
    }
  }

  // ---------- HTTP handler ----------

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // POST …/decide — called by FormScannerAgent with the signal batch
    if (request.method === "POST" && url.pathname.endsWith("/decide")) {
      try {
        const signals = (await request.json()) as ScoredSignal[];
        await this.decide(signals, this.env);
        return Response.json({
          ok: true,
          pendingCount: this.s.pendingRecommendationIds.length,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[DecisionAgent] /decide error: ${message}`);
        return Response.json({ ok: false, error: message }, { status: 500 });
      }
    }

    // POST …/pipeline/run — trigger pipeline immediately (used by /run endpoint)
    if (request.method === "POST" && url.pathname.endsWith("/pipeline/run")) {
      try {
        await this.runPipelineFromScheduler({});
        return Response.json({ ok: true });
      } catch (err) {
        return Response.json({ ok: false, error: String(err) }, { status: 500 });
      }
    }

    // POST …/pipeline/schedule — body: { cron, label }
    if (request.method === "POST" && url.pathname.endsWith("/pipeline/schedule")) {
      try {
        const { cron, label } = await request.json() as { cron: string; label: string };
        const id = await this.setPipelineSchedule(cron, label);
        return Response.json({ ok: true, id, cron, label });
      } catch (err) {
        return Response.json({ ok: false, error: String(err) }, { status: 500 });
      }
    }

    // GET …/pipeline/schedules — list active pipeline schedules
    if (request.method === "GET" && url.pathname.endsWith("/pipeline/schedules")) {
      return Response.json({ ok: true, schedules: this.getPipelineSchedules() });
    }

    // DELETE …/pipeline/schedule — cancel all pipeline schedules
    if (request.method === "DELETE" && url.pathname.endsWith("/pipeline/schedule")) {
      const schedules = this.getSchedules({ type: "cron" }).filter(
        (s) => s.callback === "runPipelineFromScheduler"
      );
      for (const s of schedules) await this.cancelSchedule(s.id);
      return Response.json({ ok: true, cancelled: schedules.length });
    }

    // GET …/status — lightweight health check
    if (request.method === "GET" && url.pathname.endsWith("/status")) {
      return Response.json({
        pendingRecommendationIds: this.s.pendingRecommendationIds,
        pipelineSchedules: this.getPipelineSchedules(),
      });
    }

    return new Response("Not found", { status: 404 });
  }
}
