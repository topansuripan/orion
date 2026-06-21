import test from "node:test";
import assert from "node:assert";
import fs from "fs";
import { createStore } from "./state.js";
import { runScanCycle, runManageCycle, isFilled, isPartial } from "./orders.js";

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
      scaleOutPct: 0.5,
      runnerTargetPct: 0.6,
      runnerTrailPct: 0.15,
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

// ─── isFilled / isPartial (verified SDK status semantics) ───────────

test("isFilled: only status 'filled' is a fill", () => {
  assert.equal(isFilled({ status: "filled" }), true);
  assert.equal(isFilled({ status: "FILLED" }), true);
  assert.equal(isFilled({ status: "partial" }), false);
  assert.equal(isFilled({ status: "open" }), false);
  // legacy shapes no longer accepted
  assert.equal(isFilled({ filled: true }), false);
  assert.equal(isFilled({ status: "completed" }), false);
  assert.equal(isFilled({ status: "closed" }), false);
  assert.equal(isFilled(null), false);
  assert.equal(isFilled(undefined), false);
});

test("isPartial: only status 'partial' is partial", () => {
  assert.equal(isPartial({ status: "partial" }), true);
  assert.equal(isPartial({ status: "PARTIAL" }), true);
  assert.equal(isPartial({ status: "filled" }), false);
  assert.equal(isPartial({ status: "open" }), false);
  assert.equal(isPartial(null), false);
});

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
  const placeLimitOrder = spy(() => ({ id: "buy-1", binId: 314 }));
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
  assert.equal(open[0].binId, 314); // placed bin persisted for later cancel
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

test("runManageCycle: buy FULLY filled → places TP1 half-sell sized from real held base, holding with runner state", async () => {
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
    binId: 42,
  });
  const placeLimitOrder = spy(() => ({ id: "tp1-1", binId: 99 }));
  const getLimitOrder = spy(() => ({ id: "buy-1", status: "filled" }));
  const cancelLimitOrder = spy();
  const summary = await runManageCycle({
    store,
    fetchIndicators: spy(() => ({ latest: {} })),
    priceOf: spy(() => 1.0),
    detectBreakdownFromIndicators: spy(() => false),
    getLimitOrder,
    placeLimitOrder,
    cancelLimitOrder,
    swapToken: spy(),
    getHeldBalance: spy(() => 10), // real held base
    setCooldownExpiry: spy(),
    notify: spy(),
    cfg: cfg(),
    now: () => 5000,
  });

  const ord = store.getOrder("buy-1");
  assert.equal(ord.status, "holding");
  assert.equal(ord.filledAt, 5000);
  // Full fill → no remainder cancel.
  assert.equal(cancelLimitOrder.calls.length, 0);
  // getLimitOrder for the BUY must thread {pool, side} (live path needs pool).
  assert.deepEqual(getLimitOrder.calls[0][1], { pool: "P1", side: "buy" });
  // TP1 is a HALF sell at the target price, sized from REAL held base × scaleOutPct.
  assert.equal(placeLimitOrder.calls.length, 1);
  const [arg] = placeLimitOrder.calls[0];
  assert.equal(arg.side, "sell");
  assert.equal(arg.price, 1.5);
  assert.equal(arg.pool, "P1");
  assert.equal(arg.baseAmount, 10 * 0.5); // heldBase * scaleOutPct
  assert.equal(arg.amountSol, undefined);
  // runner state initialised.
  assert.equal(ord.tp1OrderId, "tp1-1");
  assert.equal(ord.tp1BinId, 99); // placed sell bin persisted
  assert.equal(ord.tp1Filled, false);
  assert.equal(ord.runnerStop, 0.9); // original hard stop
  assert.equal(ord.highWater, 1.0); // entryPrice
  assert.equal(ord.runnerTrailing, false);
  assert.notEqual(ord.partialEntry, true); // full fill, not partial
  assert.equal(ord.sizeSol, 0.5); // unchanged on full fill
  assert.ok(summary.actions.some((a) => a.type === "tp1_placed"));
});

