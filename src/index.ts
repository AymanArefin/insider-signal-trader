/**
 * Worker entry point — insider-signal-trader
 *
 * Two exports:
 *
 *  scheduled()  Cron handler (5:36 PM CST / 23:36 UTC, weekdays).
 *               Orchestrates the full pipeline:
 *                 FormScannerAgent → EDGAR + score + D1
 *                 DecisionAgent    → LLM + Telegram approval cards
 *
 *  fetch()      HTTP handler.
 *               GET /approve?id=  → approval route
 *               GET /reject?id=   → rejection route
 *               Everything else   → 404
 *
 * Durable Object classes must be re-exported from this module so Wrangler
 * can bind them in wrangler.toml.
 */

import { FormScannerAgent } from "./agents/formScanner";
import { DecisionAgent } from "./agents/decision";
import { handleApproval } from "./routes/approval";
import { getAccount, getPortfolio, getPositionPrices } from "./tools/alpaca";
import { getPositionsWithThesis } from "./tools/db";
import { sendMessage, sendPortfolioSummary } from "./tools/telegram";
import type { Env, ScoredSignal } from "./types";

export { FormScannerAgent, DecisionAgent };

// ---------- Helpers ----------

/** Milliseconds since epoch formatted as a short timestamp for log lines. */
function ts(): string {
  return new Date().toISOString();
}

/**
 * Returns the singleton Durable Object stub for FormScannerAgent.
 * Always uses the same instance name so state accumulates across cron runs.
 */
function scannerStub(env: Env): DurableObjectStub {
  return env.FORM_SCANNER.get(env.FORM_SCANNER.idFromName("daily-scanner"));
}

/**
 * Returns the singleton Durable Object stub for DecisionAgent.
 */
function decisionStub(env: Env): DurableObjectStub {
  return env.DECISION.get(env.DECISION.idFromName("daily-decision"));
}

// ---------- Pipeline ----------

/**
 * Full cron pipeline.  Separated from `scheduled` so it can be awaited
 * cleanly and wrapped in `ctx.waitUntil` for lifetime management.
 *
 * Never throws — all errors are caught, logged, and the function returns
 * normally so the Worker runtime records a successful cron invocation rather
 * than a crash.
 */
async function runPipeline(env: Env): Promise<void> {
  const start = Date.now();
  console.log(`[pipeline] ${ts()} — start`);

  // ── Step 1: FormScannerAgent — EDGAR → score → D1 ──────────────────────────
  let scanRes: Response;
  try {
    scanRes = await scannerStub(env).fetch(
      new Request("https://agent.internal/scan", {
        method: "POST",
        headers: { "x-partykit-room": "daily-scanner" },
      })
    );
  } catch (err) {
    const msg = String(err);
    console.error(`[pipeline] ${ts()} — FormScannerAgent unreachable: ${msg}`);
    try {
      await sendMessage(env, `🚨 *Pipeline Error*\n\nFormScannerAgent unreachable:\n\`${msg.slice(0, 300)}\``);
    } catch { /* swallow */ }
    return;
  }

  let scanBody: {
    ok: boolean;
    error?: string;
    signalCount: number;
    signals: ScoredSignal[];
  };
  try {
    scanBody = await scanRes.json();
  } catch (err) {
    const msg = `FormScannerAgent returned non-JSON (HTTP ${scanRes.status}): ${String(err)}`;
    console.error(`[pipeline] ${ts()} — ${msg}`);
    try {
      await sendMessage(env, `🚨 *Pipeline Error*\n\n${msg.slice(0, 300)}`);
    } catch { /* swallow */ }
    return;
  }

  if (!scanRes.ok || !scanBody.ok) {
    const msg = `FormScannerAgent scan failed (HTTP ${scanRes.status}): ${scanBody.error ?? "no error message"}`;
    console.error(`[pipeline] ${ts()} — ${msg}`);
    try {
      await sendMessage(env, `🚨 *Pipeline Error*\n\n${msg.slice(0, 300)}`);
    } catch { /* swallow */ }
    return;
  }

  console.log(
    `[pipeline] ${ts()} — scan complete, ${scanBody.signalCount} qualifying signal(s)`
  );

  if (scanBody.signalCount === 0) {
    console.log(
      `[pipeline] ${ts()} — no open-market purchases found even with 3-day lookback, skipping decision step`
    );
    try {
      await sendMessage(
        env,
        `📭 *Daily Scan Complete*\n\nNo open-market insider purchases found in the last 3 days. No trades to evaluate today.`
      );
    } catch (err) {
      console.error(`[pipeline] ${ts()} — failed to send no-signals Telegram message: ${String(err)}`);
    }
    console.log(
      `[pipeline] ${ts()} — done (${Date.now() - start} ms)`
    );
    return;
  }

  // ── Step 2: DecisionAgent — LLM → Telegram approval cards ──────────────────
  let decideRes: Response;
  try {
    decideRes = await decisionStub(env).fetch(
      new Request("https://agent.internal/decide", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-partykit-room": "daily-decision",
        },
        body: JSON.stringify(scanBody.signals),
      })
    );
  } catch (err) {
    const msg = String(err);
    console.error(`[pipeline] ${ts()} — DecisionAgent unreachable: ${msg}`);
    try {
      await sendMessage(env, `🚨 *Pipeline Error*\n\nDecisionAgent unreachable:\n\`${msg.slice(0, 300)}\``);
    } catch { /* swallow */ }
    return;
  }

  let decideBody: { ok: boolean; error?: string; pendingCount?: number };
  try {
    decideBody = await decideRes.json();
  } catch (err) {
    const msg = `DecisionAgent returned non-JSON (HTTP ${decideRes.status}): ${String(err)}`;
    console.error(`[pipeline] ${ts()} — ${msg}`);
    try {
      await sendMessage(env, `🚨 *Pipeline Error*\n\n${msg.slice(0, 300)}`);
    } catch { /* swallow */ }
    return;
  }

  if (!decideRes.ok || !decideBody.ok) {
    const msg = `DecisionAgent decision failed (HTTP ${decideRes.status}): ${decideBody.error ?? "no error message"}`;
    console.error(`[pipeline] ${ts()} — ${msg}`);
    try {
      await sendMessage(env, `🚨 *Pipeline Error*\n\n${msg.slice(0, 300)}`);
    } catch { /* swallow */ }
    return;
  }

  const pendingCount = decideBody.pendingCount ?? 0;
  console.log(
    `[pipeline] ${ts()} — decision complete, ` +
      `${pendingCount} recommendation(s) pending approval`
  );

  if (pendingCount === 0) {
    try {
      await sendMessage(
        env,
        `📭 *Daily Scan Complete*\n\n${scanBody.signalCount} signal(s) were scored but the agent decided to *HOLD* all positions — no trades pending.`
      );
    } catch (err) {
      console.error(`[pipeline] ${ts()} — failed to send all-hold Telegram message: ${String(err)}`);
    }
  }

  console.log(
    `[pipeline] ${ts()} — done (${Date.now() - start} ms)`
  );
}

