# Insider Signal Trader

An automated insider-signal paper trader built on the **Cloudflare Agents SDK**. It monitors SEC EDGAR Form 4 filings daily, scores open-market insider purchases, asks Claude (Anthropic) for a trading decision, and sends you a Telegram approval card. One tap places a bracket order on Alpaca paper trading.

The pipeline schedule is fully user-controlled from Telegram — no static cron required.

---

## How it works

```mermaid
flowchart TD
    TelegramUser([Telegram User])
    Worker["Worker\n/telegram/webhook"]
    FormScannerAgent["FormScannerAgent\nAgents SDK — state + onRequest"]
    DecisionAgent["DecisionAgent\nAgents SDK — state + schedule"]
    EDGAR["SEC EDGAR\nEFTS API"]
    D1[(D1 Database)]
    Claude["Claude\nAnthropic API"]
    TelegramAPI["Telegram\nBot API"]
    Alpaca["Alpaca\nPaper Trading API"]
    ApprovalRoute["Worker\nGET /approve?id=uuid"]

    TelegramUser -->|"trade / schedule / portfolio"| Worker
    Worker -->|"POST /scan\nx-partykit-room header"| FormScannerAgent
    FormScannerAgent -->|fetchForm4s| EDGAR
    FormScannerAgent -->|insertSignal| D1
    FormScannerAgent -->|signals| DecisionAgent
    DecisionAgent -->|"this.setState()"| DecisionAgent
    DecisionAgent -->|"this.schedule(cron)"| DecisionAgent
    DecisionAgent -->|callAnthropic| Claude
    Claude -->|"BUY/SELL/HOLD + stop/target"| DecisionAgent
    DecisionAgent -->|insertRecommendation| D1
    DecisionAgent -->|sendApprovalMessage| TelegramAPI
    TelegramAPI -->|approval card| TelegramUser
    TelegramUser -->|"tap Approve"| ApprovalRoute
    ApprovalRoute -->|paperBuyQty / paperBuyBracket| Alpaca
    ApprovalRoute -->|updateStatus APPROVED| D1
```

**Pipeline steps:**

1. `FormScannerAgent` fetches Form 4 filings from SEC EDGAR (1-day lookback, falls back to 3 days if no purchases), scores each open-market purchase on role, dollar value, cluster buys, and recency, then writes the top 10 signals to D1.
2. `DecisionAgent` calls Claude with the signals + live portfolio context and receives structured BUY/SELL/HOLD decisions including stop-loss and take-profit prices.
3. Each actionable decision is written to D1 as a `PENDING` recommendation and sent to Telegram as an approval card with **Approve** / **Reject** inline buttons.
4. Tapping **Approve** hits `GET /approve?id=<uuid>` on the Worker, which fetches the current price, calculates whole-share quantity, and places a bracket order (or plain market order) on Alpaca.

---

## Built on the Cloudflare Agents SDK

Both stateful services extend `Agent` from `@cloudflare/agents` — Durable Objects with embedded SQLite, typed state, and a built-in scheduler. The Agents SDK provides the stateful runtime (persistent state, scheduling, Durable Object lifecycle). Claude (Anthropic) is the external reasoning model used only for LLM inference and could be swapped for Workers AI with minimal changes.

```toml
# wrangler.toml — Agents SDK requires new_sqlite_classes (not new_classes)
[[migrations]]
tag = "v1"
new_sqlite_classes = ["FormScannerAgent", "DecisionAgent"]
```

---

### `FormScannerAgent`
*`src/agents/formScanner.ts` — `extends Agent<Env, FormScannerState>`*

Responsible for fetching, scoring, and persisting SEC insider signals.

**Persistent state (`FormScannerState`):**

| Field | Type | Description |
|---|---|---|
| `lastScannedAt` | `string \| null` | ISO-8601 UTC timestamp of the last completed scan |
| `pendingSignalIds` | `number[]` | D1 row IDs of signals not yet processed by `DecisionAgent` |

State is saved after every successful run via `this.setState()` and survives Worker restarts and deploys.

**HTTP endpoints (`onRequest`):**

| Method | Path | Description |
|---|---|---|
| `POST` | `/scan` | Run the full pipeline — returns `{ ok, signalCount, signals[] }` |
| `GET` | `/status` | Health check — returns `{ lastScannedAt, pendingSignalCount }` |

**`run()` pipeline (3 steps):**

