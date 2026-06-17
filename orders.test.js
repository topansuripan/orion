import test from "node:test";
import assert from "node:assert";
import fs from "fs";
import { createStore } from "./state.js";
import { runScanCycle, runManageCycle } from "./orders.js";

const TMP = "./orion-state.test.json";

function cleanup() {
  for (const f of [TMP, TMP + ".tmp"]) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* ignore */
    }
  }
}

test.beforeEach(cleanup);
test.afterEach(cleanup);

// A minimal orion cfg slice; only keys used by orders.js matter here.
function cfg() {
  return {
    orion: {
      ohlcvTimeframe: "1h",
      candles: 200,
      orderSizeSol: 0.2,
      orderSizePct: 0.25,
      maxConcurrentOrders: 3,
      gasReserve: 0.05,
      staleBuyHours: 12,
      cooldownHoursAfterStop: 6,
      stopLossPct: 0.1,
    },
    tokens: { SOL: "So11111111111111111111111111111111111111112" },
  };
}

// Records calls for assertions.
function spy(impl) {
  const calls = [];
  const fn = (...args) => {
    calls.push(args);
    return impl ? impl(...args) : undefined;
  };
  fn.calls = calls;
  return fn;
}

const SETUP = { entryPrice: 1.0, stopPrice: 0.9, targetPrice: 1.5, reason: "test" };

// ─── runScanCycle ───────────────────────────────────────────────────

test("runScanCycle: canOpen false → places nothing", async () => {
  const store = createStore(TMP);
  const placeLimitOrder = spy();
  const summary = await runScanCycle({
    store,
    getCandidates: spy(() => [{ pool: "P1", token: "T1" }]),
    fetchIndicators: spy(() => [{}]),
    detectEntryFromIndicators: spy(() => SETUP),
    computeOrderSize: spy(() => 0.5),
    canOpen: () => false,
    isOnCooldown: () => false,
    placeLimitOrder,
    getWalletSol: spy(() => 2.0),
    notify: spy(),
    cfg: cfg(),
    now: () => 1000,
  });
  assert.equal(summary.placed, 0);
  assert.equal(placeLimitOrder.calls.length, 0);
});

test("runScanCycle: firing setup + canOpen → places once, store has order", async () => {
  const store = createStore(TMP);
  const placeLimitOrder = spy(() => ({ id: "buy-1" }));
  const summary = await runScanCycle({
    store,
    getCandidates: spy(() => [{ pool: "P1", token: "T1" }]),
    fetchIndicators: spy(() => [{ c: 1 }]),
    detectEntryFromIndicators: spy(() => SETUP),
    computeOrderSize: spy(() => 0.5),
    canOpen: (n) => n < 3,
    isOnCooldown: () => false,
    placeLimitOrder,
    getWalletSol: spy(() => 2.0),
    notify: spy(),
    cfg: cfg(),
    now: () => 1000,
  });
  assert.equal(summary.placed, 1);
  assert.equal(placeLimitOrder.calls.length, 1);
  const [arg] = placeLimitOrder.calls[0];
  assert.deepEqual(arg, { pool: "P1", side: "buy", price: 1.0, amountSol: 0.5 });

  const open = store.getOpenOrders();
  assert.equal(open.length, 1);
  assert.equal(open[0].id, "buy-1");
  assert.equal(open[0].status, "open");
  assert.equal(open[0].pool, "P1");
  assert.equal(open[0].token, "T1");
  assert.equal(open[0].entryPrice, 1.0);
  assert.equal(open[0].stopPrice, 0.9);
  assert.equal(open[0].targetPrice, 1.5);
  assert.equal(open[0].sizeSol, 0.5);
  assert.equal(open[0].createdAt, 1000);
});

test("runScanCycle: candidate on cooldown → skipped", async () => {
  const store = createStore(TMP);
  const placeLimitOrder = spy(() => ({ id: "buy-x" }));
  const detectEntryFromIndicators = spy(() => SETUP);
  const summary = await runScanCycle({
    store,
    getCandidates: spy(() => [{ pool: "P1", token: "T1" }]),
    fetchIndicators: spy(() => [{ c: 1 }]),
    detectEntryFromIndicators,
    computeOrderSize: spy(() => 0.5),
    canOpen: (n) => n < 3,
    isOnCooldown: (token) => token === "T1",
    placeLimitOrder,
    getWalletSol: spy(() => 2.0),
    notify: spy(),
    cfg: cfg(),
    now: () => 1000,
  });
  assert.equal(summary.placed, 0);
  assert.equal(placeLimitOrder.calls.length, 0);
  // cooldown skip happens before we ever fetch/evaluate the setup
  assert.equal(detectEntryFromIndicators.calls.length, 0);
});

