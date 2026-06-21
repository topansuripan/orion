# Orion — Live Trading Enablement Design

**Date:** 2026-06-21
**Status:** Approved
**Scope:** Wire the real `@meteora-ag/dlmm` limit-order surface + safety rails so Orion *can* run live. Keep `DRY_RUN=true` as the default. No VPS deploy this pass.

---

## Problem

The documented "SDK surface UNVERIFIED" gap is not just unverified — it is **broken**. `meteora/limit-orders.js` calls `dlmm.placeLimitOrder ?? dlmm.default?.placeLimitOrder`, but the installed `@meteora-ag/dlmm@1.9.10` has:

- **No** top-level `placeLimitOrder`/`getLimitOrder`/`cancelLimitOrder` functions and **no** `default` export.
- `module.exports` **is** the `DLMM` class. Construct via `await DLMM.create(connection, lbPairPubkey)`.
- Limit orders are **instance methods**: `placeLimitOrder`, `getLimitOrder`, `cancelLimitOrder`, `quoteCreateLimitOrder`, `closeLimitOrderIfEmpty`, `getLimitOrderByUserAndLbPair`.
- `placeLimitOrder` / `cancelLimitOrder` return an **unsigned legacy `Transaction`** — the caller signs and sends.
- Fill detection is the on-chain `LimitOrderStatus` enum: `{ NotFilled:0, PartialFilled:1, Fulfilled:2 }`.

In DRY_RUN the wrappers short-circuit before importing the SDK, so this is invisible until the first real trade, where every call throws `"... not found"`.

## Decisions (from brainstorming)

- **Scope:** Wire real SDK + safety rails. `DRY_RUN=true` default. No auto-deploy.
- **Verification:** Unit tests against an injected fake DLMM + a manual mainnet smoke checklist run once with ~0.01 SOL.
- **Approach A:** Preserve the external wrapper contract (`placeLimitOrder/getLimitOrder/cancelLimitOrder` signatures unchanged), fix only the internals. No DI refactor of `orders.js`.
- **Partial fills:** Explicit handling on the buy entry; safe wait-and-sweep on sells.
- **First-run caps:** `maxOrderSizeSol = 0.01`, `maxTotalExposureSol = 0.03` shipped defaults.

---

## Section 1 — Wrapper internals (`meteora/limit-orders.js`)

DRY_RUN branches unchanged (keeps unit tests chain-free). Live path only:

**Shared chain plumbing (lazy, module-scoped):**
- `getConnection()` — one `Connection` from `RPC_URL`, cached.
- `getWallet()` — reuse the `Keypair` from `tools/wallet.js`.
- `getDlmm(poolPubkey)` — `await DLMM.create(connection, poolPubkey)`, cached in a `Map` keyed by pool; caches token decimals + binStep.
- `signAndSend(tx, extraSigners=[])` — `tx.sign(wallet, ...extraSigners)`, `sendRawTransaction` + `confirmTransaction`. Shared by place/cancel.

**`placeLimitOrder({pool, side, price, amountSol})`:**
1. `dlmm = getDlmm(pool)`.
2. Guard `DLMM.isSupportLimitOrder(dlmm.lbPair)` — throw if unsupported.
3. `price` → bin id (SDK price/bin helpers + binStep).
4. `buy` → `isAskSide:false`, amount = `amountSol` → lamports BN (9 dp). `sell` → `isAskSide:true`, amount = **real held base balance** in raw units (instance token decimals). Sell ignores `amountSol`.
5. `limitOrder = Keypair.generate()`; `params = {bins:[{id, amount}], isAskSide}`.
6. `tx = await dlmm.placeLimitOrder({owner, payer, sender: owner, limitOrder: limitOrder.publicKey, params})`.
7. `signAndSend(tx, [limitOrder])`.
8. Return `{ id: limitOrder.publicKey.toBase58(), signature, side, price }`. **Order id = limit-order account pubkey.**

**`getLimitOrder(id)`** → `dlmm.getLimitOrder(new PublicKey(id))`, normalize (Section 2).

**`cancelLimitOrder(id)`** → fetch order for `binIds`, build cancel tx `{limitOrderPubkey, owner, rentReceiver: owner, binIds}`, `signAndSend`; optionally `closeLimitOrderIfEmpty` to reclaim rent.