1. **EDGAR fetch** — calls `fetchForm4s(1)` for yesterday's Form 4 filings. If no open-market purchases (`transactionType === "P"`) are found, automatically expands to a 3-day lookback to handle weekends and light filing days.
2. **Score** — `scoreSignals(filings)` filters to open-market purchases only, applies a multi-factor model (insider role, dollar value, cluster buys, recency), and returns the **top 10** sorted by score — no minimum score threshold.
3. **Persist** — each signal is written to D1 via `insertSignal()`. Per-signal failures are caught individually so one bad record doesn't abort the batch.

---

### `DecisionAgent`
*`src/agents/decision.ts` — `extends Agent<Env, DecisionState>`*

Orchestrates the full trading pipeline: Claude inference, D1 persistence, Telegram notifications, and user-controlled scheduling.

**Persistent state (`DecisionState`):**

| Field | Type | Description |
|---|---|---|
| `pendingRecommendationIds` | `string[]` | UUIDs of D1 recommendations still awaiting Telegram approval |

**HTTP endpoints (`onRequest`):**

| Method | Path | Description |
|---|---|---|
| `POST` | `/decide` | Accept a signals array and run `decide()` |
| `POST` | `/pipeline/run` | Trigger the full pipeline immediately (used by the `trade` Telegram command) |
| `POST` | `/pipeline/schedule` | Body `{ cron, label }` — set a recurring cron schedule |
| `GET` | `/pipeline/schedules` | List all active pipeline cron schedules with next-run times |
| `DELETE` | `/pipeline/schedule` | Cancel all active pipeline schedules |
| `GET` | `/status` | Returns `{ pendingRecommendationIds, pipelineSchedules }` |

**Scheduled callbacks (invoked by `this.schedule()`):**

| Callback | Trigger | What it does |
|---|---|---|
| `runPipelineFromScheduler()` | User-configured cron (e.g. `30 23 * * 1-5`) | Runs the full EDGAR → score → decide → Telegram pipeline |
| `expireRecommendation({ id })` | `APPROVAL_EXPIRY_HOURS` seconds after card is sent (default 23h) | Marks the recommendation `EXPIRED` in D1 if not yet approved or rejected |

**`decide()` pipeline (6 steps):**

1. **Parallel data fetch** — `getPortfolio()`, `getBuyingPower()`, and `getPositionsWithThesis()` run concurrently via `Promise.all()`.
2. **Portfolio summary** — builds a text block per position with entry price, current price, unrealised P&L %, days held, the original insider thesis, and insider name/role/value. This gives Claude the context to judge whether to exit a position.
3. **Signals summary** — formats each scored signal: ticker, score, insider role/name, transaction value, date, and the scoring breakdown.
4. **Claude inference** — calls `claude-opus-4-5` via the Anthropic Messages API with a strict system prompt (see below). Output is a pure JSON array — no prose.
5. **Zod validation** — parses and validates the LLM output. Handles markdown fences, normalises tickers to uppercase, and converts `null`/`0` stop and take-profit prices to `undefined` (triggering a plain market order fallback).
6. **Persist + notify** — for each actionable `BUY`/`SELL` decision:
   - Guards: skip BUY if ticker already held; skip SELL if ticker not held; skip BUY if remaining buying power is insufficient (tracked within the run).
   - Writes a `PENDING` recommendation to D1 via `insertRecommendation()`.
   - Sends a Telegram approval card via `sendApprovalMessage()`.
   - Schedules auto-expiry: `this.schedule(expirySeconds, "expireRecommendation", { id })`.
   - Updates `this.setState()` with the new pending recommendation IDs.

**Claude system prompt rules:**

- **BUY** — only for tickers not already in the portfolio. Must include `stopPrice` and `takeProfitPrice`:
  - `stopPrice` = entry × (1 − 5–12% depending on volatility)
  - `takeProfitPrice` = entry × (1 + 10–25% depending on conviction)
- **SELL** — evaluate each held position against its original thesis. Recommend SELL if:
  - P&L has deteriorated below −10%
  - Held > 30 days with no meaningful gain
  - Original insider thesis has played out or been invalidated
- **HOLD** — thesis intact, position within normal volatility
- Output format: strict JSON array `[{ action, ticker, reasoning, notional?, qty?, stopPrice?, takeProfitPrice? }]`

### Why Agents SDK vs plain Durable Objects

| Concern | Plain Durable Object | Agents SDK (`@cloudflare/agents`) |
|---|---|---|
| Persistent state | `ctx.storage.get/put` (key-value) | `this.setState()` / `this.state` (typed object, SQLite-backed) |
| Scheduling | External cron in `wrangler.toml` | `this.schedule(cron\|delay\|date, method, payload)` — stored in Agent SQLite, user-controlled |
| HTTP routing | Manual `fetch()` dispatch | `onRequest()` with automatic routing |
| WebSockets | Manual `acceptWebSocket()` | `onConnect()` / `onMessage()` built in |