// ---------- Telegram webhook ----------

/** Minimal Telegram Update shape — only the fields we act on. */
interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; username?: string };
    chat: { id: number };
    text?: string;
  };
}

const PORTFOLIO_KEYWORDS = [
  "portfolio", "portofolio", "portfoilio", "portfollio",
  "/portfolio", "/portofolio",
  "net worth", "networth", "balance",
  "holdings", "positions", "account",
];

const TRADE_KEYWORDS = [
  "trade", "/trade", "scan", "/scan", "run", "signal", "insider", "analyze", "start",
];

/**
 * Parses a Telegram message like "schedule 6:30 PM weekdays" into a UTC cron string.
 * All times are interpreted as US Central Time (CST = UTC−6).
 * Returns null if no time can be parsed.
 */
function parseScheduleCommand(text: string): { cron: string; label: string } | null {
  const ampmRe = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;
  const h24Re  = /\b([01]?\d|2[0-3]):([0-5]\d)\b/;

  let hours: number;
  let minutes: number;

  const ampmMatch = text.match(ampmRe);
  if (ampmMatch) {
    hours   = parseInt(ampmMatch[1]);
    minutes = parseInt(ampmMatch[2] ?? "0");
    const period = ampmMatch[3].toLowerCase();
    if (period === "pm" && hours !== 12) hours += 12;
    if (period === "am" && hours === 12) hours  = 0;
  } else {
    const m24 = text.match(h24Re);
    if (!m24) return null;
    hours   = parseInt(m24[1]);
    minutes = parseInt(m24[2]);
  }

  if (hours > 23 || minutes > 59) return null;

  // Convert CST (UTC−6) → UTC
  let utcHours = hours + 6;
  const rollsOver = utcHours >= 24;
  if (rollsOver) utcHours -= 24;

  // CST Mon–Fri that rolls past midnight becomes UTC Tue–Sat (2-6)
  const isWeekdays = /weekday|work.?day|mon.*fri/i.test(text);
  const days = isWeekdays ? (rollsOver ? "2-6" : "1-5") : "*";

  const cron  = `${minutes} ${utcHours} * * ${days}`;
  const h12   = hours > 12 ? hours - 12 : hours === 0 ? 12 : hours;
  const ampm  = hours >= 12 ? "PM" : "AM";
  const label = `${h12}:${String(minutes).padStart(2, "0")} ${ampm} CST ${isWeekdays ? "weekdays" : "daily"}`;

  return { cron, label };
}

