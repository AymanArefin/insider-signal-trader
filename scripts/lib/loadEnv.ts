/**
 * Parses a .dev.vars file and returns a mock Env object suitable for use
 * in local test scripts that call the Worker's tool functions directly.
 *
 * Search order for .dev.vars:
 *   1. {project-root}/.dev.vars   (insider-signal-trader/.dev.vars)
 *   2. {parent-dir}/.dev.vars     (one level above the project root)
 */

import * as fs from "fs";
import * as path from "path";
import type { Env } from "../../src/types";

function parseDevVars(filePath: string): Record<string, string> {
  const content = fs.readFileSync(filePath, "utf-8");
  const vars: Record<string, string> = {};
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    vars[key] = value;
  }
  return vars;
}

export function loadEnv(): Env {
  const projectRoot = path.resolve(process.cwd());
  const candidates = [
    path.join(projectRoot, ".dev.vars"),
    path.join(projectRoot, "../.dev.vars"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      console.log(`\x1b[2m[loadEnv] credentials from ${candidate}\x1b[0m\n`);
      const v = parseDevVars(candidate);

      const required = ["ALPACA_API_KEY", "ALPACA_SECRET_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"];
      const missing = required.filter((k) => !v[k]);
      if (missing.length) {
        throw new Error(`Missing required vars in .dev.vars: ${missing.join(", ")}`);
      }

      return {
        // Secrets
        ALPACA_API_KEY: v.ALPACA_API_KEY,
        ALPACA_SECRET_KEY: v.ALPACA_SECRET_KEY,
        ANTHROPIC_API_KEY: v.ANTHROPIC_API_KEY ?? "",
        TELEGRAM_BOT_TOKEN: v.TELEGRAM_BOT_TOKEN,
        TELEGRAM_CHAT_ID: v.TELEGRAM_CHAT_ID,
        // Vars — fall back to sensible defaults if not set in .dev.vars
        ALPACA_BASE_URL: v.ALPACA_BASE_URL ?? "https://paper-api.alpaca.markets",
        ALPACA_DATA_URL: v.ALPACA_DATA_URL ?? "https://data.alpaca.markets",
        POSITION_SIZE_USD: v.POSITION_SIZE_USD ?? "10000",
        MIN_SIGNAL_SCORE: v.MIN_SIGNAL_SCORE ?? "50",
        APPROVAL_EXPIRY_HOURS: v.APPROVAL_EXPIRY_HOURS ?? "23",
        APPROVAL_BASE_URL: v.APPROVAL_BASE_URL ?? "http://localhost:8787",
        // Worker-only runtime bindings — not used in Node.js test scripts
        DB: null as unknown as D1Database,
        FORM_SCANNER: null as unknown as DurableObjectNamespace,
        DECISION: null as unknown as DurableObjectNamespace,
      };
    }
  }

  throw new Error(
    `Could not find .dev.vars — checked:\n${candidates.map((c) => `  ${c}`).join("\n")}\n` +
      `Copy .dev.vars.example to .dev.vars and fill in your credentials.`
  );
}
