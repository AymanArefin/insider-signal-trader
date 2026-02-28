/**
 * EDGAR tool — fetches and parses SEC Form 4 (insider transaction) filings.
 *
 * Pipeline per call:
 *  1. Query EDGAR EFTS full-text search API for Form 4 filings filed yesterday.
 *  2. For each hit, resolve the primary XML document via the EDGAR filing index JSON.
 *  3. Fetch the XML and extract: ticker, insider name/role, transaction code, shares,
 *     price, and computed notional value.
 *  4. Return one Filing per nonDerivativeTransaction (P/S/A/D codes only).
 *
 * Public API:
 *  fetchForm4s(): Promise<Filing[]>
 */

import { z } from "zod";
import type { Filing } from "../types";

// ---------- Date ----------

/** Returns yesterday's date as "YYYY-MM-DD" in UTC. */
function getYesterday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Returns a date N calendar days ago as "YYYY-MM-DD" in UTC. */
function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// ---------- Zod schemas ----------

const EftsHitSchema = z.object({
  /** EDGAR accession number, e.g. "0001234567-24-000001". May include ":filename" suffix. */
  _id: z.string().min(1),
  _source: z.object({
    /** EFTS uses "display_names" in newer API versions; entity_name may be absent. */
    entity_name: z.string().catch(""),
    file_date: z.string(),
    /** EFTS returns "form" (not "form_type") in the _source payload; filtering is
     *  already applied via the `&forms=4` query parameter so this is informational only. */
    form: z.string().catch(""),
    period_ending: z.string().optional(),
  }),
});

const EftsResponseSchema = z.object({
  hits: z.object({
    hits: z.array(EftsHitSchema),
    total: z.object({ value: z.number() }),
  }),
});

const IndexItemSchema = z.object({
  name: z.string(),
  type: z.string().optional(),
});

/**
 * The EDGAR filing directory index JSON.
 * `item` is an array when the filing has multiple documents, and a single object
 * when there is only one document — so we accept both shapes.
 */
const IndexResponseSchema = z.object({
  directory: z.object({
    item: z.union([z.array(IndexItemSchema), IndexItemSchema]),
  }),
});

// ---------- Accession helpers ----------

/**
 * The first segment of an EDGAR accession number is the CIK, zero-padded to 10 digits.
 * Returns the CIK as a plain integer string with no leading zeros.
 */
function cikFromAccession(accession: string): string | null {
  const first = accession.split("-")[0];
  if (!first || !/^\d+$/.test(first)) return null;
  return String(parseInt(first, 10));
}

function stripHyphens(accession: string): string {
  return accession.replace(/-/g, "");
}

// ---------- Minimal XML helpers (no DOM available in Workers) ----------

/**
 * Extracts the trimmed text content of the first matching `<tag>…</tag>`.
 * Handles tags with attributes; returns null if not found.
 */
function xmlTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>\\s*([^<]+?)\\s*</${tag}>`, "i");
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

/**
 * Returns the inner content of the first matching `<tag>…</tag>` block,
 * preserving any nested elements. Returns null if not found.
 */
function xmlBlock(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = xml.match(re);
  return m ? m[1] : null;
}

/** Extracts `<inner>` from within the first `<outer>` block. */
function xmlNested(xml: string, outer: string, inner: string): string | null {
  const block = xmlBlock(xml, outer);
  return block ? xmlTag(block, inner) : null;
}

// ---------- Form 4 domain parsing ----------

/**
 * Derives a human-readable role string from the reportingOwnerRelationship block.
 * Priority: officer title → director → 10% owner → other.
 */
function deriveRole(ownerXml: string): string {
  const rel = xmlBlock(ownerXml, "reportingOwnerRelationship") ?? "";
  if (xmlTag(rel, "isOfficer") === "1") {
    return xmlTag(rel, "officerTitle") ?? "Officer";
  }
  if (xmlTag(rel, "isDirector") === "1") return "Director";
  if (xmlTag(rel, "isTenPercentOwner") === "1") return "10% Owner";
  return "Other";
}

const VALID_TX_CODES = new Set<string>(["P", "S", "A", "D"]);

/**
 * Parses all nonDerivativeTransaction entries from a Form 4 XML string.
 * Returns one partial Filing per qualifying transaction (P/S/A/D codes only).
 */
function parseTransactions(xml: string): Array<Omit<Filing, "rawXml">> {
  const ticker = (xmlNested(xml, "issuer", "issuerTradingSymbol") ?? "").toUpperCase();
  const ownerBlock = xmlBlock(xml, "reportingOwner") ?? "";
  const insiderName = xmlNested(ownerBlock, "reportingOwnerId", "rptOwnerName") ?? "Unknown";
  const insiderRole = deriveRole(ownerBlock);

  const results: Array<Omit<Filing, "rawXml">> = [];
  const txRe = /<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/gi;
  let m: RegExpExecArray | null;

  while ((m = txRe.exec(xml)) !== null) {
    const tx = m[1];
    const code = xmlTag(tx, "transactionCode");
    if (!code || !VALID_TX_CODES.has(code)) continue;

    const transactionDate = xmlNested(tx, "transactionDate", "value") ?? "";
    const shares = parseFloat(xmlNested(tx, "transactionShares", "value") ?? "0");
    const price = parseFloat(xmlNested(tx, "transactionPricePerShare", "value") ?? "0");

    // Skip transactions where we can't determine a sensible value
    if (!ticker || !transactionDate || isNaN(shares)) continue;

    results.push({
      ticker,
      insiderName,
      insiderRole,
      transactionDate,
      transactionType: code as Filing["transactionType"],
      sharesTraded: shares,
      pricePerShare: isNaN(price) ? 0 : price,
      transactionValue: isNaN(price) ? 0 : shares * price,
    });
  }

  return results;
}

// ---------- Network ----------

const EDGAR_HEADERS: HeadersInit = {
  /**
   * SEC Fair Access policy requires identifying the application and a contact email.
   * https://www.sec.gov/developer
   */
  "User-Agent": "insider-signal-trader (automated research) contact@example.com",
  "Accept-Encoding": "gzip",
};

/**
 * Derives the XML document URL from an EFTS hit `_id`.
 *
 * Modern EFTS hits embed the XML filename directly in `_id` using the format
 * `{accession}:{xmlfilename}` (e.g. `0001234567-24-000001:wk-form4_123.xml`).
 * When the filename is present we build the URL directly from it, avoiding a
 * round-trip to the filing index JSON.
 *
 * For legacy `_id` values that contain only the accession number (no colon),
 * we fall back to fetching the `{accession}-index.json` to discover the XML file.
 */
async function resolveXmlUrl(id: string): Promise<string | null> {
  const colonIdx = id.indexOf(":");
  if (colonIdx !== -1) {
    // Fast path — filename is embedded in _id
    const accession = id.slice(0, colonIdx);
    const filename = id.slice(colonIdx + 1);
    const cik = cikFromAccession(accession);
    if (!cik) return null;
    return (
      `https://www.sec.gov/Archives/edgar/data/${cik}/` +
      `${stripHyphens(accession)}/${filename}`
    );
  }

  // Slow path — fetch the index JSON to discover the XML filename
  const accession = id;
  const cik = cikFromAccession(accession);
  if (!cik) return null;

  const nodashes = stripHyphens(accession);
  const indexUrl =
    `https://www.sec.gov/Archives/edgar/data/${cik}/${nodashes}/${accession}-index.json`;

  const res = await fetch(indexUrl, { headers: EDGAR_HEADERS });
  if (!res.ok) {
    await res.body?.cancel();
    return null;
  }

  const indexParsed = IndexResponseSchema.safeParse(await res.json());
  if (!indexParsed.success) return null;

  const rawItems = indexParsed.data.directory.item;
  const items = Array.isArray(rawItems) ? rawItems : [rawItems];

  const xmlFile = items.find(
    (it) =>
      it.name.endsWith(".xml") &&
      it.type !== "GRAPHIC" &&
      it.type !== "XSLT" &&
      !it.name.startsWith("xsl")
  );

  if (!xmlFile) return null;
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${nodashes}/${xmlFile.name}`;
}

/**
 * Fetches a single EDGAR filing and parses it into zero or more Filing records
 * (one per qualifying nonDerivativeTransaction).
 * Accepts the raw EFTS `_id` value (may contain `:{filename}` suffix).
 * Returns an empty array on any per-filing network or parse error so that a
 * single bad filing does not abort the entire batch.
 */
async function processFiling(id: string): Promise<Filing[]> {
  const xmlUrl = await resolveXmlUrl(id);
  if (!xmlUrl) return [];

  const xmlRes = await fetch(xmlUrl, { headers: EDGAR_HEADERS });
  if (!xmlRes.ok) {
    await xmlRes.body?.cancel();
    return [];
  }

  const xml = await xmlRes.text();
  return parseTransactions(xml).map((t) => ({ ...t, rawXml: xml }));
}

/**
 * Processes `items` in parallel batches of `concurrency`.
 * Uses `Promise.allSettled` so one failed item does not cancel the batch.
 */
async function batchedSettle<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<Filing[]>
): Promise<Filing[]> {
  const results: Filing[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const settled = await Promise.allSettled(items.slice(i, i + concurrency).map(fn));
    for (const r of settled) {
      if (r.status === "fulfilled") results.push(...r.value);
    }
  }
  return results;
}

// ---------- Public API ----------

/**
 * Fetches SEC Form 4 insider-transaction filings from EDGAR EFTS.
 *
 * @param lookbackDays - How many calendar days back to search (default 1 = yesterday only).
 *                       Pass 3 to cover a long weekend or a day with sparse purchases.
 *
 * Throws a descriptive Error on:
 *  - Network failure reaching the EDGAR EFTS search endpoint.
 *  - Non-2xx HTTP status from EDGAR EFTS.
 *  - Unexpected response shape from EDGAR EFTS (Zod validation failure).
 *
 * Individual per-filing fetch errors are swallowed and result in empty contributions
 * to the returned array rather than a thrown exception.
 */
export async function fetchForm4s(lookbackDays = 1): Promise<Filing[]> {
  const endDate = getYesterday();
  const startDate = lookbackDays > 1 ? daysAgo(lookbackDays) : endDate;
  const searchUrl =
    `https://efts.sec.gov/LATEST/search-index` +
    `?q=%22form+4%22&forms=4&dateRange=custom&startdt=${startDate}&enddt=${endDate}`;

  let searchRes: Response;
  try {
    searchRes = await fetch(searchUrl, { headers: EDGAR_HEADERS });
  } catch (err) {
    throw new Error(
      `EDGAR EFTS network error — could not reach ${searchUrl}: ${String(err)}`
    );
  }

  if (!searchRes.ok) {
    throw new Error(
      `EDGAR EFTS request failed with HTTP ${searchRes.status} ${searchRes.statusText} — ` +
        `URL: ${searchUrl}`
    );
  }

  let rawJson: unknown;
  try {
    rawJson = await searchRes.json();
  } catch {
    throw new Error(
      `EDGAR EFTS returned non-JSON body for date ${date} — ` +
        `Content-Type: ${searchRes.headers.get("Content-Type") ?? "unknown"}`
    );
  }

  const parsed = EftsResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `[${i.path.join(".")}] ${i.message}`)
      .join("; ");
    throw new Error(`EDGAR EFTS response shape mismatch for date ${date}: ${issues}`);
  }

  // Pass the raw _id values — resolveXmlUrl handles the {accession}:{filename} format
  const ids = parsed.data.hits.hits.map((h) => h._id);
  if (ids.length === 0) return [];

  // Fetch and parse each filing with 6 parallel connections
  // (keeps concurrent subrequests well within Workers limits)
  return batchedSettle(ids, 6, processFiling);
}
