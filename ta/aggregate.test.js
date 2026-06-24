import { test } from "node:test";
import assert from "node:assert";
import { aggregateCandles, aggregateTo1h } from "./aggregate.js";

// Build a 15m relay candle. time in seconds.
const c = (time, o, h, l, close, v = 1) => ({ time, open: o, high: h, low: l, close, volume: v });

test("aggregateTo1h rolls four 15m candles into one 1h bar with OHLCV semantics", () => {
  // One full hour: 10:00, 10:15, 10:30, 10:45 (epoch seconds 36000 = 10:00 UTC-ish anchor)
  const base = 36000; // multiple of 3600
  const src = [
    c(base + 0, 10, 12, 9, 11, 100),
    c(base + 900, 11, 15, 10, 14, 200),
    c(base + 1800, 14, 14, 8, 9, 50),
    c(base + 2700, 9, 13, 7, 12, 75),
  ];
  const out = aggregateTo1h(src);
  assert.strictEqual(out.length, 1, "one 1h bucket");
  const b = out[0];
  assert.strictEqual(b.t, base, "bucket start = hour boundary");
  assert.strictEqual(b.o, 10, "open = first candle open");
  assert.strictEqual(b.h, 15, "high = max high");
  assert.strictEqual(b.l, 7, "low = min low");
  assert.strictEqual(b.c, 12, "close = last candle close");
  assert.strictEqual(b.v, 425, "volume = sum");
});

test("aggregateTo1h splits across hour boundaries and sorts ascending", () => {
  const h1 = 36000;
  const h2 = 36000 + 3600;
  // Provide out of order to prove sorting.
  const src = [
    c(h2 + 900, 20, 22, 19, 21),
    c(h1 + 0, 10, 11, 9, 10),
    c(h2 + 0, 19, 25, 18, 20),
    c(h1 + 1800, 10, 14, 8, 13),
  ];
  const out = aggregateTo1h(src);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].t, h1);
  assert.strictEqual(out[1].t, h2);
  assert.strictEqual(out[0].o, 10, "first hour open from earliest candle");
  assert.strictEqual(out[0].h, 14);
  assert.strictEqual(out[0].c, 13, "first hour close = its last candle");
  assert.strictEqual(out[1].h, 25);
  assert.strictEqual(out[1].c, 21, "second hour close = its last candle");
});

test("aggregateCandles handles empty / invalid input without throwing", () => {
  assert.deepStrictEqual(aggregateCandles([], 3600), []);
  assert.deepStrictEqual(aggregateCandles(null, 3600), []);
  assert.deepStrictEqual(aggregateCandles([c(0, 1, 1, 1, 1)], 0), []);
});

test("aggregateCandles drops entries with no finite time", () => {
  const src = [c(36000, 1, 2, 1, 2), { open: 1, high: 1, low: 1, close: 1 }];
  const out = aggregateCandles(src, 3600);
  assert.strictEqual(out.length, 1);
});

test("aggregate produces enough 1h bars from a long 15m series for SuperTrend/Bollinger", () => {
  // 120 fifteen-minute candles = 30 hours -> 30 1h bars (>= 20 for Bollinger(20)).
  const src = [];
  for (let i = 0; i < 120; i++) src.push(c(i * 900, 10, 11, 9, 10));
  const out = aggregateTo1h(src);
  assert.strictEqual(out.length, 30);
});
