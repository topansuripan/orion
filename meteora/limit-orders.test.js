import { test } from "node:test";
import assert from "node:assert";
import {
  assertSdkSupportsLimitOrders,
  MIN_LIMIT_ORDER_SDK_VERSION,
  scaleToRaw,
  placeLimitOrder,
  getLimitOrder,
  cancelLimitOrder,
  __setDeps,
  __resetDeps,
} from "./limit-orders.js";

// ─── Live-path test seam helpers ────────────────────────────────────────────
// Build a fake DLMM instance whose chain methods just record args / return
// crafted data. No @meteora-ag/dlmm, no @coral-xyz/anchor, no web3 needed.

function makeFakeWallet(pubkey = "WALLETpubkey") {
  return { publicKey: { toBase58: () => pubkey } };
}

function makeFakeKeypair(pubkey = "ORDERpubkey") {
  return { publicKey: { toBase58: () => pubkey } };
}

// makeBN stand-in: tests assert the raw string via .toString().
const fakeMakeBN = (n) => ({ toString: () => String(n) });

function makeFakeDlmm({
  supportsLimitOrder = true,
  binId = 123,
  decimalsX = 6,
  placeRecorder,
  cancelRecorder,
  limitOrderList = [],
} = {}) {
  return {
    supportsLimitOrder,
    binId,
    __decimalsX: decimalsX,
    placeArgs: null,
    cancelArgs: null,
    priceToBinArgs: null,
    // priceToBinId helper that getDlmm attaches in production; here it is fixed
    // but RECORDS the {min} arg so tests can verify floor/ceil direction per side.
    priceToBinId(_price, opts = {}) {
      this.priceToBinArgs = { price: _price, ...opts };
      return binId;
    },
    async placeLimitOrder(args) {
      this.placeArgs = args;
      if (placeRecorder) placeRecorder(args);
      // returns an unsigned legacy Transaction — opaque to us
      return { __unsignedTx: "place" };
    },
    async cancelLimitOrder(args) {
      this.cancelArgs = args;
      if (cancelRecorder) cancelRecorder(args);
      return { __unsignedTx: "cancel" };
    },
    async getLimitOrderByUserAndLbPair(_owner) {
      return limitOrderList;
    },
  };
}

function withLiveEnv(fn) {
  return async () => {
    const prev = process.env.DRY_RUN;
    delete process.env.DRY_RUN;
    try {
      await fn();
    } finally {
      __resetDeps();
      if (prev === undefined) delete process.env.DRY_RUN;
      else process.env.DRY_RUN = prev;
    }
  };
}

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

// ─── scaleToRaw: integer-safe decimal scaling (pure) ───────────────────────

