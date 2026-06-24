# @meteora-ag/dlmm@1.9.10 — Limit-Order SDK Notes

Verified by introspection on 2026-06-21 against the installed package. These are the
exact code paths the live wrapper (`meteora/limit-orders.js`) must use. **Do not re-guess.**

## Module / construction
```js
const DLMM = require("@meteora-ag/dlmm"); // the module IS the class; no `default`, no named place/get/cancel
const dlmm = await DLMM.create(connection, lbPairPubkey, opt); // opt optional
```
Useful instance properties:
- `dlmm.lbPair` — decoded lbPair state (pass to `DLMM.isSupportLimitOrder`).
- `dlmm.pubkey` — the lbPair pubkey.
- `dlmm.lbPair.binStep` — bin step (number).
- `dlmm.lbPair.activeId` — active bin id.
- `dlmm.tokenX.mint.decimals`, `dlmm.tokenY.mint.decimals` — token decimals.
- `dlmm.program.programId` — program id.
- For DLMM SOL/token pools: token X is the BASE, token Y is the QUOTE (SOL/NATIVE_MINT).

## Pool capability guard
```js
const DLMM = require("@meteora-ag/dlmm");
if (!DLMM.isSupportLimitOrder(dlmm.lbPair)) throw new Error("pool does not support limit orders");
```

## Price → bin id (TWO steps)
```js
// human price (quote per base) → price-per-lamport → bin id
const perLamport = DLMM.getPricePerLamport(decimalsX, decimalsY, price); // returns string
const binId = DLMM.getBinIdFromPrice(perLamport, binStep, true);          // min=true → floor; false → ceil
```
- `getPricePerLamport(tokenXDecimal, tokenYDecimal, price) = price * 10^(decY - decX)`.
- `getBinIdFromPrice(price, binStep, min)` → integer bin id.
- For a BUY (bid) at/below support use `min=true` (floor). For a SELL (ask) at target use `min=false` (ceil). Confirm direction during smoke test; floor/ceil is a 1-bin nuance.

## placeLimitOrder (returns UNSIGNED legacy Transaction)
```js
const { BN } = require("@coral-xyz/anchor");
const owner = wallet.publicKey;
const amount = new BN(rawUnitsString); // raw token units (NOT UI)
const tx = await dlmm.placeLimitOrder({
  owner, payer: owner, sender: owner,
  limitOrder: orderKeypair.publicKey,           // fresh Keypair; its pubkey is our order id
  params: { bins: [{ id: binId, amount }], isAskSide /* relativeBin omitted → absolute bin id */ },
});
// sign with [wallet, orderKeypair] and send.
```
- BUY: `isAskSide:false`, deposit QUOTE (SOL/Y). `amount` = SOL lamports = `round(amountSol * 1e9)`.
- SELL: `isAskSide:true`, deposit BASE (X). `amount` = real held base balance in **raw** units = `round(uiBalance * 10^decimalsX)`.
- `relativeBin` omitted/null → `bin.id` is treated as an ABSOLUTE bin id (good — we computed absolute).

## getLimitOrder — fill detection is NOT a simple field
`dlmm.getLimitOrder(pubkey)` returns an UNPARSED `LimitOrderV1Wrapper`; deriving fill requires
`parseInfo(programId, lbPair, baseMint, quoteMint, clock, binArrayMap)` with the clock + fetched bin arrays.

**Use the convenience method instead** — it does all the fetching + parsing:
```js
const list = await dlmm.getLimitOrderByUserAndLbPair(wallet.publicKey);
// → [{ publicKey, limitOrderData }]
const mine = list.find(o => o.publicKey.toBase58() === id);
```
`limitOrderData` (from `parseInfo`) fields are **UI-decimal strings**:
- `totalDepositAmountX`, `totalDepositAmountY`
- `totalFilledAmountX`,  `totalFilledAmountY`
- `totalUnfilledAmountX`, `totalUnfilledAmountY`
- `limitOrderBinData[]` (per-bin)

### Status derivation (single-bin orders)
Per-bin enum is `LimitOrderStatus { NotFilled:0, PartialFilled:1, Fulfilled:2 }`. Derive overall status from amounts off the **deposit side**:
- BUY (deposited Y/SOL): `open` if `totalFilledAmountX == 0`; `filled` if `totalUnfilledAmountY == 0`; else `partial`.
- SELL (deposited X/base): `open` if `totalFilledAmountY == 0`; `filled` if `totalUnfilledAmountX == 0`; else `partial`.
- `filledBaseAmount` (for partial-buy cost-basis) = `totalFilledAmountX` (UI string → Number).

### Edge: order not found in list
If `id` is absent from `getLimitOrderByUserAndLbPair` (fully consumed+auto-closed, or cancelled), return
`{ status: "open", notFound: true }` and log. Conservative: Branch D stale-cancel eventually cleans up; do NOT
treat not-found as filled (avoids placing a sell against a non-existent fill). Re-examine after smoke test.

## cancelLimitOrder (returns UNSIGNED legacy Transaction)
```js
const tx = await dlmm.cancelLimitOrder({
  limitOrderPubkey: new PublicKey(id),
  owner: wallet.publicKey,
  rentReceiver: wallet.publicKey,
  binIds: [binId],          // the order's bin id(s); for single-bin, the one we placed
});
// sign with [wallet], send. Optionally dlmm.closeLimitOrderIfEmpty({limitOrder, owner, rentReceiver}) to reclaim rent.
```
- `binIds` can be taken from the order's `limitOrderBinData` (per-bin `binId()`), or we can persist the placed bin id in our own state to avoid a refetch.

## Signing/sending legacy Transactions
The SDK returns legacy `web3.Transaction` (already has feePayer + recentBlockhash set). Sign + send:
```js
const sig = await connection.sendTransaction(tx, [wallet, ...extraSigners]); // or sign() + sendRawTransaction()
await connection.confirmTransaction(sig, "confirmed");
```
Note: existing `tools/wallet.js` signs **VersionedTransaction** for Jupiter swaps; the DLMM path is legacy `Transaction`. Add a dedicated legacy sign+send helper in the wrapper — do not reuse the Jupiter path.

## Implication for the plan
- **Task 4** `getLimitOrder(id, {pool})` should be implemented via `getLimitOrderByUserAndLbPair(wallet.publicKey)` + find-by-pubkey + amount-based status derivation above — NOT a single `status` field. Tests inject a fake DLMM whose `getLimitOrderByUserAndLbPair` returns crafted `limitOrderData` amounts.
- **Task 3** persist the placed `binId` in the returned object (and into state) so cancel doesn't need a refetch.