test("runScanCycle: pool/token already has an open order → skipped (dedupe)", async () => {
  const store = createStore(TMP);
  store.addOrder({
    id: "existing",
    token: "T1",
    pool: "P1",
    side: "buy",
    entryPrice: 1,
    stopPrice: 0.9,
    targetPrice: 1.5,
    sizeSol: 0.2,
    status: "open",
    createdAt: 1,
  });
  const placeLimitOrder = spy(() => ({ id: "buy-2" }));
  const summary = await runScanCycle({
    store,
    getCandidates: spy(() => [{ pool: "P1", token: "T1" }]),
    fetchIndicators: spy(() => [{ c: 1 }]),
    detectEntryFromIndicators: spy(() => SETUP),
    computeOrderSize: spy(() => 0.5),
    canOpen: (n) => n < 3,
    isOnCooldown: () => false,
    placeLimitOrder,
    getWalletSol: spy(() => 2.0),
    notify: spy(),
    cfg: cfg(),
    now: () => 1000,
  });
  assert.equal(summary.placed, 0);
  assert.equal(placeLimitOrder.calls.length, 0);
});

test("runScanCycle: size <= 0 → skipped", async () => {
  const store = createStore(TMP);
  const placeLimitOrder = spy(() => ({ id: "buy-3" }));
  const summary = await runScanCycle({
    store,
    getCandidates: spy(() => [{ pool: "P1", token: "T1" }]),
    fetchIndicators: spy(() => [{ c: 1 }]),
    detectEntryFromIndicators: spy(() => SETUP),
    computeOrderSize: spy(() => 0),
    canOpen: (n) => n < 3,
    isOnCooldown: () => false,
    placeLimitOrder,
    getWalletSol: spy(() => 0.1),
    notify: spy(),
    cfg: cfg(),
    now: () => 1000,
  });
  assert.equal(summary.placed, 0);
  assert.equal(placeLimitOrder.calls.length, 0);
});

test("runScanCycle: respects maxConcurrentOrders mid-loop", async () => {
  const store = createStore(TMP);
  const placeLimitOrder = spy((a) => ({ id: "buy-" + a.pool }));
  // maxConcurrentOrders = 1 via canOpen
  const summary = await runScanCycle({
    store,
    getCandidates: spy(() => [
      { pool: "P1", token: "T1" },
      { pool: "P2", token: "T2" },
    ]),
    fetchIndicators: spy(() => [{ c: 1 }]),
    detectEntryFromIndicators: spy(() => SETUP),
    computeOrderSize: spy(() => 0.5),
    canOpen: (n) => n < 1,
    isOnCooldown: () => false,
    placeLimitOrder,
    getWalletSol: spy(() => 2.0),
    notify: spy(),
    cfg: cfg(),
    now: () => 1000,
  });
  assert.equal(summary.placed, 1);
  assert.equal(placeLimitOrder.calls.length, 1);
});

// ─── runManageCycle ─────────────────────────────────────────────────

test("runManageCycle: buy filled → places sell, becomes holding with sellOrderId", async () => {
  const store = createStore(TMP);
  store.addOrder({
    id: "buy-1",
    token: "T1",
    pool: "P1",
    side: "buy",
    entryPrice: 1.0,
    stopPrice: 0.9,
    targetPrice: 1.5,
    sizeSol: 0.5,
    status: "open",
    createdAt: 1000,
  });
  const placeLimitOrder = spy(() => ({ id: "sell-1" }));
  const summary = await runManageCycle({
    store,
    fetchIndicators: spy(() => [{ c: 1 }]),
    detectBreakdownFromIndicators: spy(() => false),
    getLimitOrder: spy(() => ({ id: "buy-1", status: "filled" })),
    placeLimitOrder,
    cancelLimitOrder: spy(),
    swapToken: spy(),
    setCooldownExpiry: spy(),
    notify: spy(),
    cfg: cfg(),
    now: () => 5000,
  });

  const ord = store.getOrder("buy-1");
  assert.equal(ord.status, "holding");
  assert.equal(ord.sellOrderId, "sell-1");
  assert.equal(ord.filledAt, 5000);
  assert.equal(placeLimitOrder.calls.length, 1);
  const [arg] = placeLimitOrder.calls[0];
  assert.equal(arg.side, "sell");
  assert.equal(arg.price, 1.5);
  assert.equal(arg.pool, "P1");
  assert.ok(summary.actions.some((a) => a.type === "sell_placed"));
});

