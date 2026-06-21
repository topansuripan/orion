# Orion Live Trading Enablement — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the broken/guessed `@meteora-ag/dlmm` limit-order wrapper with the real instance-method surface, add fail-closed safety rails + a live-trading kill-switch, and handle partial fills — so Orion *can* run live while `DRY_RUN=true` stays the default.

**Architecture:** Approach A — preserve the external wrapper contract (`placeLimitOrder/getLimitOrder/cancelLimitOrder` signatures unchanged so `orders.js` and its injected-fake tests are untouched); fix only the internals to build a cached `DLMM` instance per pool, sign+send the SDK's unsigned `Transaction`s, and map the real `LimitOrderStatus` enum. Safety caps live in the pure `risk.js`; the kill-switch gates the live path.

**Tech Stack:** Node ESM, `@meteora-ag/dlmm@1.9.10`, `@solana/web3.js`, `@coral-xyz/anchor` BN, `node:test`.

**Design doc:** `docs/plans/2026-06-21-orion-live-trading-design.md`

**Confirmed SDK facts (do not re-guess):**
- `const DLMM = require('@meteora-ag/dlmm')` — the module IS the class. No `default`, no named `placeLimitOrder`.
- `await DLMM.create(connection, lbPairPubkey, opt)` → instance.
- Instance methods: `placeLimitOrder({owner, payer, sender, limitOrder, params})`, `getLimitOrder(limitOrderPubkey)`, `cancelLimitOrder({limitOrderPubkey, owner, rentReceiver, binIds})`, `quoteCreateLimitOrder`, `closeLimitOrderIfEmpty`.
- `placeLimitOrder`/`cancelLimitOrder` RETURN an unsigned legacy `Transaction`.
- `params = { bins: [{ id, amount /* BN raw units */ }], isAskSide }`.
- Static `DLMM.isSupportLimitOrder(lbPairState)`, `DLMM.getBinIdFromPrice(price, binStep, min)`.
- Fill status enum: `DLMM.LimitOrderStatus = { NotFilled:0, PartialFilled:1, Fulfilled:2 }`.

---

## Task 0: SDK surface verification spike

Pin down the three details the design left to confirm, so later tasks code against fact, not guesses. Output a short notes file; no production code.

**Files:**
- Create: `docs/sdk-notes.md`

**Step 1:** Run a throwaway introspection script (Bash) to capture, into `docs/sdk-notes.md`:
- The exact price→binId path. Verify whether human price must first go through `DLMM.getPricePerLamport(decimalsX, decimalsY, price)` before `getBinIdFromPrice(pricePerLamport, binStep, min)`. Record the chosen conversion and any `relativeBin`/`activeId` handling.
- The field on `getLimitOrder(pubkey)`'s wrapped result that carries the `LimitOrderStatus` and the filled base amount (inspect `wrapLimitOrder` output keys).
- Whether `placeLimitOrder` needs `params.relativeBin` for an absolute bin id (compare against `activeId`).

Run: `node -e "const DLMM=require('@meteora-ag/dlmm'); console.log(String(DLMM.getPricePerLamport)); console.log(String(DLMM.prototype.getLimitOrder)); ..."`

**Step 2:** Write findings to `docs/sdk-notes.md` with the exact code snippet to use for price→binId and status/filled extraction.

**Step 3: Commit**
```bash
git add docs/sdk-notes.md
git commit -m "docs: pin down dlmm limit-order SDK details (price->bin, status/filled fields)"
```

---

## Task 1: Config — new safety-cap + interval keys

**Files:**
- Modify: `config.js:366-371` (the `orion` block)

**Step 1: Add keys** after `orderSizePct` and before `maxConcurrentOrders`:
```js
    maxOrderSizeSol:       orionUserConfig.maxOrderSizeSol       ?? 0.01,
    maxTotalExposureSol:   orionUserConfig.maxTotalExposureSol   ?? 0.03,
```
(Defaults are intentionally tight for first live runs; raise in `orion-config.json` once proven.)

**Step 2: Verify** `node --check config.js` → Expected: no output (pass).

**Step 3: Commit**
```bash
git add config.js
git commit -m "feat(config): orion live-trading safety caps (maxOrderSizeSol, maxTotalExposureSol)"
```

