/**
 * meteora/ohlcv.js
 *
 * Fetch + normalize OHLCV (candlestick) data for a Meteora DLMM pool.
 *
 * ---------------------------------------------------------------------------
 * UPSTREAM RESPONSE SHAPE — VERIFIED against a live response on 2026-06-16
 * via:
 *   curl --ssl-no-revoke \
 *     "https://dlmm.datapi.meteora.ag/pools/<POOL>/ohlcv?timeframe=1h"
 *
 * The endpoint returns a JSON OBJECT (not a bare array). The candle rows live
 * under the top-level `data` key:
 *
 *   {
 *     "start_time": 1781589600,
 *     "end_time":   1781622000,
 *     "timeframe":  "1h",
 *     "data": [
 *       {
 *         "timestamp": 1781589600,                       // unix seconds
 *         "timestamp_str": "2026-06-16T06:00:00+00:00",
 *         "open":   73.6612514109072,
 *         "high":   74.28248722215326,
 *         "low":    73.6612514109072,
 *         "close":  74.16375399956233,
 *         "volume": 446675.1820616891
 *       },
 *       ...
 *     ]
 *   }
 *
 * In the live sample o/h/l/c/v arrive as numbers, but `normalizeCandles`
 * coerces strings → numbers defensively in case the API or a cache layer ever
 * returns stringified values.
 *
 * The normalizer ALSO accepts common key variants for resilience:
 *   time key : t | time | timestamp | unixTime
 *   open     : o | open
 *   high     : h | high
 *   low      : l | low
 *   close    : c | close
 *   volume   : v | volume   (defaults to 0 if missing/invalid)
 *
 * Downstream indicator code consumes EXACTLY: [{ t, o, h, l, c, v }] where
 * o/h/l/c/v are finite numbers. A row missing any finite o/h/l/c is dropped.
 * ---------------------------------------------------------------------------
 */

const BASE_URL = "https://dlmm.datapi.meteora.ag";

/** First defined value among the given object keys. */
function pick(row, keys) {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null) return row[k];
  }
  return undefined;
}

/** Coerce to a finite number, or NaN if not coercible. */
function num(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/**
 * PURE. Map raw API rows to normalized candles [{t,o,h,l,c,v}].
 * Coerces stringified numbers and drops malformed rows
 * (any row missing a finite o/h/l/c).
 *
 * @param {Array<object>} rawRows
 * @returns {Array<{t:number,o:number,h:number,l:number,c:number,v:number}>}
 */
export function normalizeCandles(rawRows) {
  if (!Array.isArray(rawRows)) return [];

  const out = [];
  for (const row of rawRows) {
    if (!row || typeof row !== "object") continue;

    const t = num(pick(row, ["t", "time", "timestamp", "unixTime"]));
    const o = num(pick(row, ["o", "open"]));
    const h = num(pick(row, ["h", "high"]));
    const l = num(pick(row, ["l", "low"]));
    const c = num(pick(row, ["c", "close"]));
    let v = num(pick(row, ["v", "volume"]));

    // Drop rows missing any finite OHLC value (or a usable timestamp).
    if (
      !Number.isFinite(t) ||
      !Number.isFinite(o) ||
      !Number.isFinite(h) ||
      !Number.isFinite(l) ||
      !Number.isFinite(c)
    ) {
      continue;
    }

    // Volume is non-essential; default to 0 when missing/invalid.
    if (!Number.isFinite(v)) v = 0;

    out.push({ t, o, h, l, c, v });
  }
  return out;
}

/** Extract the candle-row array from a parsed JSON payload. */
function extractRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    for (const key of ["data", "candles", "ohlcv"]) {
      if (Array.isArray(payload[key])) return payload[key];
    }
  }
  return [];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch OHLCV for a Meteora DLMM pool and return normalized candles.
 * Retries with exponential backoff (3 attempts).
 *
 * @param {string} poolAddress
 * @param {{timeframe?:string, candles?:number}} [opts]
 * @returns {Promise<Array<{t:number,o:number,h:number,l:number,c:number,v:number}>>}
 */
export async function fetchOhlcv(
  poolAddress,
  { timeframe = "1h", candles = 200 } = {}
) {
  if (!poolAddress || typeof poolAddress !== "string") {
    throw new Error("fetchOhlcv: poolAddress (string) is required");
  }

  const url = `${BASE_URL}/pools/${encodeURIComponent(
    poolAddress
  )}/ohlcv?timeframe=${encodeURIComponent(timeframe)}`;

  const maxAttempts = 3;
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json" },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const payload = await res.json();
      const rows = extractRows(payload);
      const normalized = normalizeCandles(rows);
      // The API returns most-recent-last; cap to the requested count.
      return candles > 0 && normalized.length > candles
        ? normalized.slice(-candles)
        : normalized;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        await sleep(2 ** (attempt - 1) * 500); // 500ms, 1000ms
      }
    }
  }

  throw new Error(
    `fetchOhlcv failed for ${poolAddress} after ${maxAttempts} attempts: ${
      lastErr?.message ?? lastErr
    }`
  );
}