test("runManageCycle: holding + breakdown → cancel sell, swap, close stop, cooldown", async () => {
  const store = createStore(TMP);
  store.addOrder({
    id: "buy-1",
    token: "T1",
    pool: "P1",
    side: "buy",
    entryPrice: 1.0,
    stopPrice: 0.9,
    targetPrice: 1.5,
    sizeSol: 0.5,
    status: "holding",
    createdAt: 1000,
    filledAt: 2000,
    sellOrderId: "sell-1",
  });
  const cancelLimitOrder = spy();
  const swapToken = spy(() => ({ success: true }));
  const summary = await runManageCycle({
    store,
    fetchIndicators: spy(() => [{ c: 0.8 }]),
    detectBreakdownFromIndicators: spy(() => true),
    getLimitOrder: spy(() => ({ status: "open" })),
    placeLimitOrder: spy(),
    cancelLimitOrder,
    swapToken,
    getHeldBalance: spy(() => 1000),
    // returns the cooldown expiry (epoch ms) given now + cfg — mirrors cooldownUntil
    setCooldownExpiry: spy((nowMs, c) => nowMs + c.orion.cooldownHoursAfterStop * 3600_000),
    notify: spy(),
    cfg: cfg(),
    now: () => 9000,
  });

  const ord = store.getOrder("buy-1");
  assert.equal(ord.status, "closed");
  assert.equal(ord.closedReason, "stop");
  assert.equal(cancelLimitOrder.calls.length, 1);
  assert.equal(cancelLimitOrder.calls[0][0], "sell-1");
  assert.equal(swapToken.calls.length, 1);
  const [swapArg] = swapToken.calls[0];
  assert.equal(swapArg.input_mint, "T1");
  assert.equal(swapArg.output_mint, "So11111111111111111111111111111111111111112");
  // cooldown must be set on the token
  const cd = store.getCooldownMap();
  assert.ok(typeof cd["T1"] === "number" && cd["T1"] > 9000);
  assert.ok(summary.actions.some((a) => a.type === "stop"));
});

test("runManageCycle: sell filled → close target", async () => {
  const store = createStore(TMP);
  store.addOrder({
    id: "buy-1",
    token: "T1",
    pool: "P1",
    side: "buy",
    entryPrice: 1.0,
    stopPrice: 0.9,
    targetPrice: 1.5,
    sizeSol: 0.5,
    status: "holding",
    createdAt: 1000,
    filledAt: 2000,
    sellOrderId: "sell-1",
  });
  const summary = await runManageCycle({
    store,
    fetchIndicators: spy(() => [{ c: 1.5 }]),
    detectBreakdownFromIndicators: spy(() => false),
    getLimitOrder: spy((id) => ({ id, status: id === "sell-1" ? "filled" : "open" })),
    placeLimitOrder: spy(),
    cancelLimitOrder: spy(),
    swapToken: spy(),
    setCooldownExpiry: spy(),
    notify: spy(),
    cfg: cfg(),
    now: () => 9000,
  });
  const ord = store.getOrder("buy-1");
  assert.equal(ord.status, "closed");
  assert.equal(ord.closedReason, "target");
  assert.ok(summary.actions.some((a) => a.type === "target"));
});

