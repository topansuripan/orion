import { test } from "node:test";
import assert from "node:assert";
import { normalizeCandles } from "./ohlcv.js";

// Real Meteora shape uses `timestamp` + open/high/low/close/volume (confirmed live).
test("normalizeCandles maps real Meteora rows to {t,o,h,l,c,v} numbers", () => {
  const raw = [
    { timestamp: 1, open: "2", high: "4", low: "1", close: "3", volume: "10" },
  ];
  assert.deepStrictEqual(normalizeCandles(raw), [
    { t: 1, o: 2, h: 4, l: 1, c: 3, v: 10 },
  ]);
});

test("normalizeCandles drops malformed rows", () => {
  const raw = [
    { timestamp: 1, open: "2", high: "4", low: "1", close: "3", volume: "10" },
    { timestamp: 2, open: "x", high: null, low: 1, close: 3, volume: 5 }, // bad
  ];
  assert.strictEqual(normalizeCandles(raw).length, 1);
});

test("normalizeCandles accepts short-key variant {t,o,h,l,c,v}", () => {
  const raw = [{ t: 1, o: 2, h: 4, l: 1, c: 3, v: 10 }];
  assert.deepStrictEqual(normalizeCandles(raw), [
    { t: 1, o: 2, h: 4, l: 1, c: 3, v: 10 },
  ]);
});

test("normalizeCandles defaults volume to 0 when missing/invalid", () => {
  const raw = [{ timestamp: 1, open: 2, high: 4, low: 1, close: 3 }];
  assert.deepStrictEqual(normalizeCandles(raw), [
    { t: 1, o: 2, h: 4, l: 1, c: 3, v: 0 },
  ]);
});

test("normalizeCandles returns [] for non-array input", () => {
  assert.deepStrictEqual(normalizeCandles(null), []);
  assert.deepStrictEqual(normalizeCandles(undefined), []);
  assert.deepStrictEqual(normalizeCandles({}), []);
});
