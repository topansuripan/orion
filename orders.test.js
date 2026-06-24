import { test } from "node:test";
import assert from "node:assert";
import { runScanCycle } from "./orders.js";

// Minimal in-memory store seam for the injectable scan cycle.
function fakeStore(open = []) {
  const orders = [...open];
  return {
    getOpenOrders: () => orders,
    getCooldownMap: () => new Map(),
    addOrder: (o) => orders.push(o),
  };
}

const baseCfg = {
  orion: { maxConcurrentOrders: 3, maxTotalExposureSol: 0.06, indicatorInterval: "15_MINUTE" },
};

function baseDeps(over = {}) {
  return {
    store: fakeStore(),
    getCandidates: async () => [],
    fetchIndicators: async () => ({}),
    detectEntryFromIndicators: () => null,
    computeOrderSize: () => 0.02,
    canOpen: (n, cfg) => n < cfg.maxConcurrentOrders,
    isOnCooldown: () => false,
    placeLimitOrder: async () => ({ id: "ORDER" }),
    getWalletSol: async () => 0.1,
    notify: () => {},
    cfg: baseCfg,
    now: () => 0,
    ...over,
  };
}

// Observability: a scan must report how much work it did so future cycles are
// not silent when they place 0 orders.
test("runScanCycle reports candidate/evaluated/placed counts on a no-signal cycle", async () => {
  const res = await runScanCycle(
    baseDeps({
      getCandidates: async () => [
        { pool: "P1", token: "T1" },
        { pool: "P2", token: "T2" },
      ],
      detectEntryFromIndicators: () => null,
    }),
  );
  assert.strictEqual(res.candidates, 2, "two candidates discovered");
  assert.strictEqual(res.evaluated, 2, "both reached entry evaluation");
  assert.strictEqual(res.placed, 0, "no signal => nothing placed");
  assert.strictEqual(res.errors, 0, "no errors");
});

test("runScanCycle counts a candidate that throws as an error, not evaluated", async () => {
  const res = await runScanCycle(
    baseDeps({
      getCandidates: async () => [{ pool: "P1", token: "T1" }],
      fetchIndicators: async () => {
        throw new Error("Jupiter HTTP 429 Too Many Requests");
      },
    }),
  );
  assert.strictEqual(res.candidates, 1);
  assert.strictEqual(res.evaluated, 0, "threw before evaluation completed");
  assert.strictEqual(res.errors, 1);
  assert.strictEqual(res.placed, 0);
});

test("runScanCycle counts a placed order", async () => {
  const res = await runScanCycle(
    baseDeps({
      getCandidates: async () => [{ pool: "P1", token: "T1" }],
      detectEntryFromIndicators: () => ({
        entryPrice: 1,
        stopPrice: 0.9,
        targetPrice: 1.2,
        reason: "test setup",
      }),
    }),
  );
  assert.strictEqual(res.candidates, 1);
  assert.strictEqual(res.evaluated, 1);
  assert.strictEqual(res.placed, 1);
  assert.strictEqual(res.errors, 0);
});