## Section 2 — Fill / partial-fill semantics

`getLimitOrder(id)` returns `{ status: "open"|"partial"|"filled", filledPct, filledBaseAmount, raw }` mapping `LimitOrderStatus` (`NotFilled→open`, `PartialFilled→partial`, `Fulfilled→filled`).

`isFilled()` in `orders.js` tightened to real semantics: only `"filled"` → true.

**Buy entry (Branch A):**
- `"filled"` → place sell for full held balance → `holding`.
- `"partial"` → **cancel the unfilled remainder first** (reclaims resting SOL, removes the late-fill race), place sell sized to **real held base balance**, recompute cost basis from `filledBaseAmount × entryPrice`, mark `partialEntry:true`, go `holding`.
- `"open"` → wait (Branch D stale-cancel still applies).

**Sell legs (Branch C / TP1):**
- `"filled"` → bank as today.
- `"partial"` → treat as not yet banked, keep waiting. Safe: a resting sell stays at target and the position is still covered by breakdown/runner market-exits that sell the **real held balance**. No tokens stranded. Symmetric partial-banking deliberately out of scope.

## Section 3 — Safety rails

**Kill-switch / live gate:** `DRY_RUN=true` default. Live requires BOTH `DRY_RUN=false` AND `LIVE_TRADING=true`. If `DRY_RUN=false` without `LIVE_TRADING=true` → loud warning, stay dry.

**Hard caps (pure, `risk.js`, fail-closed):**
- `maxOrderSizeSol` (default `0.01`) — clamps `computeOrderSize`.
- `maxTotalExposureSol` (default `0.03`) — sum of open/holding `sizeSol` + new must stay under cap, else skip placement (logged).
- `gasReserve` post-trade assertion — refuse buy if it would drop balance below reserve. **(Deferred — redundant.** `computeOrderSize` already sizes against `deployable = walletSol − gasReserve` and clamps to it, so a buy cannot push the balance below the reserve by construction. A separate post-trade check adds no safety; revisit only if sizing logic changes.)
- Cap-below-floor (`maxOrderSizeSol < orderSizeSol`): cap wins, logged (not silent).

**Pre-flight assertions (wrapper):** pool supports limit orders; `price`/`amountSol` finite `>0`; bin id resolves; held balance `>0` for sells (else skip); tx confirmation checked — failed/expired tx throws so no phantom order is recorded.

**Startup announcement:** `index.js` logs + Telegrams live/dry state, wallet pubkey, active caps.

## Section 4 — Testing & smoke checklist

**Unit tests (TDD, chain-free):**
- `meteora/limit-orders.test.js`: inject fake DLMM instance — price→bin, BN conversions w/ decimals, buy=bid/sell=ask, id=keypair pubkey, signAndSend signers `[wallet, orderKeypair]`, status mapping (3 enum values), cancel passes `binIds`, pre-flight assertions fail closed.
- `risk.test.js`: `maxOrderSizeSol` clamp, `maxTotalExposureSol` rejection, cap-below-floor, `gasReserve` assertion.
- `orders.test.js`: Branch A partial path (cancel remainder → size sell from held → recomputed basis), `LIVE_TRADING` gate stays dry when unset.
- Existing DRY_RUN tests stay green untouched.

**Manual mainnet smoke (`docs/SMOKE-TEST.md`, ~0.01 SOL, Orion's own wallet):**
1. Fund ~0.05 SOL; config `maxOrderSizeSol 0.01`, `orderSizeSol 0.01`, `maxConcurrentOrders 1`.
2. `DRY_RUN=false LIVE_TRADING=true node index.js` → verify startup banner (live + wallet + caps).
3. REPL `scan` → real buy limit lands on-chain (explorer + `getLimitOrder` shows open).
4. `orders` → state recorded with limit-order pubkey id.
5. `/cancel 1` → cancel tx confirms, rent reclaimed.
6. Then let one `manage` cycle run a full fill→sell→exit on a tiny position.

**Out of scope:** VPS provisioning, deploy automation (remain TODO in CLAUDE.md).