test("runManageCycle: holding + breakdown uses real held balance for swap amount", async () => {
  const store = createStore(TMP);
  store.addOrder({
    id: "buy-1",
    token: "T1",
    pool: "P1",
    side: "buy",
    entryPrice: 1.0,
    stopPrice: 0.9,
    targetPrice: 1.5,
    sizeSol: 0.5,
    status: "holding",
    createdAt: 1000,
    filledAt: 2000,
    sellOrderId: "sell-1",
  });
  const cancelLimitOrder = spy();
  const swapToken = spy(() => ({ success: true }));
  const getHeldBalance = spy(() => 1234);
  const summary = await runManageCycle({
    store,
    fetchIndicators: spy(() => [{ c: 0.8 }]),
    detectBreakdownFromIndicators: spy(() => true),
    getLimitOrder: spy(() => ({ status: "open" })),
    placeLimitOrder: spy(),
    cancelLimitOrder,
    swapToken,
    getHeldBalance,
    setCooldownExpiry: spy((nowMs, c) => nowMs + c.orion.cooldownHoursAfterStop * 3600_000),
    notify: spy(),
    cfg: cfg(),
    now: () => 9000,
  });

  const ord = store.getOrder("buy-1");
  assert.equal(ord.status, "closed");
  assert.equal(ord.closedReason, "stop");
  assert.equal(getHeldBalance.calls.length, 1);
  assert.equal(getHeldBalance.calls[0][0], "T1");
  assert.equal(swapToken.calls.length, 1);
  const [swapArg] = swapToken.calls[0];
  assert.equal(swapArg.amount, 1234); // real token balance, NOT sizeSol
  assert.equal(swapArg.input_mint, "T1");
  assert.equal(swapArg.output_mint, "So11111111111111111111111111111111111111112");
  const cd = store.getCooldownMap();
  assert.ok(typeof cd["T1"] === "number" && cd["T1"] > 9000);
  assert.ok(summary.actions.some((a) => a.type === "stop"));
});

test("runManageCycle: holding + breakdown with 0 held balance → no swap, still stop", async () => {
  const store = createStore(TMP);
  store.addOrder({
    id: "buy-1",
    token: "T1",
    pool: "P1",
    side: "buy",
    entryPrice: 1.0,
    stopPrice: 0.9,
    targetPrice: 1.5,
    sizeSol: 0.5,
    status: "holding",
    createdAt: 1000,
    filledAt: 2000,
    sellOrderId: "sell-1",
  });
  const cancelLimitOrder = spy();
  const swapToken = spy(() => ({ success: true }));
  const getHeldBalance = spy(() => 0);
  const notify = spy();
  const summary = await runManageCycle({
    store,
    fetchIndicators: spy(() => [{ c: 0.8 }]),
    detectBreakdownFromIndicators: spy(() => true),
    getLimitOrder: spy(() => ({ status: "open" })),
    placeLimitOrder: spy(),
    cancelLimitOrder,
    swapToken,
    getHeldBalance,
    setCooldownExpiry: spy((nowMs, c) => nowMs + c.orion.cooldownHoursAfterStop * 3600_000),
    notify,
    cfg: cfg(),
    now: () => 9000,
  });

  const ord = store.getOrder("buy-1");
  assert.equal(ord.status, "closed");
  assert.equal(ord.closedReason, "stop");
  assert.equal(swapToken.calls.length, 0); // no swap when nothing held
  assert.ok(summary.actions.some((a) => a.type === "stop"));
  const cd = store.getCooldownMap();
  assert.ok(typeof cd["T1"] === "number" && cd["T1"] > 9000);
});

test("runManageCycle: one order's fetchIndicators throwing does not starve others", async () => {
  const store = createStore(TMP);
  // Order A — its token's relay fetch will throw.
  store.addOrder({
    id: "buy-A",
    token: "TA",
    pool: "PA",
    side: "buy",
    entryPrice: 1.0,
    stopPrice: 0.9,
    targetPrice: 1.5,
    sizeSol: 0.5,
    status: "holding",
    createdAt: 1000,
    filledAt: 2000,
    sellOrderId: "sell-A",
  });
  // Order B — its token's relay fetch breaks down → should still get stopped.
  store.addOrder({
    id: "buy-B",
    token: "TB",
    pool: "PB",
    side: "buy",
    entryPrice: 1.0,
    stopPrice: 0.9,
    targetPrice: 1.5,
    sizeSol: 0.5,
    status: "holding",
    createdAt: 1000,
    filledAt: 2000,
    sellOrderId: "sell-B",
  });
  const swapToken = spy(() => ({ success: true }));
  // Relay fetch is keyed by token MINT, not pool.
  const fetchIndicators = spy((mint) => {
    if (mint === "TA") throw new Error("relay boom for TA");
    return { latest: {} };
  });
  const summary = await runManageCycle({
    store,
    fetchIndicators,
    detectBreakdownFromIndicators: spy(() => true),
    getLimitOrder: spy(() => ({ status: "open" })),
    placeLimitOrder: spy(),
    cancelLimitOrder: spy(),
    swapToken,
    getHeldBalance: spy(() => 500),
    setCooldownExpiry: spy((nowMs, c) => nowMs + c.orion.cooldownHoursAfterStop * 3600_000),
    notify: spy(),
    cfg: cfg(),
    now: () => 9000,
  });

  // A stayed holding (its iteration errored), B got stopped.
  assert.equal(store.getOrder("buy-A").status, "holding");
  const ordB = store.getOrder("buy-B");
  assert.equal(ordB.status, "closed");
  assert.equal(ordB.closedReason, "stop");
  assert.equal(swapToken.calls.length, 1);
  assert.equal(swapToken.calls[0][0].input_mint, "TB");
  assert.ok(summary.actions.some((a) => a.id === "buy-B" && a.type === "stop"));
});

