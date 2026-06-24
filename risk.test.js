import test from "node:test";
import assert from "node:assert";
import {
  computeOrderSize,
  canOpen,
  isOnCooldown,
  cooldownUntil,
  exposureWouldExceed,
} from "./risk.js";

const NEAR = 1e-9;
const close = (a, b) => assert.ok(Math.abs(a - b) < NEAR, `expected ${a} ≈ ${b}`);

const baseCfg = {
  orderSizeSol: 0.2,
  orderSizePct: 0.25,
  maxConcurrentOrders: 3,
  gasReserve: 0.05,
  cooldownHoursAfterStop: 6,
};

// --- computeOrderSize ---

test("computeOrderSize: above floor, below deployable", () => {
  // deployable = 1.0 - 0.05 = 0.95; 0.95 * 0.25 = 0.2375
  close(computeOrderSize(1.0, 0, baseCfg), 0.2375);
});

test("computeOrderSize: deployable below floor -> 0", () => {
  // deployable = 0.2 - 0.05 = 0.15 < orderSizeSol (0.2)
  assert.strictEqual(computeOrderSize(0.2, 0, baseCfg), 0);
});

test("computeOrderSize: pct result below floor -> returns floor", () => {
  // deployable = 0.55 - 0.05 = 0.5 (>= 0.2 floor); 0.5 * 0.25 = 0.125 < 0.2 -> floor 0.2
  close(computeOrderSize(0.55, 0, baseCfg), 0.2);
});

test("computeOrderSize: walletSol equals gasReserve -> 0", () => {
  // deployable = 0 < floor
  assert.strictEqual(computeOrderSize(0.05, 0, baseCfg), 0);
});

test("computeOrderSize: negative wallet -> 0", () => {
  assert.strictEqual(computeOrderSize(-1, 0, baseCfg), 0);
});

test("computeOrderSize: ceil enforced at deployable", () => {
  // High pct so pct result would exceed deployable; ceil clamps to deployable.
  // deployable = 0.30 - 0.05 = 0.25; pct 2.0 -> 0.5, but clamped to 0.25.
  const cfg = { ...baseCfg, orderSizePct: 2.0, orderSizeSol: 0.2 };
  close(computeOrderSize(0.30, 0, cfg), 0.25);
});

// --- canOpen ---

test("canOpen: at max -> false", () => {
  assert.strictEqual(canOpen(3, baseCfg), false);
});

test("canOpen: below max -> true", () => {
  assert.strictEqual(canOpen(2, baseCfg), true);
});

// --- isOnCooldown / cooldownUntil ---

test("isOnCooldown: future expiry, now before -> true", () => {
  const map = { TOK: 1000 };
  assert.strictEqual(isOnCooldown("TOK", 500, map, baseCfg), true);
});

test("isOnCooldown: now after expiry -> false", () => {
  const map = { TOK: 1000 };
  assert.strictEqual(isOnCooldown("TOK", 1500, map, baseCfg), false);
});

test("isOnCooldown: token not in map -> false", () => {
  assert.strictEqual(isOnCooldown("TOK", 500, {}, baseCfg), false);
});

test("cooldownUntil: 6 hours from 0 -> 21600000", () => {
  assert.strictEqual(cooldownUntil(0, { cooldownHoursAfterStop: 6 }), 21600000);
});

// --- maxOrderSizeSol clamp ---

test("computeOrderSize clamps to maxOrderSizeSol when set", () => {
  const cfg = { gasReserve: 0.05, orderSizeSol: 0.2, orderSizePct: 0.25, maxOrderSizeSol: 0.01 };
  // deployable=4.95, 25%≈1.2375, but cap wins → 0.01
  assert.equal(computeOrderSize(5, 0, cfg), 0.01);
});

test("computeOrderSize: no maxOrderSizeSol leaves behavior unchanged", () => {
  const cfg = { gasReserve: 0.05, orderSizeSol: 0.2, orderSizePct: 0.25 };
  // deployable=4.95, 25%=1.2375, within [0.2, 4.95]
  assert.equal(computeOrderSize(5, 0, cfg), 1.2375);
});

// --- exposureWouldExceed ---

test("exposureWouldExceed: true when open + new exceeds cap", () => {
  const cfg = { maxTotalExposureSol: 0.03 };
  assert.equal(exposureWouldExceed([{ sizeSol: 0.01 }, { sizeSol: 0.015 }], 0.01, cfg), true);
});

test("exposureWouldExceed: false when within cap", () => {
  const cfg = { maxTotalExposureSol: 0.03 };
  assert.equal(exposureWouldExceed([{ sizeSol: 0.01 }], 0.01, cfg), false);
});

test("exposureWouldExceed: no cap configured → never exceeds", () => {
  assert.equal(exposureWouldExceed([{ sizeSol: 99 }], 99, {}), false);
});
