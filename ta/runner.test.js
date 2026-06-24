import test from "node:test";
import assert from "node:assert";
import { advanceRunner } from "./runner.js";

const NEAR = 1e-9;
const close = (a, b, msg) =>
  assert.ok(Math.abs(a - b) < NEAR, msg ?? `expected ${a} ≈ ${b}`);

const cfg = { runnerTargetPct: 0.6, runnerTrailPct: 0.15 };

test("advanceRunner: high-water ratchets up, never down", () => {
  let s = { entryPrice: 1.0, runnerStop: 1.0, highWater: 1.0, runnerTrailing: false };
  let r = advanceRunner(s, 1.2, cfg);
  close(r.highWater, 1.2, "highWater rises to price");
  r = advanceRunner({ ...s, highWater: 1.2 }, 1.1, cfg);
  close(r.highWater, 1.2, "highWater does not fall back");
});

test("advanceRunner: arms trailing at +60%, sets stop = highWater*(1-trail)", () => {
  // entry 1.0, +60% = 1.6; price reaches arm threshold
  const r = advanceRunner(
    { entryPrice: 1.0, runnerStop: 1.0, highWater: 1.0, runnerTrailing: false },
    1.6,
    cfg,
  );
  assert.equal(r.runnerTrailing, true, "armed at +60%");
  close(r.highWater, 1.6, "highWater = price");
  close(r.runnerStop, 1.6 * 0.85, "stop trails from highWater");
  assert.equal(r.exit, false, "price above stop → no exit");
});

test("advanceRunner: does NOT arm below +60%", () => {
  const r = advanceRunner(
    { entryPrice: 1.0, runnerStop: 1.0, highWater: 1.0, runnerTrailing: false },
    1.5,
    cfg,
  );
  assert.equal(r.runnerTrailing, false, "1.5 < 1.6 → not armed");
  close(r.runnerStop, 1.0, "stop unchanged while not trailing");
});

test("advanceRunner: trail ratchets up as highWater rises", () => {
  // already armed at highWater 1.6 (stop 1.36); now price → 2.0
  const r = advanceRunner(
    { entryPrice: 1.0, runnerStop: 1.36, highWater: 1.6, runnerTrailing: true },
    2.0,
    cfg,
  );
  close(r.highWater, 2.0, "highWater rises");
  close(r.runnerStop, 2.0 * 0.85, "stop ratchets up to 1.7");
  assert.equal(r.exit, false);
});

test("advanceRunner: trailing stop never drops below breakeven (entryPrice)", () => {
  // armed but highWater only slightly above entry: 1.6*0.85=1.36 but entry is 1.5
  const r = advanceRunner(
    { entryPrice: 1.5, runnerStop: 1.5, highWater: 1.6, runnerTrailing: true },
    1.55,
    cfg,
  );
  // highWater max(1.6,1.55)=1.6; trail = 1.6*0.85=1.36 < entry 1.5 → clamp to 1.5
  close(r.runnerStop, 1.5, "stop floored at breakeven");
  assert.equal(r.exit, false);
});

test("advanceRunner: exit triggers when price <= runnerStop", () => {
  const r = advanceRunner(
    { entryPrice: 1.0, runnerStop: 1.36, highWater: 1.6, runnerTrailing: true },
    1.3,
    cfg,
  );
  // highWater stays 1.6, stop stays 1.36, price 1.3 <= 1.36 → exit
  close(r.runnerStop, 1.36, "stop unchanged (price below highWater)");
  assert.equal(r.exit, true, "price 1.3 <= stop 1.36 → exit");
});

test("advanceRunner: pre-arm breakeven stop touch exits (price <= runnerStop)", () => {
  // not yet armed, runnerStop at breakeven 1.0, price falls to it
  const r = advanceRunner(
    { entryPrice: 1.0, runnerStop: 1.0, highWater: 1.2, runnerTrailing: false },
    1.0,
    cfg,
  );
  assert.equal(r.runnerTrailing, false);
  assert.equal(r.exit, true, "price 1.0 <= breakeven stop 1.0 → exit");
});

test("advanceRunner: arms AND can exit same call if it pulls back to the trail floor", () => {
  // price reaches arm (>=1.6) so highWater 1.6, stop 1.36; but the SAME price
  // is the high-water here so it won't be <= stop. Use a case where highWater
  // was already high and price now equals arm threshold but stop is higher than price.
  // Demonstrates exit flag uses the (possibly newly-trailed) stop.
  const r = advanceRunner(
    { entryPrice: 1.0, runnerStop: 1.0, highWater: 2.0, runnerTrailing: false },
    1.6,
    cfg,
  );
  // highWater max(2.0,1.6)=2.0; arms (1.6>=1.6); stop = 2.0*0.85=1.7
  assert.equal(r.runnerTrailing, true);
  close(r.runnerStop, 1.7);
  assert.equal(r.exit, true, "price 1.6 <= newly trailed stop 1.7 → exit");
});

test("advanceRunner is pure — does not mutate input", () => {
  const input = { entryPrice: 1.0, runnerStop: 1.0, highWater: 1.0, runnerTrailing: false };
  const snapshot = { ...input };
  advanceRunner(input, 1.6, cfg);
  assert.deepStrictEqual(input, snapshot, "input object unchanged");
});