---

## Task 2: risk.js — order-size clamp + exposure cap (pure, TDD)

**Files:**
- Test: `risk.test.js`
- Modify: `risk.js`

**Step 1: Write failing tests** (append to `risk.test.js`):
```js
test("computeOrderSize clamps to maxOrderSizeSol when set", () => {
  const cfg = { gasReserve: 0.05, orderSizeSol: 0.2, orderSizePct: 0.25, maxOrderSizeSol: 0.01 };
  // deployable=4.95, 25%≈1.2375, but cap wins → 0.01
  assert.equal(computeOrderSize(5, 0, cfg), 0.01);
});

test("computeOrderSize: no maxOrderSizeSol leaves behavior unchanged", () => {
  const cfg = { gasReserve: 0.05, orderSizeSol: 0.2, orderSizePct: 0.25 };
  assert.equal(computeOrderSize(5, 0, cfg), clampRef(4.95 * 0.25, 0.2, 4.95)); // ≈1.2375
});

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
```
(Add `clampRef` local helper in the test or assert the literal ≈1.2375; keep it exact.)

**Step 2: Run** `node --test risk.test.js` → Expected: FAIL (`exposureWouldExceed` not defined; clamp test fails).

**Step 3: Implement** in `risk.js`:
- In `computeOrderSize`, after the existing `clamp(...)`, apply the cap:
```js
export function computeOrderSize(walletSol, openOrders, cfg) {
  const deployable = walletSol - cfg.gasReserve;
  if (deployable < cfg.orderSizeSol) return 0;
  let size = clamp(deployable * cfg.orderSizePct, cfg.orderSizeSol, deployable);
  if (Number.isFinite(cfg.maxOrderSizeSol) && size > cfg.maxOrderSizeSol) {
    size = cfg.maxOrderSizeSol; // cap wins even when below the orderSizeSol floor (fail-closed)
  }
  return size;
}
```
- Add:
```js
/**
 * Whether adding an order of `newSizeSol` would push total committed SOL
 * (sum of open/holding order sizes + new) over cfg.maxTotalExposureSol.
 * Fail-open ONLY when no cap is configured (undefined). PURE.
 */
export function exposureWouldExceed(openOrders, newSizeSol, cfg) {
  const cap = cfg.maxTotalExposureSol;
  if (!Number.isFinite(cap)) return false;
  const committed = (openOrders || []).reduce((a, o) => a + (Number(o.sizeSol) || 0), 0);
  return committed + (Number(newSizeSol) || 0) > cap;
}
```

**Step 4: Run** `node --test risk.test.js` → Expected: PASS.

**Step 5: Commit**
```bash
git add risk.js risk.test.js
git commit -m "feat(risk): maxOrderSizeSol clamp + exposureWouldExceed cap (fail-closed)"
```

---

## Task 3: limit-orders.js — chain plumbing + live placeLimitOrder (TDD with injected fake)

The wrapper must stay unit-testable without chain deps. Refactor so the SDK interaction goes through small injectable seams. DRY_RUN branches unchanged.

**Files:**
- Modify: `meteora/limit-orders.js`
- Test: `meteora/limit-orders.test.js`

**Design of the seam:** Add an internal `__deps` object (module-level, overridable in tests) holding `getDlmm(pool)`, `getWallet()`, `signAndSend(tx, signers)`, and `makeOrderKeypair()`. Default implementations lazily import chain deps; tests inject fakes. Export a `__setDeps(partial)` / `__resetDeps()` for tests only (documented test-only).

