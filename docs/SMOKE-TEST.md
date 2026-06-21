# Orion — Mainnet Smoke Test

> **⚠️ WARNING — THIS SPENDS REAL SOL ON MAINNET.** There is no testnet path for the
> Meteora limit-order surface; this checklist is the human verification gate before any
> real-size trading. The live on-chain path is wired and unit-tested (against an injected
> fake DLMM) but has **never executed on-chain** — this run verifies it for the first time.
>
> **MUST run on Orion's OWN wallet.** Per the **SEPARATE-WALLET RULE** in `CLAUDE.md`,
> Orion's wallet must differ from Meridian's (`BeEGreU2nwr8bXmrsi1Tf8ALZbVWP9VomfeaEMDLmSYg`)
> and from Polaris's. A shared wallet makes the agents collide on the same SOL/token
> balances and stomp each other's orders. Double-check `WALLET_PRIVATE_KEY` before booting live.

---

## Prerequisites

1. **Fund Orion's wallet with ~0.05 SOL.** Enough for one tiny round-trip plus fees and
   limit-order account rent. (Rent is reclaimed on cancel/close.)
2. **`.env`** (Orion's own, see SEPARATE-WALLET RULE):
   ```
   WALLET_PRIVATE_KEY=...   # base58, MUST differ from Meridian/Polaris
   RPC_URL=https://mainnet.helius-rpc.com/?api-key=...
   ```
3. **`orion-config.json`** — clamp everything to the smallest possible footprint:
   ```json
   {
     "orion": {
       "maxOrderSizeSol": 0.01,
       "orderSizeSol": 0.01,
       "maxConcurrentOrders": 1,
       "maxTotalExposureSol": 0.01
     }
   }
   ```
   This forces a single ~0.01 SOL order and refuses to open a second.

---

## Steps

### 1. Boot live and verify the banner
```
DRY_RUN=false LIVE_TRADING=true node index.js
```
Live trading requires **BOTH** `DRY_RUN=false` **AND** `LIVE_TRADING=true`. If either is
missing, `live-mode.js` forces dry-run and logs a warning — if you see that warning, you are
NOT live; fix the env and reboot.

Confirm the startup banner shows:
- mode **LIVE** (not DRY-RUN),
- the correct Orion **wallet pubkey** (cross-check against the wallet you funded),
- the active **caps**: `maxOrderSizeSol=0.01 | maxTotalExposureSol=0.01 | maxConcurrentOrders=1`.

### 2. Place a real buy limit (`scan`)
At the REPL, type:
```
scan
```
This runs one scan cycle. If a setup fires it places a real single-bin buy limit on-chain.
- Note the **transaction signature** logged (`placed buy id=… bin=… sig=…`) and open it on a
  Solana explorer (e.g. solscan.io / explorer.solana.com) — confirm it **succeeded**.
- The buy should show as **open** (unfilled) via `getLimitOrder` until it fills.

> If no setup fires, no order is placed — that is correct behavior, not a failure. Re-run
> `scan` later or pick a moment when a candidate is in a pullback. You only need ONE order to
> exercise the path.

### 3. Verify state is keyed by the limit-order pubkey (`orders`)
```
orders
```
Confirm the order is recorded in `orion-state.json` with `id` = the **limit-order account
pubkey** (the order Keypair's pubkey, same id used by `getLimitOrder`/`cancelLimitOrder`).

### 4. Cancel and reclaim rent (`/cancel 1`)
Via Telegram (or the equivalent path), cancel the resting order:
```
/cancel 1
```
- Confirm the **cancel tx** confirms on the explorer.
- Confirm the **rent** for the limit-order account is **reclaimed** to the Orion wallet
  (`closeLimitOrderIfEmpty` path) — wallet SOL should recover most of the order's account cost.

### 5. Run a full lifecycle on one tiny position (`manage`)
**Only after steps 2–4 pass**, let a `manage` cycle drive a complete round-trip on a single
~0.01 SOL position: buy **fill → TP1 (HALF) sell at target → exit**. Watch:
- Branch A fires on fill: places the TP1 sell sized from the **real held base balance** ×
  `scaleOutPct` (recomputed cost basis if the buy was a partial fill).
- The sell limit lands on-chain (verify signature on explorer).
- The runner/breakdown market-exit (if it triggers) sells the **real held balance** via Jupiter.
- Final state: order `closed` with a `closedReason` and an approximate realized PnL.

Keep position size tiny — this is verification, not trading.

---

## What to watch for / known live-path unknowns

These are flagged in `docs/sdk-notes.md` and by review as **only verifiable live** — pay
attention to each during the run:

- **Floor/ceil bin direction.** Buy (bid) uses `min=true` (floor); sell (ask) uses `min=false`
  (ceil). This is a 1-bin nuance — confirm the buy actually rests at/below intended support and
  the sell at/above target. If a fill happens at an unexpected bin, the direction may be inverted.
- **`DLMM` default-import interop shape.** The wrapper imports via `mod.default ?? mod` because
  the CJS module *is* the class with no `default`. Verify `DLMM.create` resolves and the instance
  has `lbPair`, `tokenX/tokenY`, `placeLimitOrder`, etc. A `… is not a function` here means the
  interop fell through.
- **`getWalletBalances()` pubkey field for the banner.** The banner reads `address ?? pubkey ??
  publicKey`. Confirm the banner shows the real wallet, not `n/a` — if `n/a`, the field name
  differs and the banner sourcing needs fixing (cosmetic, but verify the wallet is correct another way).
- **Held-balance UI-units assumption for sell sizing.** TP1 sell sizing multiplies the held base
  balance (assumed **UI** units) by `scaleOutPct` and scales to raw via token decimals. Confirm the
  sell amount on-chain matches roughly half the bought tokens — a 10^decimals error means the
  balance was already raw, not UI.
- **Land-but-fail-to-confirm semantics.** `signAndSend` **throws** when a tx lands but
  confirmation fails/expires, and the thrown message **includes the signature**. If you see such a
  throw, do NOT assume the order is gone — look the signature up on the explorer and reconcile via
  `getLimitOrderByUserAndLbPair` (the order may actually be resting on-chain).
