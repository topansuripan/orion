/**
 * ta/indicators.js
 *
 * Deterministic, PURE technical-analysis indicators for Orion.
 *
 * All functions operate on a normalized candle array of shape
 *   [{ t, o, h, l, c, v }]
 * (exactly what meteora/ohlcv.js `normalizeCandles` produces) and return
 * arrays ALIGNED BY INDEX with the input. Warm-up positions (where the
 * indicator is not yet defined) are `null`.
 *
 * No I/O. No side effects.
 */

/**
 * True Range array aligned by index.
 * TR_i = max(high-low, |high - prevClose|, |low - prevClose|).
 * For the first bar, TR = high - low (no previous close).
 *
 * @param {Array<{h:number,l:number,c:number}>} candles
 * @returns {number[]}
 */
function trueRange(candles) {
  const tr = new Array(candles.length);
  for (let i = 0; i < candles.length; i++) {
    const { h, l } = candles[i];
    if (i === 0) {
      tr[i] = h - l;
    } else {
      const prevClose = candles[i - 1].c;
      tr[i] = Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose));
    }
  }
  return tr;
}

/**
 * Average True Range using Wilder's smoothing.
 * First ATR (at index `period`) = simple average of the first `period` TRs.
 * Subsequent: ATR_i = (ATR_{i-1} * (period-1) + TR_i) / period.
 * `null` for index < period.
 *
 * @param {Array<{h:number,l:number,c:number}>} candles
 * @param {number} [period=14]
 * @returns {Array<number|null>}
 */
export function atr(candles, period = 14) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  if (n < period || period < 1) return out;

  const tr = trueRange(candles);

  // First defined ATR at index `period` = SMA of the first `period` TRs.
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  let prev = sum / period;
  out[period] = prev;

  for (let i = period + 1; i < n; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

/**
 * Bollinger Bands.
 * middle = SMA of close over `period`.
 * stddev = POPULATION standard deviation of close over the same window (÷N).
 * upper = middle + mult*stddev, lower = middle - mult*stddev.
 * `null` for index < period - 1.
 *
 * @param {Array<{c:number}>} candles
 * @param {{period?:number, mult?:number}} [opts]
 * @returns {{middle:Array<number|null>, upper:Array<number|null>, lower:Array<number|null>}}
 */
export function bollinger(candles, { period = 20, mult = 2 } = {}) {
  const n = candles.length;
  const middle = new Array(n).fill(null);
  const upper = new Array(n).fill(null);
  const lower = new Array(n).fill(null);
  if (period < 1) return { middle, upper, lower };

  for (let i = period - 1; i < n; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += candles[j].c;
    const mean = sum / period;

    let sqSum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = candles[j].c - mean;
      sqSum += d * d;
    }
    const std = Math.sqrt(sqSum / period); // population (÷N)

    middle[i] = mean;
    upper[i] = mean + mult * std;
    lower[i] = mean - mult * std;
  }
  return { middle, upper, lower };
}

/**
 * SuperTrend.
 * Uses ATR (Wilder) from `atr`. Bands are computed only once ATR is defined
 * (index >= period). Returns `{ value, direction }` aligned by index, with
 * `null` entries during warm-up (before ATR is defined). `direction` is
 * exactly "bullish" or "bearish".
 *
 * @param {Array<{h:number,l:number,c:number}>} candles
 * @param {{period?:number, mult?:number}} [opts]
 * @returns {Array<{value:number, direction:("bullish"|"bearish")}|null>}
 */
export function supertrend(candles, { period = 10, mult = 3 } = {}) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  const atrArr = atr(candles, period);

  let finalUpperPrev = null;
  let finalLowerPrev = null;
  let dirPrev = null; // "bullish" | "bearish"

  for (let i = 0; i < n; i++) {
    if (atrArr[i] == null) continue; // warm-up: ATR not yet defined

    const { h, l, c } = candles[i];
    const hl2 = (h + l) / 2;
    const basicUpper = hl2 + mult * atrArr[i];
    const basicLower = hl2 - mult * atrArr[i];

    let finalUpper;
    let finalLower;
    if (finalUpperPrev == null) {
      // First defined bar: seed final bands with basic bands.
      finalUpper = basicUpper;
      finalLower = basicLower;
    } else {
      const prevClose = candles[i - 1].c;
      finalUpper =
        basicUpper < finalUpperPrev || prevClose > finalUpperPrev
          ? basicUpper
          : finalUpperPrev;
      finalLower =
        basicLower > finalLowerPrev || prevClose < finalLowerPrev
          ? basicLower
          : finalLowerPrev;
    }

    // Direction — canonical TradingView formulation.
    // The flip test compares the CURRENT close to the CURRENT bar's final
    // bands (the carry rules above already encode the prior band state), and
    // the band to test is selected by the PREVIOUS direction:
    //   - prev "bearish" (supertrend sat on the upper band): flip bullish
    //     only when close breaks above the current upper band.
    //   - prev "bullish" (supertrend sat on the lower band): flip bearish
    //     only when close breaks below the current lower band.
    // `value` then sits on the lower band when bullish, upper band when bearish.
    // Seed the previous direction as "bullish" on the first ATR-defined bar so
    // bar one tests `close < finalLower` and may flip bearish immediately.
    const prevDir = dirPrev == null ? "bullish" : dirPrev;
    let direction;
    if (prevDir === "bearish") {
      direction = c > finalUpper ? "bullish" : "bearish";
    } else {
      direction = c < finalLower ? "bearish" : "bullish";
    }

    out[i] = {
      value: direction === "bullish" ? finalLower : finalUpper,
      direction,
    };

    finalUpperPrev = finalUpper;
    finalLowerPrev = finalLower;
    dirPrev = direction;
  }
  return out;
}

/**
 * Swing support/resistance from confirmed fractal pivots.
 * A pivot low at index i requires `lookback` bars on each side, with the low
 * at i STRICTLY lower than all `lookback` lows on each side. Pivot high is
 * the analogue with highs. Returns the MOST RECENT confirmed pivot low's low
 * (`support`) and pivot high's high (`resistance`); `null` if none found.
 *
 * @param {Array<{h:number,l:number}>} candles
 * @param {{lookback?:number}} [opts]
 * @returns {{support:number|null, resistance:number|null}}
 */
export function swingLevels(candles, { lookback = 5 } = {}) {
  const n = candles.length;
  let support = null;
  let resistance = null;
  if (lookback < 1) return { support, resistance };

  // Scan from the most recent confirmable pivot backwards so the first match
  // is the most recent.
  for (let i = n - lookback - 1; i >= lookback; i--) {
    if (support === null) {
      let isLow = true;
      for (let k = 1; k <= lookback; k++) {
        if (candles[i].l >= candles[i - k].l || candles[i].l >= candles[i + k].l) {
          isLow = false;
          break;
        }
      }
      if (isLow) support = candles[i].l;
    }
    if (resistance === null) {
      let isHigh = true;
      for (let k = 1; k <= lookback; k++) {
        if (candles[i].h <= candles[i - k].h || candles[i].h <= candles[i + k].h) {
          isHigh = false;
          break;
        }
      }
      if (isHigh) resistance = candles[i].h;
    }
    if (support !== null && resistance !== null) break;
  }
  return { support, resistance };
}
