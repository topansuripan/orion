/**
 * ta/relay-setups.js
 *
 * Relay adapter: applies Orion's SHARED entry/exit decision rules
 * (decideEntry / decideBreakdown from ./setups.js) to PRECOMPUTED indicators
 * returned by the Agent Meridian relay, rather than to locally-computed
 * indicators from a (truncated, ~10-candle) OHLCV feed.
 *
 * The relay returns ~180-266 candles of server-computed SuperTrend / Bollinger
 * / RSI / Fibonacci. buildSignalSummary() (from tools/chart-indicators.js)
 * extracts the latest normalized summary used by the decision rules.
 *
 * PURE w.r.t. the payload: these take a relay payload object (already fetched)
 * and return a decision — no network I/O here.
 */

import { buildSignalSummary } from "../tools/chart-indicators.js";
import { decideEntry, decideBreakdown } from "./setups.js";

/**
 * Long entry decision from a precomputed relay payload.
 *
 * Returns null when the summary lacks usable data (supertrendValue or close not
 * finite — e.g. the EMC-SOL 7-candle case where the server could not compute
 * SuperTrend). Never throws on malformed/empty payloads.
 *
 * @param {object} payload relay { latest: {...} } payload
 * @param {object} cfg orion config slice
 * @returns {{entryPrice:number, stopPrice:number, targetPrice:number, reason:string}|null}
 */
export function detectEntryFromIndicators(payload, cfg) {
  const summary = buildSignalSummary(payload);
  if (!Number.isFinite(summary.supertrendValue) || !Number.isFinite(summary.close)) {
    return null;
  }
  return decideEntry(summary, cfg);
}

/**
 * Breakdown (market-exit) decision from a precomputed relay payload.
 *
 * @param {object} payload relay { latest: {...} } payload
 * @param {{entryPrice:number, stopPrice:number}} position
 * @param {object} cfg orion config slice
 * @returns {boolean}
 */
export function detectBreakdownFromIndicators(payload, position, cfg) {
  const summary = buildSignalSummary(payload);
  return decideBreakdown(summary, position, cfg);
}