/**
 * Handles incoming Telegram webhook updates (POST /telegram/webhook).
 *
 * Commands:
 *  portfolio / balance / positions  → live Alpaca account summary
 *  trade / scan / run               → triggers the full pipeline immediately
 *  schedule [time] [weekdays|daily] → set a recurring pipeline schedule
 *  when / next scan                 → show current schedule
 *  cancel schedule                  → remove the recurring schedule
 */
async function handleTelegramWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let update: TelegramUpdate;
  try {
    update = await request.json() as TelegramUpdate;
  } catch {
    return new Response("Bad request — expected JSON body", { status: 400 });
  }

  const message = update.message;
  if (!message?.text) {
    return new Response("OK", { status: 200 });
  }

  const msgText = message.text.toLowerCase().trim();
  const chatId = String(message.chat.id);

  // ── Portfolio summary ──────────────────────────────────────────────────────
  if (PORTFOLIO_KEYWORDS.some((kw) => msgText.includes(kw))) {
    console.log(`[webhook] ${ts()} — portfolio query from chat ${chatId}`);
    try {
      const [account, positions, theses] = await Promise.all([
        getAccount(env),
        getPortfolio(env),
        getPositionsWithThesis(env.DB),
      ]);
      const symbols = positions.map((p) => p.symbol);
      const prices = symbols.length > 0 ? await getPositionPrices(env, symbols) : {};
      await sendPortfolioSummary(env, account, positions, prices, chatId, theses);
    } catch (err) {
      console.error(`[webhook] ${ts()} — portfolio query failed: ${String(err)}`);
      try {
        await sendMessage(
          env,
          `⚠️ Failed to fetch account data: ${err instanceof Error ? err.message : String(err)}`,
          chatId
        );
      } catch { /* swallow */ }
    }
    return new Response("OK", { status: 200 });
  }

  // ── Schedule management ───────────────────────────────────────────────────
  const rawText = message.text.trim(); // preserve original case for time parsing

  if (msgText.startsWith("schedule") || msgText.startsWith("/schedule")) {
    const parsed = parseScheduleCommand(rawText);
    if (!parsed) {
      await sendMessage(
        env,
        `⏰ *Schedule the pipeline*\n\n` +
        `Tell me when to run, e.g.:\n` +
        `• \`schedule 6:30 PM weekdays\`\n` +
        `• \`schedule 9 AM daily\`\n` +
        `• \`schedule 18:30 weekdays\``,
        chatId
      ).catch(() => {});
      return new Response("OK", { status: 200 });
    }

    try {
      const res = await decisionStub(env).fetch(
        new Request("https://agent.internal/pipeline/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-partykit-room": "daily-decision" },
          body: JSON.stringify({ cron: parsed.cron, label: parsed.label }),
        })
      );
      const body = await res.json() as { ok: boolean; error?: string };
      if (body.ok) {
        await sendMessage(
          env,
          `✅ *Schedule set!*\n\n` +
          `Pipeline will run at *${parsed.label}*\n` +
          `_(UTC cron: \`${parsed.cron}\`)_\n\n` +
          `Say *cancel schedule* to remove it.`,
          chatId
        ).catch(() => {});
      } else {
        await sendMessage(env, `❌ Failed to set schedule: ${body.error}`, chatId).catch(() => {});
      }
    } catch (err) {
      await sendMessage(env, `❌ Error: ${String(err)}`, chatId).catch(() => {});
    }
    return new Response("OK", { status: 200 });
  }

  if (msgText.includes("cancel schedule") || msgText.includes("unschedule") || msgText.includes("remove schedule")) {
    try {
      const res = await decisionStub(env).fetch(
        new Request("https://agent.internal/pipeline/schedule", {
          method: "DELETE",
          headers: { "x-partykit-room": "daily-decision" },
        })
      );
      const body = await res.json() as { ok: boolean; cancelled: number };
      await sendMessage(
        env,
        body.cancelled > 0
          ? `🗑 *Schedule cancelled.* The pipeline will no longer run automatically.\n\nSay *trade* to run it manually anytime.`
          : `ℹ️ No active schedule found.`,
        chatId
      ).catch(() => {});
    } catch (err) {
      await sendMessage(env, `❌ Error: ${String(err)}`, chatId).catch(() => {});
    }
    return new Response("OK", { status: 200 });
  }

  if (
    msgText.includes("when") || msgText.includes("next scan") ||
    msgText.includes("next run") || msgText.includes("show schedule")
  ) {
    try {
      const res = await decisionStub(env).fetch(
        new Request("https://agent.internal/pipeline/schedules", {
          headers: { "x-partykit-room": "daily-decision" },
        })
      );
      const body = await res.json() as { ok: boolean; schedules: Array<{ cron: string; nextRun: string; label: string }> };
      if (body.schedules.length === 0) {
        await sendMessage(
          env,
          `📭 *No schedule set.*\n\nSay something like:\n\`schedule 6:30 PM weekdays\`\nto set one.`,
          chatId
        ).catch(() => {});
      } else {
        const lines = body.schedules.map((s) => {
          const nextLocal = new Date(s.nextRun).toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "short", timeStyle: "short" });
          return `• *${s.label}* — next run: ${nextLocal} CST`;
        });
        await sendMessage(env, `⏰ *Active Schedule:*\n\n${lines.join("\n")}`, chatId).catch(() => {});
      }
    } catch (err) {
      await sendMessage(env, `❌ Error: ${String(err)}`, chatId).catch(() => {});
    }
    return new Response("OK", { status: 200 });
  }

  // ── Immediate pipeline trigger ("trade", "scan", "run", etc.) ─────────────
  if (TRADE_KEYWORDS.some((kw) => msgText.includes(kw))) {
    console.log(`[webhook] ${ts()} — pipeline trigger from chat ${chatId}`);
    try {
      await sendMessage(env, `🔍 *Scanning EDGAR for insider signals…*\n\nI'll send you approval cards shortly if I find anything worth trading.`, chatId);
    } catch { /* swallow */ }

    ctx.waitUntil(
      runPipeline(env).catch((err) =>
        console.error(`[webhook/run] unhandled: ${String(err)}`)
      )
    );
    return new Response("OK", { status: 200 });
  }

  // ── Help / unknown command ─────────────────────────────────────────────────
  try {
    await sendMessage(
      env,
      `👋 *Available commands:*\n\n` +
      `• *portfolio* — show live account & positions\n` +
      `• *trade* — scan EDGAR & propose trades now\n` +
      `• *schedule 6:30 PM weekdays* — set a recurring scan time\n` +
      `• *when* — show the current schedule\n` +
      `• *cancel schedule* — remove the recurring schedule`,
      chatId
    );
  } catch { /* swallow */ }

  return new Response("OK", { status: 200 });
}

