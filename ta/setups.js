/**
 * ta/setups.js
 *
 * Orion's long-only entry / exit decision rules, built on the pure TA
 * indicators in ./indicators.js. These functions are PURE: they take a
 * normalized candle array [{t,o,h,l,c,v}] plus an `orion` config slice
 * (`cfg`) and return a plain decision — no I/O, no config import, no
 * side effects.
 */

import { supertrend, bollinger, swingLevels } from "./indicators.js";

/**
 * Shared, data-source-agnostic LONG entry decision.
 *
 * Operates on a normalized "signal summary" so the SAME rule serves both the
 * local candle path (this file's detectEntry, which derives the summary from
 * ta/indicators.js) and the relay path (ta/relay-setups.js, which derives it
 * from precomputed Agent Meridian indicators via buildSignalSummary). PURE.
 *
 * Summary fields used: { close, supertrendDirection, supertrendValue,
 * lowerBand, upperBand }. (`upperBand` is the resolved target band — for the
 * candle path it carries swing resistance; for the relay path the Bollinger
 * upper band.)
 *
 * Fires only when supertrendDirection === "bullish" AND either:
 *   - close pulled back to within `pullbackToSupportPct` above supertrendValue
 *     (supertrendValue ≤ close ≤ supertrendValue*(1+pct)), OR
 *   - close ≤ lowerBand.
 *
 * @param {{close:number, supertrendDirection:string, supertrendValue:number,
 *          lowerBand:number, upperBand:number}} summary
 * @param {object} cfg orion config slice
 * @returns {{entryPrice:number, stopPrice:number, targetPrice:number, reason:string}|null}
 */
export function decideEntry(summary, cfg) {
  if (!summary) return null;
  if (summary.supertrendDirection !== "bullish") return null;

  const close = summary.close;
  const stValue = summary.supertrendValue;
  const lowerBand = summary.lowerBand;
  const upperBand = summary.upperBand;

  // Pullback: price sits just above the rising support (not below it).
  const pullbackHit =
    Number.isFinite(stValue) &&
    Number.isFinite(close) &&
    close >= stValue &&
    close <= stValue * (1 + cfg.pullbackToSupportPct);

  // Below lower band (only when the band is defined).
  const belowBandHit =
    Number.isFinite(lowerBand) && Number.isFinite(close) && close <= lowerBand;

  if (!pullbackHit && !belowBandHit) return null;

  const entryPrice = stValue;
  if (!Number.isFinite(entryPrice)) return null;

  const stopPrice = entryPrice * (1 - cfg.stopLossPct);

  const targetPrice =
    Number.isFinite(upperBand) && upperBand > entryPrice
      ? upperBand
      : entryPrice + cfg.targetRMultiple * (entryPrice - stopPrice);

  const reason = pullbackHit
    ? "SuperTrend bullish + pullback to support"
    : "SuperTrend bullish + close below lower BB";

  return { entryPrice, stopPrice, targetPrice, reason };
}

/**
 * Shared, data-source-agnostic breakdown (market-exit) decision.
 *
 * Returns true when supertrendDirection === "bearish" OR close < the
 * position's stopPrice; false otherwise. Missing inputs yield false (no forced
 * exit) rather than throwing. PURE.
 *
 * @param {{close:number, supertrendDirection:string}} summary
 * @param {{stopPrice:number}} position
 * @param {object} cfg orion config slice
 * @returns {boolean}
 */
export function decideBreakdown(summary, position, cfg) {
  if (!summary || !position) return false;
  if (summary.supertrendDirection === "bearish") return true;
  if (
    Number.isFinite(position.stopPrice) &&
    Number.isFinite(summary.close) &&
    summary.close < position.stopPrice
  ) {
    return true;
  }
  return false;
}

/**
 * Detect a long entry setup on the latest bar.
 *
 * Fires only when the latest supertrend direction is "bullish" AND either:
 *   - the latest close has pulled back to within `pullbackToSupportPct` of the
 *     rising supertrend support (supertrendValue ≤ close ≤ supertrendValue*(1+pct)), OR
 *   - the latest close is at/below the lower Bollinger band.
 *
 * @param {Array<{t:number,o:number,h:number,l:number,c:number,v:number}>} candles
 * @param {object} cfg orion config slice
 * @returns {{entryPrice:number, stopPrice:number, targetPrice:number, reason:string}|null}
 */
export function detectEntry(candles, cfg) {
  const summary = summaryFromCandles(candles, cfg);
  if (!summary) return null;
  return decideEntry(summary, cfg);
}

/**
 * Build a normalized signal summary from a candle array using the local TA
 * indicators. The candle path historically targets swing RESISTANCE (not the
 * Bollinger upper band), so resistance is carried in the summary's `upperBand`
 * field — keeping decideEntry's target rule behavior-preserving for candles.
 *
 * @param {Array<{t:number,o:number,h:number,l:number,c:number,v:number}>} candles
 * @param {object} cfg orion config slice
 * @returns {{close:number, supertrendDirection:string, supertrendValue:number,
 *           lowerBand:number, upperBand:number}|null}
 */
function summaryFromCandles(candles, cfg) {
  if (!Array.isArray(candles) || candles.length === 0) return null;

  const st = supertrend(candles, {
    period: cfg.supertrendPeriod,
    mult: cfg.supertrendMultiplier,
  });
  const bb = bollinger(candles, {
    period: cfg.bbPeriod,
    mult: cfg.bbStdDev,
  });
  const { resistance } = swingLevels(candles);

  const i = candles.length - 1;
  const stLatest = st[i];
  if (stLatest == null) return null;

  return {
    close: candles[i].c,
    supertrendDirection: stLatest.direction,
    supertrendValue: stLatest.value,
    lowerBand: bb.lower[i],
    // Candle path targets swing resistance; carried via `upperBand`.
    upperBand: resistance,
  };
}

/**
 * Decide whether a held long position should be market-exited.
 *
 * Returns true if the latest supertrend direction is "bearish" OR the latest
 * close has fallen below the position's stop price; false otherwise. Missing
 * indicators / inputs at the latest bar yield false (no forced exit) rather
 * than throwing.
 *
 * @param {Array<{t:number,o:number,h:number,l:number,c:number,v:number}>} candles
 * @param {{entryPrice:number, stopPrice:number}} position
 * @param {object} cfg orion config slice
 * @returns {boolean}
 */
export function detectBreakdown(candles, position, cfg) {
  if (!Array.isArray(candles) || candles.length === 0) return false;
  if (!position) return false;

  const st = supertrend(candles, {
    period: cfg.supertrendPeriod,
    mult: cfg.supertrendMultiplier,
  });

  const i = candles.length - 1;
  const stLatest = st[i];

  const summary = {
    close: candles[i].c,
    supertrendDirection: stLatest == null ? "unknown" : stLatest.direction,
  };
  return decideBreakdown(summary, position, cfg);
}
