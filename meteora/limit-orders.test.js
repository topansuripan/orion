import { test } from "node:test";
import assert from "node:assert";
import {
  assertSdkSupportsLimitOrders,
  MIN_LIMIT_ORDER_SDK_VERSION,
  placeLimitOrder,
  getLimitOrder,
  cancelLimitOrder,
} from "./limit-orders.js";

// ─── Version guard (pure; runs without SDK installed) ──────────────────────

test("MIN_LIMIT_ORDER_SDK_VERSION is 1.9.8", () => {
  assert.strictEqual(MIN_LIMIT_ORDER_SDK_VERSION, "1.9.8");
});

test("assertSdkSupportsLimitOrders throws for versions below 1.9.8", () => {
  for (const v of ["1.9.4", "1.9.7", "^1.9.4"]) {
    assert.throws(() => assertSdkSupportsLimitOrders(v), Error, `expected throw for ${v}`);
  }
});

test("assertSdkSupportsLimitOrders returns true for 1.9.8 and above", () => {
  for (const v of ["1.9.8", "1.9.9", "1.10.0", "2.0.0", "v1.9.8"]) {
    assert.strictEqual(assertSdkSupportsLimitOrders(v), true, `expected true for ${v}`);
  }
});

// ─── DRY_RUN paths (prove module imports + works WITHOUT the SDK present) ────

test("DRY_RUN: placeLimitOrder returns dry_run with a non-empty id (no SDK)", async () => {
  const prev = process.env.DRY_RUN;
  process.env.DRY_RUN = "true";
  try {
    const res = await placeLimitOrder({
      pool: "PoolABC",
      side: "buy",
      price: 0.0123,
      amountSol: 0.5,
    });
    assert.strictEqual(res.dry_run, true);
    assert.ok(typeof res.id === "string" && res.id.length > 0, "id should be a non-empty string");
    assert.deepStrictEqual(res.would_place, {
      pool: "PoolABC",
      side: "buy",
      price: 0.0123,
      amountSol: 0.5,
    });
  } finally {
    if (prev === undefined) delete process.env.DRY_RUN;
    else process.env.DRY_RUN = prev;
  }
});

test("DRY_RUN: getLimitOrder returns dry_run (no SDK)", async () => {
  const prev = process.env.DRY_RUN;
  process.env.DRY_RUN = "true";
  try {
    const res = await getLimitOrder("x");
    assert.strictEqual(res.dry_run, true);
    assert.strictEqual(res.id, "x");
  } finally {
    if (prev === undefined) delete process.env.DRY_RUN;
    else process.env.DRY_RUN = prev;
  }
});

test("DRY_RUN: cancelLimitOrder returns dry_run + cancelled (no SDK)", async () => {
  const prev = process.env.DRY_RUN;
  process.env.DRY_RUN = "true";
  try {
    const res = await cancelLimitOrder("x");
    assert.strictEqual(res.dry_run, true);
    assert.strictEqual(res.cancelled, true);
    assert.strictEqual(res.id, "x");
  } finally {
    if (prev === undefined) delete process.env.DRY_RUN;
    else process.env.DRY_RUN = prev;
  }
});
