import test from "node:test";
import assert from "node:assert";
import {
  detectEntryFromIndicators,
  detectBreakdownFromIndicators,
} from "./relay-setups.js";

const NEAR = 1e-9;
const close = (a, b) => assert.ok(Math.abs(a - b) < NEAR, `expected ${a} ≈ ${b}`);

const cfg = {
  pullbackToSupportPct: 0.03,
  targetRMultiple: 2.0,
  stopLossPct: 0.1,
};

// Relay payload shape: { latest: { candle:{close}, bollinger:{lower,middle,upper},
// supertrend:{value,direction}, rsi:{value}, ... } }.
function payload({ close, lower, upper, stValue, stDir }) {
  return {
    latest: {
      candle: { close },
      previousCandle: { close: close },
      bollinger: { lower, middle: (lower + upper) / 2, upper },
      supertrend: { value: stValue, direction: stDir },
      rsi: { value: 50 },
      fibonacci: { levels: {} },
      states: {},
    },
  };
}

// BULLISH + PULLBACK: supertrend bullish, value 7, close 7.1 (within 3% of 7),
// upperBand 9 > entry 7 → target = upperBand 9.
const bullishPullback = payload({
  close: 7.1,
  lower: 5.0,
  upper: 9.0,
  stValue: 7,
  stDir: "bullish",
});

test("detectEntryFromIndicators: fires on bullish+pullback with relay-derived entry/stop/target", () => {
  const res = detectEntryFromIndicators(bullishPullback, cfg);
  assert.ok(res, "expected a setup");
  close(res.entryPrice, 7);
  close(res.stopPrice, 7 * (1 - cfg.stopLossPct));
  close(res.targetPrice, 9); // upperBand, since 9 > entry 7
  assert.ok(res.targetPrice > res.entryPrice);
  assert.match(res.reason, /pullback/i);
});

// BULLISH + below lower band, upperBand below entry → R-multiple fallback target.
const bullishBelowBand = payload({
  close: 4.0, // ≤ lower band 5
  lower: 5.0,
  upper: 6.5, // < entry 7 → fallback target
  stValue: 7,
  stDir: "bullish",
});

test("detectEntryFromIndicators: below-band fires, R-multiple fallback when upperBand ≤ entry", () => {
  const res = detectEntryFromIndicators(bullishBelowBand, cfg);
  assert.ok(res, "expected a setup");
  close(res.entryPrice, 7);
  const stop = 7 * (1 - cfg.stopLossPct);
  close(res.stopPrice, stop);
  close(res.targetPrice, 7 + cfg.targetRMultiple * (7 - stop));
  assert.match(res.reason, /lower bb|lower band|bollinger/i);
});

// BEARISH: entry null; breakdown true.
const bearish = payload({
  close: 6.0,
  lower: 5.0,
  upper: 9.0,
  stValue: 8,
  stDir: "bearish",
});

test("detectEntryFromIndicators: bearish payload → null entry", () => {
  assert.strictEqual(detectEntryFromIndicators(bearish, cfg), null);
});

test("detectBreakdownFromIndicators: bearish payload → true", () => {
  const position = { entryPrice: 8, stopPrice: 1 };
  assert.strictEqual(detectBreakdownFromIndicators(bearish, position, cfg), true);
});

test("detectBreakdownFromIndicators: bullish but close < stopPrice → true", () => {
  const position = { entryPrice: 8, stopPrice: 7.5 };
  assert.strictEqual(
    detectBreakdownFromIndicators(bullishPullback, position, cfg),
    true,
  );
});

test("detectBreakdownFromIndicators: bullish and close above stop → false", () => {
  const position = { entryPrice: 8, stopPrice: 6 };
  assert.strictEqual(
    detectBreakdownFromIndicators(bullishPullback, position, cfg),
    false,
  );
});

// INSUFFICIENT DATA: supertrend value/direction undefined (e.g. 7-candle case
// where the server could not compute supertrend) → entry null, no throw.
const insufficient = {
  latest: {
    candle: { close: 7.1 },
    bollinger: { lower: 5, middle: 7, upper: 9 },
    supertrend: { value: undefined, direction: undefined },
    rsi: { value: undefined },
    fibonacci: { levels: {} },
    states: {},
  },
};

test("detectEntryFromIndicators: insufficient payload (no supertrend) → null, no throw", () => {
  assert.strictEqual(detectEntryFromIndicators(insufficient, cfg), null);
});

test("detectEntryFromIndicators: missing latest entirely → null, no throw", () => {
  assert.strictEqual(detectEntryFromIndicators({}, cfg), null);
  assert.strictEqual(detectEntryFromIndicators(null, cfg), null);
});
