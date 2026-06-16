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
  if (!Array.isArray(candles) || candles.length === 0) return null;

  const st = supertrend(candles, {
    period: cfg.supertrendPeriod,
    mult: cfg.supertrendMultiplier,
  });
  const bb = bollinger(candles, {
    period: cfg.bbPeriod,
    mult: cfg.bbStdDev,
  });
  const { support, resistance } = swingLevels(candles);

  const i = candles.length - 1;
  const stLatest = st[i];
  const lowerLatest = bb.lower[i];

  // Latest-bar indicators must be defined.
  if (stLatest == null) return null;
  if (stLatest.direction !== "bullish") return null;

  const latestClose = candles[i].c;
  const stValue = stLatest.value;

  // Pullback: price sits just above the rising support (not below it).
  const pullbackHit =
    Number.isFinite(stValue) &&
    latestClose >= stValue &&
    latestClose <= stValue * (1 + cfg.pullbackToSupportPct);

  // Below lower Bollinger band (only when the band is defined at this bar).
  const belowBandHit =
    Number.isFinite(lowerLatest) && latestClose <= lowerLatest;

  if (!pullbackHit && !belowBandHit) return null;

  // entryPrice = supertrend support value; swing support is a fallback only
  // when the supertrend value is unusable.
  const entryPrice = Number.isFinite(stValue) ? stValue : support;
  if (!Number.isFinite(entryPrice)) return null;

  const stopPrice = entryPrice * (1 - cfg.stopLossPct);

  const targetPrice =
    Number.isFinite(resistance) && resistance > entryPrice
      ? resistance
      : entryPrice + cfg.targetRMultiple * (entryPrice - stopPrice);

  const reason = pullbackHit
    ? "SuperTrend bullish + pullback to support"
    : "SuperTrend bullish + close below lower BB";

  return { entryPrice, stopPrice, targetPrice, reason };
}
