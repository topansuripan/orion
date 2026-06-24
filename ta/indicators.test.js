import test from "node:test";
import assert from "node:assert";
import { atr, bollinger, supertrend, swingLevels } from "./indicators.js";

const NEAR = 1e-9;
const close = (a, b) => assert.ok(Math.abs(a - b) < NEAR, `expected ${a} ≈ ${b}`);

// Fixture for ATR (period 3). Columns: o,h,l,c (volume arbitrary).
// TR:  i0=2, i1=2, i2=2, i3=2, i4=3
// ATR(3): null,null,null, ATR3=avg(2,2,2)=2, ATR4=(2*2+3)/3=7/3
const atrFix = [
  { t: 0, o: 9, h: 10, l: 8, c: 9, v: 1 },
  { t: 1, o: 9, h: 11, l: 9, c: 10.5, v: 1 },
  { t: 2, o: 10.5, h: 12, l: 10, c: 11, v: 1 },
  { t: 3, o: 11, h: 11.5, l: 9.5, c: 10, v: 1 },
  { t: 4, o: 10, h: 13, l: 11, c: 12.5, v: 1 },
];

test("atr: warm-up nulls and Wilder smoothing on hand-computed fixture", () => {
  const out = atr(atrFix, 3);
  assert.strictEqual(out.length, atrFix.length);
  assert.strictEqual(out[0], null);
  assert.strictEqual(out[1], null);
  assert.strictEqual(out[2], null);
  close(out[3], 2);
  close(out[4], 7 / 3);
});

test("atr: edge cases do not throw", () => {
  assert.deepStrictEqual(atr([], 14), []);
  assert.deepStrictEqual(atr(atrFix, 10), [null, null, null, null, null]);
});

// --- 2.2 Bollinger Bands ---
// closes [2,4,6,8,10], period 3, mult 2.
// pop stddev of every length-3 window = sqrt(8/3) (mean differs per window).
const bbFix = [2, 4, 6, 8, 10].map((c, i) => ({ t: i, o: c, h: c, l: c, c, v: 1 }));

test("bollinger: SMA + population stddev on hand-computed fixture", () => {
  const std = Math.sqrt(8 / 3);
  const { middle, upper, lower } = bollinger(bbFix, { period: 3, mult: 2 });

  assert.strictEqual(middle.length, bbFix.length);
  assert.strictEqual(middle[0], null);
  assert.strictEqual(middle[1], null);
  assert.strictEqual(upper[1], null);
  assert.strictEqual(lower[1], null);

  close(middle[2], 4);
  close(middle[3], 6);
  close(middle[4], 8);

  close(upper[2], 4 + 2 * std);
  close(lower[2], 4 - 2 * std);
  close(upper[4], 8 + 2 * std);
  close(lower[4], 8 - 2 * std);
});

test("bollinger: edge cases do not throw", () => {
  const empty = bollinger([], { period: 20 });
  assert.deepStrictEqual(empty, { middle: [], upper: [], lower: [] });
  const short = bollinger(bbFix, { period: 10 });
  assert.deepStrictEqual(short.middle, [null, null, null, null, null]);
});

// --- 2.3 SuperTrend ---
// Build a candle with a fixed range around a midpoint price.
const bar = (p, range = 2) => ({ o: p, h: p + range / 2, l: p - range / 2, c: p });

test("supertrend: steadily rising fixture is bullish with value below close", () => {
  const rising = [];
  for (let i = 0; i < 12; i++) rising.push({ t: i, ...bar(10 + i * 2), v: 1 });
  const st = supertrend(rising, { period: 3, mult: 3 });

  assert.strictEqual(st.length, rising.length);
  const last = st[st.length - 1];
  assert.strictEqual(last.direction, "bullish");
  assert.ok(last.value < rising[rising.length - 1].c, "value should sit below close in uptrend");
});

test("supertrend: rise then sharp fall flips bullish -> bearish", () => {
  const candles = [];
  // Rising leg: bars 0..7
  for (let i = 0; i < 8; i++) candles.push({ t: i, ...bar(10 + i * 2), v: 1 });
  // Sharp fall: bars 8..11 drop hard
  let p = candles[candles.length - 1].o;
  for (let i = 8; i < 12; i++) {
    p -= 8;
    candles.push({ t: i, ...bar(p, 2), v: 1 });
  }
  const st = supertrend(candles, { period: 3, mult: 3 });

  // Find a defined bullish entry, then a later bearish entry => a flip happened.
  const dirs = st.map((s) => (s && s.direction) || null);
  const firstBull = dirs.findIndex((d) => d === "bullish");
  assert.ok(firstBull !== -1, "should be bullish during the rising leg");
  const flipIdx = dirs.findIndex((d, i) => i > firstBull && d === "bearish");
  assert.ok(flipIdx !== -1, "direction should flip to bearish after the sharp fall");
  assert.strictEqual(st[st.length - 1].direction, "bearish");
});