**Step 1: Write failing tests** (`meteora/limit-orders.test.js`), with `process.env.DRY_RUN` unset and injected fakes:
```js
test("placeLimitOrder(buy): bid side, lamports amount, id = order keypair pubkey", async () => {
  const calls = {};
  __setDeps({
    getWallet: () => ({ publicKey: { toBase58: () => "WALLET" } }),
    makeOrderKeypair: () => ({ publicKey: { toBase58: () => "ORDER_PUBKEY" } }),
    getDlmm: async () => ({
      lbPair: {},
      isSupport: true,
      binStep: 10, tokenXDecimals: 6, tokenYDecimals: 9,
      priceToBinId: (p) => 12345,
      placeLimitOrder: async (args) => { calls.place = args; return { __tx: true }; },
    }),
    isSupportLimitOrder: () => true,
    signAndSend: async (tx, signers) => { calls.signers = signers; return "SIG"; },
  });
  const res = await placeLimitOrder({ pool: "POOL", side: "buy", price: 0.001, amountSol: 0.01 });
  assert.equal(res.id, "ORDER_PUBKEY");
  assert.equal(res.signature, "SIG");
  assert.equal(calls.place.params.isAskSide, false);
  assert.equal(calls.place.params.bins[0].id, 12345);
  // amount is a BN of 0.01 SOL = 10_000_000 lamports
  assert.equal(calls.place.params.bins[0].amount.toString(), "10000000");
  assert.deepEqual(calls.signers.map(s => s.publicKey.toBase58()), ["WALLET", "ORDER_PUBKEY"]);
  __resetDeps();
});

test("placeLimitOrder(sell): ask side, amount from real held base balance (raw units)", async () => {
  const calls = {};
  __setDeps({ /* held balance 5.0 base @ 6 decimals → 5_000_000 */
    getWallet: () => ({ publicKey: { toBase58: () => "WALLET" } }),
    makeOrderKeypair: () => ({ publicKey: { toBase58: () => "SELL_PUBKEY" } }),
    getHeldBaseRaw: async () => "5000000",
    getDlmm: async () => ({ lbPair:{}, binStep:10, tokenXDecimals:6, tokenYDecimals:9, priceToBinId:()=>9, placeLimitOrder: async (a)=>{calls.place=a; return {};} }),
    isSupportLimitOrder: () => true,
    signAndSend: async () => "SIG2",
  });
  const res = await placeLimitOrder({ pool: "POOL", side: "sell", price: 0.002, amountSol: 999 /* ignored */ });
  assert.equal(calls.place.params.isAskSide, true);
  assert.equal(calls.place.params.bins[0].amount.toString(), "5000000");
  assert.equal(res.id, "SELL_PUBKEY");
  __resetDeps();
});

test("placeLimitOrder: throws when pool does not support limit orders", async () => {
  __setDeps({ getDlmm: async () => ({ lbPair:{} }), isSupportLimitOrder: () => false });
  await assert.rejects(() => placeLimitOrder({ pool:"P", side:"buy", price:1, amountSol:0.01 }), /does not support limit orders/);
  __resetDeps();
});

test("placeLimitOrder: throws on non-finite price/amount (pre-flight)", async () => {
  __setDeps({ getDlmm: async () => ({ lbPair:{} }), isSupportLimitOrder: () => true });
  await assert.rejects(() => placeLimitOrder({ pool:"P", side:"buy", price:NaN, amountSol:0.01 }), /invalid/i);
  __resetDeps();
});

test("placeLimitOrder(sell): skips when held balance is zero", async () => {
  __setDeps({ getDlmm: async () => ({ lbPair:{}, tokenXDecimals:6 }), isSupportLimitOrder: () => true, getHeldBaseRaw: async () => "0" });
  await assert.rejects(() => placeLimitOrder({ pool:"P", side:"sell", price:1, amountSol:0 }), /no held balance/i);
  __resetDeps();
});

test("DRY_RUN placeLimitOrder still short-circuits without touching deps", async () => {
  process.env.DRY_RUN = "true";
  const res = await placeLimitOrder({ pool:"P", side:"buy", price:1, amountSol:0.01 });
  assert.equal(res.dry_run, true);
  delete process.env.DRY_RUN;
});
```

**Step 2: Run** `node --test meteora/limit-orders.test.js` → Expected: FAIL (`__setDeps` undefined, etc.).