// ---------- Exports ----------

export default {
  // ── Scheduled cron handler ──────────────────────────────────────────────────
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    console.log(`[scheduled] ${ts()} — cron triggered`);

    ctx.waitUntil(
      runPipeline(env).then(() => {
        console.log(`[scheduled] ${ts()} — pipeline resolved`);
      }).catch((err) => {
        // runPipeline is designed not to throw, but this guard ensures
        // any unexpected exception is logged rather than silently swallowed.
        console.error(
          `[scheduled] ${ts()} — unhandled pipeline exception: ${String(err)}`
        );
      })
    );
  },

  // ── HTTP fetch handler ──────────────────────────────────────────────────────
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (
        url.pathname.startsWith("/approve") ||
        url.pathname.startsWith("/reject")
      ) {
        return await handleApproval(request, env);
      }

      if (url.pathname === "/telegram/webhook") {
        return await handleTelegramWebhook(request, env, ctx);
      }

      // One-time webhook registration — GET /telegram/setup
      // Hit this URL once after deploying to register the bot with Telegram.
      if (url.pathname === "/telegram/setup") {
        const workerUrl = `${url.protocol}//${url.host}`;
        const webhookUrl = `${workerUrl}/telegram/webhook`;
        const res = await fetch(
          `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: webhookUrl, allowed_updates: ["message"] }),
          }
        );
        const body = await res.json() as { ok: boolean; description?: string };
        if (body.ok) {
          return new Response(`✅ Webhook registered: ${webhookUrl}`, { status: 200 });
        }
        return new Response(`❌ Webhook registration failed: ${body.description ?? "unknown error"}`, { status: 500 });
      }

      // Manual pipeline trigger — GET /run?secret=<ALPACA_API_KEY>
      // Allows firing the full pipeline on demand without waiting for the cron.
      if (url.pathname === "/run") {
        if (url.searchParams.get("secret") !== env.ALPACA_API_KEY) {
          return new Response("Forbidden", { status: 403 });
        }
        ctx.waitUntil(
          runPipeline(env).catch((err) =>
            console.error(`[fetch/run] unhandled: ${String(err)}`)
          )
        );
        return new Response("Pipeline triggered — check Telegram for results.", { status: 202 });
      }

      return new Response("Not found", { status: 404 });
    } catch (err) {
      // Top-level guard — approval errors that escaped their own handler
      console.error(
        `[fetch] ${ts()} — unhandled error on ${url.pathname}: ${String(err)}`
      );
      return new Response("Internal server error", { status: 500 });
    }
  },
};
