import test from "node:test";
import assert from "node:assert";
import { atr } from "./indicators.js";

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