test("scaleToRaw scales decimals to exact integer strings (no float error)", () => {
  assert.strictEqual(scaleToRaw(0.01, 9), "10000000");
  assert.strictEqual(scaleToRaw(5, 6), "5000000");
  assert.strictEqual(scaleToRaw("1.5", 6), "1500000");
  assert.strictEqual(scaleToRaw(0, 9), "0");
  // High-precision cases that naive float math would get wrong.
  assert.strictEqual(scaleToRaw(0.1, 9), "100000000");
  assert.strictEqual(scaleToRaw(1234.567891234, 9), "1234567891234");
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
      baseAmount: undefined,
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

// ─── TASK 3: placeLimitOrder live path ──────────────────────────────────────

test(
  "live placeLimitOrder buy: bid side, SOL lamports amount, returns keypair id + signature",
  withLiveEnv(async () => {
    const wallet = makeFakeWallet("WALLET1");
    const orderKp = makeFakeKeypair("ORDER1");
    const fakeDlmm = makeFakeDlmm({ binId: 555 });
    let signArgs = null;

    __setDeps({
      getWallet: () => wallet,
      makeOrderKeypair: () => orderKp,
      getDlmm: async () => fakeDlmm,
      makeBN: fakeMakeBN,
      signAndSend: async (tx, signers) => {
        signArgs = { tx, signers };
        return "SIGbuy";
      },
    });

    const res = await placeLimitOrder({
      pool: "PoolABC",
      side: "buy",
      price: 0.0123,
      amountSol: 0.01,
    });

    const args = fakeDlmm.placeArgs;
    assert.ok(args, "placeLimitOrder should be called on the dlmm instance");
    assert.strictEqual(args.params.isAskSide, false, "buy → isAskSide false");
    assert.strictEqual(args.params.bins.length, 1);
    assert.strictEqual(args.params.bins[0].id, 555, "bin id from priceToBinId");
    assert.strictEqual(
      fakeDlmm.priceToBinArgs?.min,
      true,
      "buy → priceToBinId called with min:true (floor)"
    );
    assert.strictEqual(
      args.params.bins[0].amount.toString(),
      "10000000",
      "0.01 SOL → 10000000 lamports raw"
    );
    assert.strictEqual(res.id, "ORDER1", "returned id = order keypair pubkey base58");
    assert.strictEqual(res.signature, "SIGbuy");
    assert.strictEqual(res.binId, 555, "returned object persists placed binId");
    assert.deepStrictEqual(
      signArgs.signers,
      [wallet, orderKp],
      "signAndSend called with [wallet, orderKeypair]"
    );
  })
);

test(
  "live placeLimitOrder sell: ask side, explicit baseAmount scaled to raw, amountSol ignored",
  withLiveEnv(async () => {
    const wallet = makeFakeWallet();
    const orderKp = makeFakeKeypair("ORDER2");
    const fakeDlmm = makeFakeDlmm({ binId: 777, decimalsX: 6 });

    __setDeps({
      getWallet: () => wallet,
      makeOrderKeypair: () => orderKp,
      getDlmm: async () => fakeDlmm,
      makeBN: fakeMakeBN,
      signAndSend: async () => "SIGsell",
    });

    const res = await placeLimitOrder({
      pool: "PoolXYZ",
      side: "sell",
      price: 0.02,
      baseAmount: 2.5, // 2.5 base @ 6 decimals → raw "2500000"
      amountSol: 999, // must be ignored for sells
    });

    const args = fakeDlmm.placeArgs;
    assert.strictEqual(args.params.isAskSide, true, "sell → isAskSide true");
    assert.strictEqual(
      fakeDlmm.priceToBinArgs?.min,
      false,
      "sell → priceToBinId called with min:false (ceil)"
    );
    assert.strictEqual(
      args.params.bins[0].amount.toString(),
      "2500000",
      "sell uses explicit baseAmount scaled to raw (2.5 @ 6 dec), not amountSol"
    );
    assert.strictEqual(res.id, "ORDER2");
    assert.strictEqual(res.binId, 777);
  })
);

test(
  "live placeLimitOrder sell throws on zero/invalid baseAmount (pre-flight, no chain access)",
  withLiveEnv(async () => {
    let dlmmCalled = false;
    __setDeps({
      getWallet: () => makeFakeWallet(),
      makeOrderKeypair: () => makeFakeKeypair(),
      getDlmm: async () => {
        dlmmCalled = true;
        return makeFakeDlmm();
      },
      makeBN: fakeMakeBN,
      signAndSend: async () => "SIG",
    });
    for (const baseAmount of [0, -1, NaN, Infinity, undefined]) {
      await assert.rejects(
        () => placeLimitOrder({ pool: "P", side: "sell", price: 1, baseAmount }),
        /invalid sell amount/i,
        `baseAmount ${baseAmount} should be rejected`
      );
    }
    assert.strictEqual(dlmmCalled, false, "invalid sell amount rejected before touching chain deps");
  })
);

test(
  "live placeLimitOrder throws when pool does not support limit orders",
  withLiveEnv(async () => {
    const fakeDlmm = makeFakeDlmm({ supportsLimitOrder: false });
    __setDeps({
      getWallet: () => makeFakeWallet(),
      makeOrderKeypair: () => makeFakeKeypair(),
      getDlmm: async () => fakeDlmm,
      makeBN: fakeMakeBN,
      signAndSend: async () => "SIG",
    });
    await assert.rejects(
      () => placeLimitOrder({ pool: "P", side: "buy", price: 1, amountSol: 0.1 }),
      /does not support limit orders/
    );
  })
);

test(
  "live placeLimitOrder pre-flight: invalid price / amount fail closed",
  withLiveEnv(async () => {
    let dlmmCalled = false;
    __setDeps({
      getWallet: () => makeFakeWallet(),
      makeOrderKeypair: () => makeFakeKeypair(),
      getDlmm: async () => {
        dlmmCalled = true;
        return makeFakeDlmm();
      },
      makeBN: fakeMakeBN,
      signAndSend: async () => "SIG",
    });

    for (const price of [0, -1, NaN, Infinity]) {
      await assert.rejects(
        () => placeLimitOrder({ pool: "P", side: "buy", price, amountSol: 0.1 }),
        /invalid/i,
        `price ${price} should be rejected`
      );
    }
    await assert.rejects(
      () => placeLimitOrder({ pool: "P", side: "buy", price: 1, amountSol: 0 }),
      /invalid/i,
      "amountSol 0 on buy should be rejected"
    );
    assert.strictEqual(dlmmCalled, false, "pre-flight rejects before touching chain deps");
  })
);

test("DRY_RUN placeLimitOrder does not touch __deps", async () => {
  const prev = process.env.DRY_RUN;
  process.env.DRY_RUN = "true";
  let touched = false;
  __setDeps({
    getWallet: () => {
      touched = true;
      return makeFakeWallet();
    },
  });
  try {
    const res = await placeLimitOrder({ pool: "P", side: "buy", price: 1, amountSol: 0.1 });
    assert.strictEqual(res.dry_run, true);
    assert.strictEqual(touched, false, "DRY_RUN must short-circuit before __deps");
  } finally {
    __resetDeps();
    if (prev === undefined) delete process.env.DRY_RUN;
    else process.env.DRY_RUN = prev;
  }
});

// ─── TASK 4: getLimitOrder status mapping ───────────────────────────────────

function buyEntry(id, { filledX = "0", unfilledY = "0", depositY = "1" } = {}) {
  return {
    publicKey: { toBase58: () => id },
    limitOrderData: {
      totalDepositAmountX: "0",
      totalDepositAmountY: depositY,
      totalFilledAmountX: filledX,
      totalFilledAmountY: "0",
      totalUnfilledAmountX: "0",
      totalUnfilledAmountY: unfilledY,
    },
  };
}

test(
  "live getLimitOrder buy fully filled → filled",
  withLiveEnv(async () => {
    const fakeDlmm = makeFakeDlmm({
      limitOrderList: [buyEntry("OID", { filledX: "5", unfilledY: "0" })],
    });
    __setDeps({
      getWallet: () => makeFakeWallet(),
      getDlmm: async () => fakeDlmm,
    });
    const res = await getLimitOrder("OID", { pool: "P", side: "buy" });
    assert.strictEqual(res.status, "filled");
    assert.strictEqual(res.filledBaseAmount, 5);
  })
);

test(
  "live getLimitOrder buy partial → partial",
  withLiveEnv(async () => {
    const fakeDlmm = makeFakeDlmm({
      limitOrderList: [buyEntry("OID", { filledX: "3", unfilledY: "0.5" })],
    });
    __setDeps({
      getWallet: () => makeFakeWallet(),
      getDlmm: async () => fakeDlmm,
    });
    const res = await getLimitOrder("OID", { pool: "P", side: "buy" });
    assert.strictEqual(res.status, "partial");
    assert.strictEqual(res.filledBaseAmount, 3);
  })
);

test(
  "live getLimitOrder buy open → open",
  withLiveEnv(async () => {
    const fakeDlmm = makeFakeDlmm({
      limitOrderList: [buyEntry("OID", { filledX: "0", unfilledY: "1" })],
    });
    __setDeps({
      getWallet: () => makeFakeWallet(),
      getDlmm: async () => fakeDlmm,
    });
    const res = await getLimitOrder("OID", { pool: "P", side: "buy" });
    assert.strictEqual(res.status, "open");
  })
);

test(
  "live getLimitOrder id not in list → open + notFound",
  withLiveEnv(async () => {
    const fakeDlmm = makeFakeDlmm({
      limitOrderList: [buyEntry("OTHER", { filledX: "5" })],
    });
    __setDeps({
      getWallet: () => makeFakeWallet(),
      getDlmm: async () => fakeDlmm,
    });
    const res = await getLimitOrder("MISSING", { pool: "P", side: "buy" });
    assert.strictEqual(res.status, "open");
    assert.strictEqual(res.notFound, true);
  })
);

test("DRY_RUN getLimitOrder returns open", async () => {
  const prev = process.env.DRY_RUN;
  process.env.DRY_RUN = "true";
  try {
    const res = await getLimitOrder("z", { pool: "P" });
    assert.strictEqual(res.dry_run, true);
    assert.strictEqual(res.status, "open");
    assert.strictEqual(res.id, "z");
  } finally {
    if (prev === undefined) delete process.env.DRY_RUN;
    else process.env.DRY_RUN = prev;
  }
});

// ─── TASK 5: cancelLimitOrder live path ─────────────────────────────────────

test(
  "live cancelLimitOrder: passes binIds through, returns signature",
  withLiveEnv(async () => {
    const wallet = makeFakeWallet("WCANCEL");
    const fakeDlmm = makeFakeDlmm();
    let signArgs = null;
    __setDeps({
      getWallet: () => wallet,
      getDlmm: async () => fakeDlmm,
      makePublicKey: (s) => ({ __pk: s, toBase58: () => s }),
      signAndSend: async (tx, signers) => {
        signArgs = { tx, signers };
        return "SIGcancel";
      },
    });
    const res = await cancelLimitOrder("OID", { pool: "P", binIds: [42] });
    assert.deepStrictEqual(fakeDlmm.cancelArgs.binIds, [42], "binIds passed through");
    assert.strictEqual(fakeDlmm.cancelArgs.limitOrderPubkey.toBase58(), "OID");
    assert.strictEqual(res.signature, "SIGcancel");
    assert.strictEqual(res.cancelled, true);
    assert.strictEqual(res.id, "OID");
    assert.deepStrictEqual(signArgs.signers, [wallet]);
  })
);