---

## Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)
- [Alpaca Markets account](https://alpaca.markets/) — paper trading, free
- [Anthropic API key](https://console.anthropic.com/)
- [Telegram bot](https://t.me/BotFather) created via @BotFather
- Node.js 18+ and `npm`
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) — `npm install -g wrangler`
- [GitHub CLI](https://cli.github.com/) — optional, for one-command push

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/<you>/insider-signal-trader
cd insider-signal-trader
npm install
```

### 2. Authenticate Wrangler

```bash
npx wrangler login
```

### 3. Create the D1 database

```bash
npx wrangler d1 create insider-trader
```

Copy the `database_id` output into `wrangler.toml` under `[[d1_databases]]`, then run the schema migrations:

```bash
npx wrangler d1 execute insider-trader --remote --file=db/schema.sql
npx wrangler d1 execute insider-trader --remote --file=db/migrations/v2_stop_limit.sql
```

### 4. Set secrets

Secrets are stored encrypted in Cloudflare — they are never in your code or `wrangler.toml`:

```bash
npx wrangler secret put ALPACA_API_KEY
npx wrangler secret put ALPACA_SECRET_KEY
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
```

### 5. Update `wrangler.toml`

Fill in your Worker's subdomain for the approval deep-link:

```toml
[vars]
APPROVAL_BASE_URL = "https://insider-signal-trader.<your-subdomain>.workers.dev"
```

### 6. Deploy

```bash
npm run deploy
```

### 7. Register the Telegram webhook (one-time)

Open this URL in your browser after deploying:

```
https://insider-signal-trader.<your-subdomain>.workers.dev/telegram/setup
```

You should see `{"ok":true}`. Telegram will now forward all bot messages to your Worker.

### 8. Schedule the daily scan from Telegram

Open your Telegram bot and send:

```
schedule 6:30 PM weekdays
```

The `DecisionAgent` converts this to a UTC cron expression, stores it in its embedded SQLite via `this.schedule()`, and responds with a confirmation. The schedule persists across deploys.

---

## Local development

```bash
cp .dev.vars.example .dev.vars
# Fill in your credentials in .dev.vars
npm run dev
```

> **Note:** Durable Objects (and therefore Agents) run in the local Miniflare environment. The `.dev.vars` file is loaded automatically by Wrangler and is excluded from git.

---

## Telegram command reference

| Command | Action |
|---|---|
| `trade` | Run the full pipeline immediately |
| `portfolio` | Show live Alpaca account balance + positions |
| `schedule 6:30 PM weekdays` | Set a recurring scan time (CST, converted to UTC cron) |
| `when` | Show the current schedule and next run time |
| `cancel schedule` | Remove the recurring schedule |

Typos are handled — e.g. `portofolio`, `/portfolio`, `positions` all trigger the portfolio command.

---

## Project structure

```
src/
  index.ts              # Worker entry point — Telegram webhook handler, request routing
  agents/
    formScanner.ts      # Agents SDK — EDGAR fetch → score → D1
    decision.ts         # Agents SDK — Claude LLM, this.schedule(), Telegram cards
  routes/
    approval.ts         # GET /approve and /reject handlers → Alpaca
  tools/
    alpaca.ts           # Alpaca REST API wrapper (paperBuyQty, paperBuyBracket)
    edgar.ts            # SEC EDGAR EFTS fetch + XML parser
    scoring.ts          # Multi-factor signal scoring model
    telegram.ts         # Telegram Bot API wrapper
    db.ts               # D1 query helpers
  types.ts              # Shared TypeScript interfaces
db/
  schema.sql            # Initial D1 schema
  migrations/           # Incremental schema changes
scripts/
  test-approval.ts      # End-to-end approval smoke test
  test-telegram.ts      # Telegram card smoke test
  test-live-flow.ts     # Seeds D1 + sends a real live approval card to Telegram
wrangler.toml           # Cloudflare Worker + Agents SDK (new_sqlite_classes) config
.dev.vars.example       # Template for local environment variables
```

---

## Running tests

```bash
npm run test:telegram    # Send a test Telegram approval card
npm run test:approval    # Full approve → Alpaca order end-to-end test
npm run test:live        # Seed D1 + send a real approval card (click in Telegram to complete)
```

---

## Security notes

- **Never commit `.dev.vars`** — it is listed in `.gitignore`
- All production secrets are managed via `wrangler secret put` and stored encrypted in Cloudflare
- The Alpaca configuration defaults to `paper-api.alpaca.markets` (paper trading only)
- Approval deep-links are single-use UUIDs tied to a specific recommendation in D1