test("runScanCycle: one candidate's fetchIndicators throwing does not starve others", async () => {
  const store = createStore(TMP);
  const placeLimitOrder = spy((a) => ({ id: "buy-" + a.pool }));
  // Relay fetch is keyed by token MINT, not pool.
  const fetchIndicators = spy((mint) => {
    if (mint === "T1") throw new Error("relay boom for T1");
    return { latest: {} };
  });
  const summary = await runScanCycle({
    store,
    getCandidates: spy(() => [
      { pool: "P1", token: "T1" },
      { pool: "P2", token: "T2" },
    ]),
    fetchIndicators,
    detectEntryFromIndicators: spy(() => SETUP),
    computeOrderSize: spy(() => 0.5),
    canOpen: (n) => n < 3,
    isOnCooldown: () => false,
    placeLimitOrder,
    getWalletSol: spy(() => 2.0),
    notify: spy(),
    cfg: cfg(),
    now: () => 1000,
  });

  assert.equal(summary.placed, 1);
  assert.equal(placeLimitOrder.calls.length, 1);
  assert.equal(placeLimitOrder.calls[0][0].pool, "P2");
  const open = store.getOpenOrders();
  assert.equal(open.length, 1);
  assert.equal(open[0].pool, "P2");
});

test("runManageCycle: stale unfilled buy → cancel + removed", async () => {
  const store = createStore(TMP);
  store.addOrder({
    id: "buy-1",
    token: "T1",
    pool: "P1",
    side: "buy",
    entryPrice: 1.0,
    stopPrice: 0.9,
    targetPrice: 1.5,
    sizeSol: 0.5,
    status: "open",
    createdAt: 1000,
  });
  const cancelLimitOrder = spy();
  // staleBuyHours = 12 → 12*3600_000 = 43_200_000 ms. now far ahead.
  const summary = await runManageCycle({
    store,
    fetchIndicators: spy(() => [{ c: 1 }]),
    detectBreakdownFromIndicators: spy(() => false),
    getLimitOrder: spy(() => ({ status: "open" })),
    placeLimitOrder: spy(),
    cancelLimitOrder,
    swapToken: spy(),
    setCooldownExpiry: spy(),
    notify: spy(),
    cfg: cfg(),
    now: () => 1000 + 13 * 3600_000,
  });
  assert.equal(cancelLimitOrder.calls.length, 1);
  assert.equal(cancelLimitOrder.calls[0][0], "buy-1");
  assert.equal(store.getOrder("buy-1"), undefined);
  assert.ok(summary.actions.some((a) => a.type === "stale"));
});

test("runManageCycle: open + not filled + not stale → no action", async () => {
  const store = createStore(TMP);
  store.addOrder({
    id: "buy-1",
    token: "T1",
    pool: "P1",
    side: "buy",
    entryPrice: 1.0,
    stopPrice: 0.9,
    targetPrice: 1.5,
    sizeSol: 0.5,
    status: "open",
    createdAt: 1000,
  });
  const placeLimitOrder = spy();
  const cancelLimitOrder = spy();
  const summary = await runManageCycle({
    store,
    fetchIndicators: spy(() => [{ c: 1 }]),
    detectBreakdownFromIndicators: spy(() => false),
    getLimitOrder: spy(() => ({ status: "open" })),
    placeLimitOrder,
    cancelLimitOrder,
    swapToken: spy(),
    setCooldownExpiry: spy(),
    notify: spy(),
    cfg: cfg(),
    now: () => 1000 + 1 * 3600_000,
  });
  assert.equal(placeLimitOrder.calls.length, 0);
  assert.equal(cancelLimitOrder.calls.length, 0);
  assert.equal(store.getOrder("buy-1").status, "open");
  assert.equal(summary.actions.length, 0);
});