test("runManageCycle: buy PARTIALLY filled → cancels remainder, recomputes cost basis, places TP1", async () => {
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
    binId: 42,
  });
  const placeLimitOrder = spy(() => ({ id: "tp1-1", binId: 99 }));
  const getLimitOrder = spy(() => ({ id: "buy-1", status: "partial", filledBaseAmount: 3 }));
  const cancelLimitOrder = spy();
  const summary = await runManageCycle({
    store,
    fetchIndicators: spy(() => ({ latest: {} })),
    priceOf: spy(() => 1.0),
    detectBreakdownFromIndicators: spy(() => false),
    getLimitOrder,
    placeLimitOrder,
    cancelLimitOrder,
    swapToken: spy(),
    getHeldBalance: spy(() => 3), // only the partially-filled base is held
    setCooldownExpiry: spy(),
    notify: spy(),
    cfg: cfg(),
    now: () => 5000,
  });

  const ord = store.getOrder("buy-1");
  assert.equal(ord.status, "holding");
  // Remainder of the BUY cancelled first, threading {pool, binIds}.
  assert.equal(cancelLimitOrder.calls.length, 1);
  assert.equal(cancelLimitOrder.calls[0][0], "buy-1");
  assert.deepEqual(cancelLimitOrder.calls[0][1], { pool: "P1", binIds: [42] });
  // TP1 sized from held base.
  assert.equal(placeLimitOrder.calls.length, 1);
  assert.equal(placeLimitOrder.calls[0][0].baseAmount, 3 * 0.5);
  // partial flags + recomputed cost basis (filledBaseAmount * entryPrice).
  assert.equal(ord.partialEntry, true);
  assert.equal(ord.sizeSol, 3 * 1.0);
  assert.equal(ord.tp1BinId, 99);
  assert.ok(summary.actions.some((a) => a.type === "tp1_placed"));
});

// A helper to build a "holding" order in the post-TP1-placed state (buy filled,
// TP1 half placed, runner armed at the original hard stop).
function holdingOrder(over = {}) {
  return {
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
    tp1OrderId: "tp1-1",
    tp1BinId: 99,
    tp1Filled: false,
    runnerStop: 0.9,
    highWater: 1.0,
    runnerTrailing: false,
    partialPnlSol: null,
    ...over,
  };
}

test("runManageCycle: breakdown BEFORE TP1 fills → cancel TP1, market-sell full, stop, cooldown", async () => {
  const store = createStore(TMP);
  store.addOrder(holdingOrder());
  const cancelLimitOrder = spy();
  const swapToken = spy(() => ({ success: true }));
  const summary = await runManageCycle({
    store,
    fetchIndicators: spy(() => ({ latest: {} })),
    priceOf: spy(() => 0.85), // <= original stop 0.9
    detectBreakdownFromIndicators: spy(() => true),
    getLimitOrder: spy(() => ({ status: "open" })),
    placeLimitOrder: spy(),
    cancelLimitOrder,
    swapToken,
    getHeldBalance: spy(() => 1000),
    setCooldownExpiry: spy((nowMs, c) => nowMs + c.orion.cooldownHoursAfterStop * 3600_000),
    notify: spy(),
    cfg: cfg(),
    now: () => 9000,
  });

  const ord = store.getOrder("buy-1");
  assert.equal(ord.status, "closed");
  assert.equal(ord.closedReason, "stop");
  // TP1 limit must be cancelled before market-exit, threading {pool, binIds}.
  assert.equal(cancelLimitOrder.calls.length, 1);
  assert.equal(cancelLimitOrder.calls[0][0], "tp1-1");
  assert.deepEqual(cancelLimitOrder.calls[0][1], { pool: "P1", binIds: [99] });
  assert.equal(swapToken.calls.length, 1);
  const [swapArg] = swapToken.calls[0];
  assert.equal(swapArg.input_mint, "T1");
  assert.equal(swapArg.amount, 1000); // real held balance, full position
  assert.equal(swapArg.output_mint, "So11111111111111111111111111111111111111112");
  // realized ≈ full-size loss at runnerStop (original stop).
  assert.ok(ord.realizedPnlSol < 0);
  // sizeSol*(runnerStop-entry)/entry = 0.5*(0.9-1)/1 = -0.05
  assert.ok(Math.abs(ord.realizedPnlSol - (0.5 * (0.9 - 1.0) / 1.0)) < 1e-9);
  const cd = store.getCooldownMap();
  assert.ok(typeof cd["T1"] === "number" && cd["T1"] > 9000);
  assert.ok(summary.actions.some((a) => a.type === "stop"));
});