**Step 3: Implement** the seam + live path in `meteora/limit-orders.js`. Keep DRY_RUN branch first. Reference `docs/sdk-notes.md` (Task 0) for the exact `priceToBinId` formula and held-amount extraction. Sketch:
```js
// ── test-injectable seam (default impls lazily import chain deps) ──
const __deps = {
  isSupportLimitOrder: null,           // set in getDlmm default
  getWallet: async () => { const { getWalletKeypair } = await import("../tools/wallet.js"); return getWalletKeypair(); },
  makeOrderKeypair: async () => { const { Keypair } = await import("@solana/web3.js"); return Keypair.generate(); },
  getDlmm: async (pool) => { /* DLMM.create + cache, attach binStep/decimals/priceToBinId/isSupport */ },
  getHeldBaseRaw: async (pool) => { /* getWalletTokenBalance(baseMint) → raw BN string */ },
  signAndSend: async (tx, signers) => { /* set feePayer/blockhash already on tx; sign + sendRawTransaction + confirm; return signature */ },
};
export function __setDeps(p) { Object.assign(__deps, p); }   // TEST ONLY
export function __resetDeps() { /* restore defaults */ }      // TEST ONLY
```
Live `placeLimitOrder`:
1. DRY_RUN → existing short-circuit.
2. `dlmm = await __deps.getDlmm(pool)`.
3. `if (!__deps.isSupportLimitOrder(dlmm.lbPair)) throw new Error("pool does not support limit orders")`.
4. Validate `Number.isFinite(price) && price > 0`; for buy also `amountSol > 0` → else throw `/invalid/`.
5. `binId = dlmm.priceToBinId(price)`.
6. buy: `isAskSide=false`, `amount = new BN(Math.round(amountSol * 10**9))`. sell: `isAskSide=true`, `raw = await __deps.getHeldBaseRaw(pool)`; if `!(BigInt(raw) > 0n)` throw `/no held balance/`; `amount = new BN(raw)`.
7. `order = await __deps.makeOrderKeypair(); wallet = await __deps.getWallet()`.
8. `tx = await dlmm.placeLimitOrder({ owner: wallet.publicKey, payer: wallet.publicKey, sender: wallet.publicKey, limitOrder: order.publicKey, params: { bins:[{id:binId, amount}], isAskSide } })`.
9. `sig = await __deps.signAndSend(tx, [wallet, order])`.
10. `return { id: order.publicKey.toBase58(), signature: sig, side, price }`.

(Need `import { BN } from "@coral-xyz/anchor"` — lazy inside the function to keep tests chain-free, OR inject a `makeBN`. Prefer lazy import of BN.)

**Step 4: Run** `node --test meteora/limit-orders.test.js` → Expected: PASS.

**Step 5: Commit**
```bash
git add meteora/limit-orders.js meteora/limit-orders.test.js
git commit -m "feat(limit-orders): real DLMM placeLimitOrder (sign+send, bid/ask, held-balance sell sizing)"
```

---

## Task 4: limit-orders.js — getLimitOrder status mapping (TDD)

**Files:**
- Modify: `meteora/limit-orders.js`
- Test: `meteora/limit-orders.test.js`

**Step 1: Failing tests:**
```js
test("getLimitOrder maps Fulfilled→filled", async () => {
  __setDeps({ getDlmm: async () => ({ getLimitOrder: async () => ({ status: 2, totalFilled: "5000000" }) }) });
  const r = await getLimitOrder("ORDER", { pool: "POOL" });
  assert.equal(r.status, "filled");
  __resetDeps();
});
test("getLimitOrder maps PartialFilled→partial with filledBaseAmount", async () => {
  __setDeps({ getDlmm: async () => ({ getLimitOrder: async () => ({ status: 1, totalFilled: "2500000" }) }) });
  const r = await getLimitOrder("ORDER", { pool: "POOL" });
  assert.equal(r.status, "partial");
  assert.equal(r.filledBaseAmount, "2500000");
  __resetDeps();
});
test("getLimitOrder maps NotFilled→open", async () => {
  __setDeps({ getDlmm: async () => ({ getLimitOrder: async () => ({ status: 0 }) }) });
  assert.equal((await getLimitOrder("ORDER", { pool:"POOL" })).status, "open");
  __resetDeps();
});
```
(Note: signature gains an optional `{pool}` 2nd arg so the wrapper can resolve the DLMM instance. `orders.js` already has `order.pool` available — Task 6 threads it in. Confirm exact `status`/`totalFilled` field names from `docs/sdk-notes.md` and adjust the mapping accordingly.)

