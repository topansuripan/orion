import test from "node:test";
import assert from "node:assert";
import { backtest } from "./backtest.js";

const NEAR = 1e-9;
const close = (a, b, msg) =>
  assert.ok(Math.abs(a - b) < NEAR, msg ?? `expected ${a} ≈ ${b}`);

// Small-period cfg so tiny fixtures produce defined indicators
// (mirrors ta/setups.test.js baseCfg).
const baseCfg = {
  supertrendPeriod: 3,
  supertrendMultiplier: 3,
  bbPeriod: 3,
  bbStdDev: 2,
  pullbackToSupportPct: 0.03,
  targetRMultiple: 2.0,
  stopLossPct: 0.1,
};

// --- WIN fixture --------------------------------------------------------
//
// Bars 0-4 are the `pullbackFix` from ta/setups.test.js, which makes
// detectEntry fire on bar 4 with: entryPrice 7, stopPrice 6.3,
// targetPrice 8.4 (R-multiple fallback). The entry is ARMED on bar 4.
//   - Bar 5 (low 6.9 ≤ 7) → fill at entryPrice 7.
//   - Bar 6 (high 9 ≥ target 8.4) → exit at target 8.4 → WIN.
// Bars 5-6 keep the supertrend bullish and stay above the stop so no
// premature breakdown exit fires.
const winFix = [
  { t: 0, o: 10, h: 11, l: 9, c: 10, v: 1 },
  { t: 1, o: 10, h: 12, l: 10, c: 11.5, v: 1 },
  { t: 2, o: 11.5, h: 13, l: 11, c: 12.5, v: 1 },
  { t: 3, o: 12.5, h: 14, l: 12, c: 13.5, v: 1 },
  { t: 4, o: 13.5, h: 13.6, l: 7.0, c: 7.1, v: 1 }, // entry signal bar
  { t: 5, o: 7.1, h: 8.0, l: 6.9, c: 7.8, v: 1 }, // low ≤ 7 → fill @ 7
  { t: 6, o: 7.8, h: 9.0, l: 7.6, c: 8.9, v: 1 }, // high ≥ 8.4 → target hit
];

test("backtest: records a winning trade when price reaches target", () => {
  const res = backtest(winFix, baseCfg);
  assert.ok(res.count >= 1, "expected at least one completed trade");

  const win = res.trades.find((t) => t.outcome === "win");
  assert.ok(win, "expected a winning trade");
  close(win.entryPrice, 7, "entry fills at entryPrice 7");
  close(win.exitPrice, 8.4, "exit at targetPrice 8.4");
  assert.ok(win.returnPct > 0, "winning return must be positive");
  // (8.4 - 7) / 7 = 0.2
  close(win.returnPct, (8.4 - 7) / 7, "returnPct = (exit-entry)/entry");
  assert.ok(win.entryIndex < win.exitIndex, "entry must precede exit");

  assert.ok(res.winRate > 0, "winRate reflects the win");
  assert.ok(res.totalReturnPct > 0, "totalReturnPct positive");
});

// --- LOSS fixture -------------------------------------------------------
//
// Same entry as winFix (fills @ 7 on bar 5), but bar 6 breaks down hard:
// low 5.5 ≤ stopPrice 6.3 → stop exit at 6.3 → LOSS.
const lossFix = [
  { t: 0, o: 10, h: 11, l: 9, c: 10, v: 1 },
  { t: 1, o: 10, h: 12, l: 10, c: 11.5, v: 1 },
  { t: 2, o: 11.5, h: 13, l: 11, c: 12.5, v: 1 },
  { t: 3, o: 12.5, h: 14, l: 12, c: 13.5, v: 1 },
  { t: 4, o: 13.5, h: 13.6, l: 7.0, c: 7.1, v: 1 }, // entry signal bar
  { t: 5, o: 7.1, h: 8.0, l: 6.9, c: 7.8, v: 1 }, // fill @ 7
  { t: 6, o: 7.0, h: 7.0, l: 5.5, c: 5.6, v: 1 }, // low ≤ stop 6.3 → stopped out
];

test("backtest: records a losing trade when price hits the stop", () => {
  const res = backtest(lossFix, baseCfg);
  assert.ok(res.count >= 1, "expected at least one completed trade");

  const loss = res.trades.find((t) => t.outcome === "loss");
  assert.ok(loss, "expected a losing trade");
  close(loss.entryPrice, 7, "entry fills at entryPrice 7");
  close(loss.exitPrice, 6.3, "exit at stopPrice 6.3");
  assert.ok(loss.returnPct < 0, "losing return must be negative");
  // (6.3 - 7) / 7 = -0.1
  close(loss.returnPct, (6.3 - 7) / 7, "returnPct = (exit-entry)/entry");
  assert.ok(loss.entryIndex < loss.exitIndex, "entry must precede exit");
});

// --- FLAT fixture -------------------------------------------------------
//
// Steady decline → supertrend flips/stays bearish, detectEntry never fires.
// Adapted from `bearishFix` in ta/setups.test.js, extended a couple bars.
const flatFix = [
  { t: 0, o: 30, h: 31, l: 29, c: 30, v: 1 },
  { t: 1, o: 30, h: 30, l: 28, c: 28, v: 1 },
  { t: 2, o: 28, h: 28, l: 26, c: 26, v: 1 },
  { t: 3, o: 26, h: 26, l: 24, c: 24, v: 1 },
  { t: 4, o: 24, h: 24, l: 22, c: 22, v: 1 },
  { t: 5, o: 22, h: 22, l: 20, c: 20, v: 1 },
  { t: 6, o: 20, h: 20, l: 18, c: 18, v: 1 },
];

test("backtest: no trades on a steady bearish decline", () => {
  const res = backtest(flatFix, { ...baseCfg, supertrendMultiplier: 1 });
  assert.strictEqual(res.count, 0, "no trades");
  assert.strictEqual(res.winRate, 0, "winRate 0 with no trades");
  assert.strictEqual(res.totalReturnPct, 0, "totalReturnPct 0 with no trades");
  assert.deepStrictEqual(res.trades, [], "empty trade list");
});

// --- No-lookahead structural guarantee ----------------------------------

test("backtest: handles empty / degenerate input without throwing", () => {
  const empty = backtest([], baseCfg);
  assert.strictEqual(empty.count, 0);
  assert.strictEqual(empty.winRate, 0);
  assert.strictEqual(empty.totalReturnPct, 0);
  assert.deepStrictEqual(empty.trades, []);
});

test("backtest: every trade's entryIndex strictly precedes its exitIndex (no lookahead)", () => {
  for (const fix of [winFix, lossFix]) {
    const res = backtest(fix, baseCfg);
    for (const tr of res.trades) {
      assert.ok(
        tr.entryIndex < tr.exitIndex,
        `entryIndex ${tr.entryIndex} must be < exitIndex ${tr.exitIndex}`,
      );
    }
  }
});