test("runManageCycle: TP1 fills → tp1Filled, runnerStop→breakeven, partial pnl, still open", async () => {
  const store = createStore(TMP);
  store.addOrder(holdingOrder());
  const summary = await runManageCycle({
    store,
    fetchIndicators: spy(() => ({ latest: {} })),
    priceOf: spy(() => 1.2), // above entry, below +60% trail-arm; no exit
    detectBreakdownFromIndicators: spy(() => false),
    getLimitOrder: spy((id) => ({ id, status: id === "tp1-1" ? "filled" : "open" })),
    placeLimitOrder: spy(),
    cancelLimitOrder: spy(),
    swapToken: spy(),
    getHeldBalance: spy(() => 1000),
    setCooldownExpiry: spy(),
    notify: spy(),
    cfg: cfg(),
    now: () => 9000,
  });

  const ord = store.getOrder("buy-1");
  assert.equal(ord.status, "holding"); // runner continues
  assert.equal(ord.tp1Filled, true);
  assert.equal(ord.runnerStop, 1.0); // moved to breakeven (entryPrice)
  // partial = sizeSol*scaleOutPct*(target-entry)/entry = 0.5*0.5*(1.5-1)/1 = 0.125
  assert.ok(Math.abs(ord.partialPnlSol - (0.5 * 0.5 * (1.5 - 1.0) / 1.0)) < 1e-9);
  assert.ok(summary.actions.some((a) => a.type === "tp1_filled"));
});

test("runManageCycle: runner runs to +60% (trail arms), then pulls back → runner_trail exit, combined pnl > 0", async () => {
  const store = createStore(TMP);
  // Already past TP1: tp1Filled true, breakeven stop, partial banked.
  store.addOrder(
    holdingOrder({
      tp1Filled: true,
      runnerStop: 1.0,
      highWater: 1.0,
      partialPnlSol: 0.125,
    }),
  );
  const swapToken = spy(() => ({ success: true }));
  const cancelLimitOrder = spy();

  // Cycle 1: price hits +60% (1.6) → trailing arms, no exit, runnerStop trails up.
  await runManageCycle({
    store,
    fetchIndicators: spy(() => ({ latest: {} })),
    priceOf: spy(() => 1.6), // entry*1.6 → arms trailing; trail stop = 1.6*0.85 = 1.36
    detectBreakdownFromIndicators: spy(() => false),
    getLimitOrder: spy(() => ({ status: "open" })),
    placeLimitOrder: spy(),
    cancelLimitOrder,
    swapToken,
    getHeldBalance: spy(() => 500),
    setCooldownExpiry: spy((nowMs, c) => nowMs + c.orion.cooldownHoursAfterStop * 3600_000),
    notify: spy(),
    cfg: cfg(),
    now: () => 9000,
  });
  let ord = store.getOrder("buy-1");
  assert.equal(ord.runnerTrailing, true);
  assert.equal(ord.status, "holding"); // no exit on the arm cycle
  assert.ok(Math.abs(ord.runnerStop - 1.6 * 0.85) < 1e-9); // trailing from highWater
  assert.equal(swapToken.calls.length, 0);

  // Cycle 2: price pulls back below trailing stop (1.36) → market-sell runner.
  const summary = await runManageCycle({
    store,
    fetchIndicators: spy(() => ({ latest: {} })),
    priceOf: spy(() => 1.3), // <= runnerStop 1.36 → exit
    detectBreakdownFromIndicators: spy(() => false),
    getLimitOrder: spy(() => ({ status: "open" })),
    placeLimitOrder: spy(),
    cancelLimitOrder,
    swapToken,
    getHeldBalance: spy(() => 500),
    setCooldownExpiry: spy((nowMs, c) => nowMs + c.orion.cooldownHoursAfterStop * 3600_000),
    notify: spy(),
    cfg: cfg(),
    now: () => 9500,
  });

  ord = store.getOrder("buy-1");
  assert.equal(ord.status, "closed");
  assert.equal(ord.closedReason, "runner_trail");
  assert.equal(swapToken.calls.length, 1);
  assert.equal(swapToken.calls[0][0].input_mint, "T1");
  assert.equal(swapToken.calls[0][0].amount, 500);
  // combined = partial (0.125) + runner half from breakeven up to 1.36 stop > 0
  assert.ok(ord.realizedPnlSol > 0.125, "runner added profit on top of partial");
  assert.ok(summary.actions.some((a) => a.type === "runner_exit"));
});