**Step 2: Run** → FAIL.

**Step 3: Implement** `getLimitOrder(id, { pool } = {})`: DRY_RUN → `{dry_run:true, id, status:"open"}`. Live → `dlmm = await __deps.getDlmm(pool); raw = await dlmm.getLimitOrder(new PublicKey(id))`; map enum (`2→filled, 1→partial, 0→open`) using the confirmed field; return `{ status, filledPct, filledBaseAmount, raw }`.

**Step 4: Run** → PASS.

**Step 5: Commit**
```bash
git add meteora/limit-orders.js meteora/limit-orders.test.js
git commit -m "feat(limit-orders): map real LimitOrderStatus enum in getLimitOrder"
```

---

## Task 5: limit-orders.js — cancelLimitOrder (TDD)

**Files:** Modify `meteora/limit-orders.js`; Test `meteora/limit-orders.test.js`.

**Step 1: Failing test:**
```js
test("cancelLimitOrder fetches binIds and signs+sends cancel tx", async () => {
  const calls = {};
  __setDeps({
    getWallet: () => ({ publicKey: { toBase58: () => "WALLET" } }),
    getDlmm: async () => ({
      getLimitOrder: async () => ({ binIds: [101] }),
      cancelLimitOrder: async (a) => { calls.cancel = a; return { __tx: true }; },
    }),
    signAndSend: async () => "CANCELSIG",
  });
  const r = await cancelLimitOrder("ORDER", { pool: "POOL" });
  assert.equal(r.signature, "CANCELSIG");
  assert.deepEqual(calls.cancel.binIds, [101]);
  __resetDeps();
});
```
**Step 2: Run** → FAIL.
**Step 3: Implement** `cancelLimitOrder(id, { pool } = {})`: DRY_RUN short-circuit unchanged. Live → resolve dlmm, fetch order for `binIds`, `tx = await dlmm.cancelLimitOrder({ limitOrderPubkey: new PublicKey(id), owner: wallet.publicKey, rentReceiver: wallet.publicKey, binIds })`, `signAndSend(tx, [wallet])`, return `{ id, signature, cancelled: true }`.
**Step 4: Run** → PASS.
**Step 5: Commit**
```bash
git add meteora/limit-orders.js meteora/limit-orders.test.js
git commit -m "feat(limit-orders): real cancelLimitOrder (fetch binIds, sign+send)"
```

---

## Task 6: orders.js — tighten isFilled + partial-fill Branch A + thread pool into wrappers (TDD)

**Files:** Modify `orders.js`; Test `orders.test.js`.

**Step 1: Failing tests** (use existing injected-fake harness in `orders.test.js`):
```js
test("isFilled: only 'filled' is true; 'partial' and 'open' are false", () => {
  assert.equal(isFilled({ status: "filled" }), true);
  assert.equal(isFilled({ status: "partial" }), false);
  assert.equal(isFilled({ status: "open" }), false);
});

test("manage Branch A partial buy: cancels remainder, places sell from held balance, holds", async () => {
  // getLimitOrder returns {status:"partial", filledBaseAmount:"3000000"}; assert:
  //  - cancelLimitOrder called for the buy id
  //  - placeLimitOrder called with side:"sell"
  //  - store.markFilled called; order goes holding; partialEntry recorded
});
```
(Model the second test on the existing Branch A test in `orders.test.js`.)

**Step 2: Run** `node --test orders.test.js` → FAIL.

**Step 3: Implement:**
- `isFilled`: return `String(orderStatus.status).toLowerCase() === "filled"`.
- Add `isPartial(s)` → `status === "partial"`.
- Branch A: fetch `buyState = await getLimitOrder(id, { pool: order.pool })`. If `isFilled` → existing full path. Else if `isPartial(buyState)` → `await cancelLimitOrder(id, { pool: order.pool })`, then place the sell leg as today but recompute cost basis from `buyState.filledBaseAmount` (× entryPrice) and set `partialEntry:true` on the record via `store`. Go holding.
- Thread `{ pool: order.pool }` into all `getLimitOrder`/`cancelLimitOrder` calls in both cycles (the live wrapper needs it; DRY ignores it; injected fakes ignore it).