test("supertrend: exact {value,direction} on hand-computed period-3 fixture", () => {
  // bar(p): { o:p, h:p+1, l:p-1, c:p }. Prices rise by 2: 10,12,14,16,18.
  // True Range: TR0 = h-l = 2.
  //   TR_i (i>0) = max(h-l, |h-prevClose|, |l-prevClose|); prevClose = p-2,
  //   so h-prevClose = (p+1)-(p-2) = 3, l-prevClose = 1, h-l = 2 => TR = 3.
  //   TR = [2, 3, 3, 3, 3].
  // ATR(3) is first defined at index 3 (= SMA of TR0..TR2), so bars 0..2 are null:
  //   ATR3 = avg(2,3,3) = 8/3.
  //   ATR4 = (8/3*2 + 3)/3 = (16/3 + 9/3)/3 = (25/3)/3 = 25/9.
  //
  // SuperTrend (mult 3), seed previous-direction = "bullish":
  // Bar 3 (first ATR-defined): p=16 (h=17,l=15,c=16), hl2=16, ATR=8/3.
  //   basicUpper = 16 + 3*(8/3) = 24 ; basicLower = 16 - 8 = 8.
  //   First defined bar -> finalUpper=24, finalLower=8.
  //   prevDir(seed)=bullish -> close<finalLower? 16<8? no -> bullish.
  //   value = finalLower = 8.
  // Bar 4 (fully defined): p=18 (h=19,l=17,c=18), hl2=18, ATR=25/9.
  //   basicUpper = 18 + 25/3 = 79/3 (~26.333); basicLower = 18 - 25/3 = 29/3 (~9.667).
  //   Carry: finalUpperPrev=24, finalLowerPrev=8, prevClose=candles[3].c=16.
  //     finalUpper: (79/3<24? no) || (16>24? no) -> keep 24.
  //     finalLower: (29/3>8? yes) -> take basicLower = 29/3.
  //   prevDir=bullish -> close<finalLower? 18 < 29/3 (~9.667)? no -> bullish.
  //   value = finalLower = 29/3.
  const prices = [10, 12, 14, 16, 18];
  const stFix = prices.map((p, i) => ({ t: i, ...bar(p, 2), v: 1 }));
  const st = supertrend(stFix, { period: 3, mult: 3 });

  assert.strictEqual(st.length, stFix.length);
  assert.strictEqual(st[0], null);
  assert.strictEqual(st[1], null);
  assert.strictEqual(st[2], null);

  // Bar 3 (first ATR-defined bar).
  close(st[3].value, 8);
  assert.strictEqual(st[3].direction, "bullish");

  // Bar 4 (fully defined; exercises the carry rule from bar 3).
  close(st[4].value, 29 / 3);
  assert.strictEqual(st[4].direction, "bullish");
});

test("supertrend: warm-up before ATR is null/undefined and does not throw", () => {
  assert.deepStrictEqual(supertrend([], { period: 10 }), []);
  const tiny = [bar(10), bar(11)].map((b, i) => ({ t: i, ...b, v: 1 }));
  const st = supertrend(tiny, { period: 3 });
  assert.strictEqual(st.length, 2);
  // No defined ATR -> no defined trend entries.
  assert.ok(st.every((s) => s == null || s.direction == null));
});

// --- 2.4 Swing support/resistance ---
// lookback 2.
// Pivot lows: i=2 (low=2, neighbors 5,4 / 4,5) and i=8 (low=7, neighbors 8,9 / 9,10).
//   => most recent pivot low is i=8 => support=7.
// Pivot highs: i=5 (15) and i=8 (16). Most recent => i=8 => resistance=16.
const lows = [5, 4, 2, 4, 5, 6, 8, 9, 7, 9, 10];
const highs = [10, 11, 9, 8, 12, 15, 13, 14, 16, 12, 11];
const swingFix = lows.map((l, i) => ({
  t: i,
  o: (highs[i] + l) / 2,
  h: highs[i],
  l,
  c: (highs[i] + l) / 2,
  v: 1,
}));

test("swingLevels: most-recent pivot low and pivot high on hand-computed fixture", () => {
  const { support, resistance } = swingLevels(swingFix, { lookback: 2 });
  assert.strictEqual(support, 7);
  assert.strictEqual(resistance, 16);

  // Trimming bars after the i=2 pivot low isolates it as the most recent.
  const trimmed = swingLevels(swingFix.slice(0, 5), { lookback: 2 });
  assert.strictEqual(trimmed.support, 2);
});

test("swingLevels: returns null fields when no pivot exists / edge cases", () => {
  assert.deepStrictEqual(swingLevels([], { lookback: 5 }), {
    support: null,
    resistance: null,
  });
  // Too few candles to confirm any pivot at lookback 5.
  assert.deepStrictEqual(swingLevels(swingFix.slice(0, 3), { lookback: 5 }), {
    support: null,
    resistance: null,
  });
});