test("runManageCycle: after TP1, runner falls to breakeven before +60% → runner_breakeven, combined ≈ partial", async () => {
  const store = createStore(TMP);
  store.addOrder(
    holdingOrder({
      tp1Filled: true,
      runnerStop: 1.0, // breakeven
      highWater: 1.2,
      partialPnlSol: 0.125,
    }),
  );
  const swapToken = spy(() => ({ success: true }));
  const summary = await runManageCycle({
    store,
    fetchIndicators: spy(() => ({ latest: {} })),
    priceOf: spy(() => 1.0), // <= runnerStop (breakeven) → exit, never armed trailing
    detectBreakdownFromIndicators: spy(() => false),
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

  const ord = store.getOrder("buy-1");
  assert.equal(ord.status, "closed");
  assert.equal(ord.closedReason, "runner_breakeven");
  assert.equal(swapToken.calls.length, 1);
  // runner exits at breakeven (runnerStop == entry) → 0 runner pnl; combined ≈ partial.
  assert.ok(Math.abs(ord.realizedPnlSol - 0.125) < 1e-9);
  assert.ok(summary.actions.some((a) => a.type === "runner_exit"));
});

test("runManageCycle: breakdown before TP1 uses real held balance for swap amount", async () => {
  const store = createStore(TMP);
  store.addOrder(holdingOrder());
  const cancelLimitOrder = spy();
  const swapToken = spy(() => ({ success: true }));
  const getHeldBalance = spy(() => 1234);
  const summary = await runManageCycle({
    store,
    fetchIndicators: spy(() => ({ latest: {} })),
    priceOf: spy(() => 0.85),
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

test("runManageCycle: breakdown before TP1 with 0 held balance → no swap, still stop", async () => {
  const store = createStore(TMP);
  store.addOrder(holdingOrder());
  const cancelLimitOrder = spy();
  const swapToken = spy(() => ({ success: true }));
  const getHeldBalance = spy(() => 0);
  const notify = spy();
  const summary = await runManageCycle({
    store,
    fetchIndicators: spy(() => ({ latest: {} })),
    priceOf: spy(() => 0.85),
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
    tp1OrderId: "tp1-A",
    tp1Filled: false,
    runnerStop: 0.9,
    highWater: 1.0,
    runnerTrailing: false,
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
    tp1OrderId: "tp1-B",
    tp1Filled: false,
    runnerStop: 0.9,
    highWater: 1.0,
    runnerTrailing: false,
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
    priceOf: spy(() => 0.85),
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
  assert.equal(cancelLimitOrder.calls[0][1].pool, "P1"); // pool threaded for live path
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