**Step 4: Run** `node --test orders.test.js` → PASS.

**Step 5: Commit**
```bash
git add orders.js orders.test.js
git commit -m "feat(orders): real fill semantics + partial-buy handling (cancel remainder, size sell from held)"
```

---

## Task 7: orders.js — exposure cap + LIVE_TRADING gate in scan cycle (TDD)

**Files:** Modify `orders.js`; Test `orders.test.js`.

**Step 1: Failing tests:**
```js
test("scan: skips placement when exposureWouldExceed", async () => {
  // open orders already at exposure cap → placed:0, reason mentions exposure
});
test("scan: when DRY_RUN=false and LIVE_TRADING unset, stays dry (no live place)", async () => {
  // assert the live gate forces dry behavior / warns
});
```
**Step 2: Run** → FAIL.
**Step 3: Implement:** in `runScanCycle`, before placing, compute open orders' sizes and call `exposureWouldExceed(openOrders, size, cfg.orion)`; if true, skip with a logged reason. Add a `liveEnabled` helper: `process.env.DRY_RUN === "false" && process.env.LIVE_TRADING === "true"`. If `DRY_RUN==="false"` but not `LIVE_TRADING`, log a loud warning once and treat as dry (the wrapper's own DRY_RUN check already short-circuits when `DRY_RUN!=="false"`; ensure we do NOT set DRY_RUN false in process without the gate — document that the gate is enforced at boot, Task 8).
**Step 4: Run** → PASS.
**Step 5: Commit**
```bash
git add orders.js orders.test.js
git commit -m "feat(orders): enforce total-exposure cap + LIVE_TRADING gate in scan"
```

---

## Task 8: index.js — boot-time live gate + startup banner

**Files:** Modify `index.js`.

**Step 1:** Add a `resolveLiveMode()` at boot: if `DRY_RUN === "false"` and `LIVE_TRADING !== "true"` → `log` + Telegram a loud warning and force `process.env.DRY_RUN = "true"` (fail-safe). Compute `live = DRY_RUN==="false" && LIVE_TRADING==="true"`.

**Step 2:** Startup banner (after SDK check, before cron): log + (if `telegram.isEnabled()`) `sendHTML` a one-shot summary: mode (LIVE/DRY), wallet pubkey (from `tools/wallet.js`), `maxOrderSizeSol`, `maxTotalExposureSol`, `maxConcurrentOrders`, scan/manage intervals.

**Step 3: Verify** `node --check index.js` → pass. (Full boot needs `.env`; not run here.)

**Step 4: Commit**
```bash
git add index.js
git commit -m "feat(index): boot live-trading gate + startup mode/caps banner"
```

---

## Task 9: Docs — smoke checklist + CLAUDE.md updates

**Files:** Create `docs/SMOKE-TEST.md`; Modify `CLAUDE.md` (Known Gaps + Config table + Running It).

**Step 1:** Write `docs/SMOKE-TEST.md` with the 6-step ~0.01 SOL mainnet procedure from the design doc Section 4.

**Step 2:** Update `CLAUDE.md`:
- Known Gap #1: mark SDK surface VERIFIED & rewritten against real instance methods (reference this plan + `docs/sdk-notes.md`).
- Known Gap #2: sell + stop now size from real held balance — mark resolved.
- Config table: add `maxOrderSizeSol` (0.01), `maxTotalExposureSol` (0.03).
- Running It: document `LIVE_TRADING=true` requirement and the smoke test.

**Step 3:** `npm test` → Expected: all green (94 + new tests). `npm run test:syntax` → pass.

**Step 4: Commit**
```bash
git add docs/SMOKE-TEST.md CLAUDE.md
git commit -m "docs: smoke-test checklist + CLAUDE.md gap/config updates for live trading"
```

---

## Final verification

- `npm test` — all pass.
- `npm run test:syntax` — pass.
- `git log --oneline` — clean per-task commits.
- Manual smoke test (`docs/SMOKE-TEST.md`) — **owner: user**, run once before any real-size trading.

**Still out of scope (remain TODO):** VPS provisioning/deploy automation; full partial-fill banking on the sell side.
