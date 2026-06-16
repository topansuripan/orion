import test from "node:test";
import assert from "node:assert";
import { atr, bollinger, supertrend } from "./indicators.js";

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

test("supertrend: warm-up before ATR is null/undefined and does not throw", () => {
  assert.deepStrictEqual(supertrend([], { period: 10 }), []);
  const tiny = [bar(10), bar(11)].map((b, i) => ({ t: i, ...b, v: 1 }));
  const st = supertrend(tiny, { period: 3 });
  assert.strictEqual(st.length, 2);
  // No defined ATR -> no defined trend entries.
  assert.ok(st.every((s) => s == null || s.direction == null));
});
