/**
 * ta/aggregate.js
 *
 * Roll a fine-grained candle series up to a coarser timeframe. Orion's relay
 * (Agent Meridian /chart-indicators) only serves 5m/15m candles, so to run the
 * SuperTrend/Bollinger entry on a 1-HOUR timeframe we fetch 15m candles and
 * aggregate them here, then compute indicators locally (ta/indicators.js).
 *
 * PURE: no I/O, no mutation of the input array.
 */

/**
 * Aggregate relay candles into fixed-width time buckets.
 *
 * Relay candle shape: { time(SECONDS), open, high, low, close, volume }.
 * Output: normalized { t, o, h, l, c, v } candles (the shape ta/indicators.js
 * expects), one per bucket that has >=1 source candle, sorted ascending by
 * bucket-start time. open = first source open in the bucket, high = max high,
 * low = min low, close = last source close, volume = sum.
 *
 * Source candles are sorted by time first, so first/last are well-defined even
 * if the input is unordered. Entries missing a finite `time` are dropped.
 *
 * @param {Array<{time:number,open:number,high:number,low:number,close:number,volume:number}>} candles
 * @param {number} bucketSeconds bucket width in seconds (e.g. 3600 for 1h)
 * @returns {Array<{t:number,o:number,h:number,l:number,c:number,v:number}>}
 */
export function aggregateCandles(candles, bucketSeconds) {
  if (!Array.isArray(candles) || candles.length === 0 || !(bucketSeconds > 0)) {
    return [];
  }
  const sorted = candles
    .filter((c) => c && Number.isFinite(c.time))
    .sort((a, b) => a.time - b.time);

  const buckets = new Map();
  const order = [];
  for (const c of sorted) {
    const start = Math.floor(c.time / bucketSeconds) * bucketSeconds;
    let b = buckets.get(start);
    if (!b) {
      b = { t: start, o: c.open, h: c.high, l: c.low, c: c.close, v: 0 };
      buckets.set(start, b);
      order.push(start);
    } else {
      if (c.high > b.h) b.h = c.high;
      if (c.low < b.l) b.l = c.low;
      b.c = c.close; // last close in the bucket (input is sorted ascending)
    }
    b.v += Number.isFinite(c.volume) ? c.volume : 0;
  }
  return order.map((k) => buckets.get(k));
}

/**
 * Convenience: aggregate a relay candle series to 1-hour candles.
 * @param {Array<{time:number,open:number,high:number,low:number,close:number,volume:number}>} candles
 * @returns {Array<{t:number,o:number,h:number,l:number,c:number,v:number}>}
 */
export function aggregateTo1h(candles) {
  return aggregateCandles(candles, 3600);
}
