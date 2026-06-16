import test from "node:test";
import assert from "node:assert";
import { detectEntry, detectBreakdown } from "./setups.js";

const NEAR = 1e-9;
const close = (a, b) => assert.ok(Math.abs(a - b) < NEAR, `expected ${a} ≈ ${b}`);

// Small-period cfg so tiny fixtures produce defined indicators.
const baseCfg = {
  supertrendPeriod: 3,
  supertrendMultiplier: 3,
  bbPeriod: 3,
  bbStdDev: 2,
  pullbackToSupportPct: 0.03,
  targetRMultiple: 2.0,
  stopLossPct: 0.1,
};

// --- 3.1 detectEntry ---

// PULLBACK fixture: bullish supertrend (value 7) with the latest close (7.1)
// pulled back to within 3% of the support value (7 ≤ 7.1 ≤ 7.21). No swing
// resistance is confirmable in 5 bars at lookback>=1, so the target falls back
// to the R-multiple formula.
const pullbackFix = [
  { t: 0, o: 10, h: 11, l: 9, c: 10, v: 1 },
  { t: 1, o: 10, h: 12, l: 10, c: 11.5, v: 1 },
  { t: 2, o: 11.5, h: 13, l: 11, c: 12.5, v: 1 },
  { t: 3, o: 12.5, h: 14, l: 12, c: 13.5, v: 1 },
  { t: 4, o: 13.5, h: 13.6, l: 7.0, c: 7.1, v: 1 },
];

test("detectEntry: fires on bullish supertrend + pullback to support", () => {
  const res = detectEntry(pullbackFix, baseCfg);
  assert.ok(res, "expected a setup object");
  // entryPrice equals the supertrend support value (7).
  close(res.entryPrice, 7);
  // stopPrice = entry * (1 - stopLossPct).
  close(res.stopPrice, 7 * (1 - baseCfg.stopLossPct));
  // No resistance above entry → R-multiple fallback target, strictly above entry.
  assert.ok(res.targetPrice > res.entryPrice, "target must be above entry");
  close(res.targetPrice, 7 + baseCfg.targetRMultiple * (7 - 7 * (1 - baseCfg.stopLossPct)));
  assert.match(res.reason, /pullback/i);
});

// BEARISH fixture: a steady decline flips supertrend bearish at the latest bar.
const bearishFix = [
  { t: 0, o: 30, h: 31, l: 29, c: 30, v: 1 },
  { t: 1, o: 30, h: 30, l: 28, c: 28, v: 1 },
  { t: 2, o: 28, h: 28, l: 26, c: 26, v: 1 },
  { t: 3, o: 26, h: 26, l: 24, c: 24, v: 1 },
  { t: 4, o: 24, h: 24, l: 22, c: 22, v: 1 },
];

test("detectEntry: returns null when supertrend is bearish", () => {
  // supertrendMultiplier 1 makes the bands tight enough to flip bearish.
  const res = detectEntry(bearishFix, { ...baseCfg, supertrendMultiplier: 1 });
  assert.strictEqual(res, null);
});

// NO-PULLBACK fixture: bullish supertrend (value 8) but latest close (14.5) sits
// far above support and above the lower Bollinger band → neither condition holds.
const noPullbackFix = [
  { t: 0, o: 10, h: 11, l: 9, c: 10, v: 1 },
  { t: 1, o: 10, h: 12, l: 10, c: 11.5, v: 1 },
  { t: 2, o: 11.5, h: 13, l: 11, c: 12.5, v: 1 },
  { t: 3, o: 12.5, h: 14, l: 12, c: 13.5, v: 1 },
  { t: 4, o: 13.5, h: 15, l: 13, c: 14.5, v: 1 },
];

test("detectEntry: returns null when bullish but no pullback and above lower band", () => {
  const res = detectEntry(noPullbackFix, baseCfg);
  assert.strictEqual(res, null);
});

// BELOW-BB fixture: bullish supertrend (wide mult 5 keeps it bullish, value 18)
// but the latest close (19.5) dips at/below the lower Bollinger band (bbStdDev 1).
// A flat base of 20.0 closes with a single pivot high at index 6 (h=21) that is
// confirmable at the default swingLevels lookback (5), giving a swing resistance
// of 21 above entry — so the target should be that resistance, not the
// R-multiple fallback.
const belowBandFix = (() => {
  const c = [];
  for (let i = 0; i < 13; i++) c.push({ t: i, o: 20, h: 20.2, l: 19.8, c: 20, v: 1 });
  c[6] = { t: 6, o: 20, h: 21.0, l: 19.8, c: 20.5, v: 1 }; // confirmed pivot high
  c[12] = { t: 12, o: 20, h: 20.0, l: 19.4, c: 19.5, v: 1 }; // below-band dip
  return c;
})();

test("detectEntry: fires on bullish supertrend + close below lower BB, uses swing resistance as target", () => {
  const res = detectEntry(belowBandFix, {
    ...baseCfg,
    supertrendMultiplier: 5,
    bbStdDev: 1,
  });
  assert.ok(res, "expected a setup object");
  close(res.entryPrice, 18); // supertrend value
  close(res.stopPrice, 18 * (1 - baseCfg.stopLossPct));
  // swing resistance 21 is above entry (18) → it is the target.
  close(res.targetPrice, 21);
  assert.ok(res.targetPrice > res.entryPrice);
  assert.match(res.reason, /lower bb|lower band|bollinger/i);
});

test("detectEntry: returns null when too few candles for indicators", () => {
  assert.strictEqual(detectEntry([], baseCfg), null);
  assert.strictEqual(detectEntry(pullbackFix.slice(0, 2), baseCfg), null);
});

// --- 3.2 detectBreakdown ---

test("detectBreakdown: true when supertrend flips bearish", () => {
  const position = { entryPrice: 30, stopPrice: 1 }; // stop far below to isolate the supertrend rule
  assert.strictEqual(
    detectBreakdown(bearishFix, position, { ...baseCfg, supertrendMultiplier: 1 }),
    true,
  );
});

test("detectBreakdown: true when latest close < stopPrice while supertrend still bullish", () => {
  // pullbackFix latest close is 7.1, supertrend bullish. Set stop above it.
  const position = { entryPrice: 13.5, stopPrice: 8 };
  assert.strictEqual(detectBreakdown(pullbackFix, position, baseCfg), true);
});

test("detectBreakdown: false when supertrend bullish and close above stopPrice", () => {
  const position = { entryPrice: 13.5, stopPrice: 6 };
  assert.strictEqual(detectBreakdown(pullbackFix, position, baseCfg), false);
});
