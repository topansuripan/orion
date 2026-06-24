# Orion — CLAUDE.md

Autonomous Meteora limit-order TA agent on Solana. Orion auto-screens liquid Meteora DLMM pools, runs **deterministic technical analysis** (no LLM) on their OHLCV, and when a setup fires it places a **single-bin limit BUY** at support. On fill it places a **limit SELL at target** and arms a **market stop-loss via Jupiter** for breakdowns. It is a directional order bot, NOT an LP bot.

---

## Fleet

Three autonomous Solana agents sharing Meridian's architecture lineage:

| Agent | Product | Role |
|-------|---------|------|
| Meridian | Meteora DLMM LP | LP — quick |
| Polaris | Meteora DLMM LP | LP — overnight |
| **Orion** | **Meteora limit orders** | **Limit-order TA sniper** |

Orion was forked architecturally from Meridian (reuses config/logger/telegram/wallet/screening infra) but has a brand-new deterministic trading core.

> ⚠️ **SEPARATE-WALLET RULE.** Orion MUST run on its own wallet — different from Meridian's `BeEGreU2nwr8bXmrsi1Tf8ALZbVWP9VomfeaEMDLmSYg` and from Polaris's wallet. A shared wallet makes the agents collide on the same SOL/token balances and stomp each other's orders. Orion has its own `.env`.

---

## Architecture Overview

```
index.js              Main entry: SDK version check → cron (scan/manage) + Telegram bot + stdin REPL
config.js             Runtime config from orion-config.json + .env; exposes config object (incl. config.orion)
risk.js               Pure helpers: computeOrderSize, canOpen, isOnCooldown, cooldownUntil
state.js              Order/position registry (orion-state.json): orders[] + per-token cooldowns
orders.js             runScanCycle / runManageCycle — the lifecycle orchestration (dependency-injected)

ta/
  indicators.js       Pure TA: atr (Wilder), bollinger, supertrend, swingLevels — arrays aligned by index
  setups.js           detectEntry / detectBreakdown — long-only entry/exit rules built on indicators.js

meteora/
  ohlcv.js            OHLCV fetch + normalizeCandles → [{t,o,h,l,c,v}] (Meteora datapi)
  limit-orders.js     @meteora-ag/dlmm ≥1.9.8 wrapper: assertSdkSupportsLimitOrders + place/get/cancel (DRY_RUN-aware)

pool-memory.js        SHIM for screening.js: isBaseMintOnCooldown / isPoolOnCooldown (token cooldowns via state.js)
tools/dlmm.js         SHIM for screening.js: getMyPositions() → maps held orders to {pool, base_mint}

Reused from Meridian (copied, lightly adapted):
  logger.js           log(category, message), logAction(...)
  telegram.js         sendMessage / sendHTML / startPolling / isEnabled / stopPolling
  tools/wallet.js     getWalletBalances, getWalletTokenBalance, swapToken (Jupiter), normalizeMint
  tools/screening.js  discoverPools / getTopCandidates / getPoolDetail (pool discovery)
  config.js           loader pattern (shared with Meridian's config shape)
```

The scan/manage cycles import the chain-heavy collaborators (`tools/wallet.js` → `@solana/web3.js`, `meteora/limit-orders.js` → `@meteora-ag/dlmm`) **lazily**, inside the default-collaborator factories in `orders.js`. This means importing `orders.js` (and running its tests with injected fakes) never requires those chain deps to be installed.

---

## Strategy / TA Pipeline

`OHLCV → indicators → setup → order`. Pure, deterministic, no LLM in the decision path.

1. **OHLCV** — `meteora/ohlcv.js fetchOhlcv(pool, {timeframe, candles})` hits
   `https://dlmm.datapi.meteora.ag/pools/{pool}/ohlcv?timeframe={tf}` (3-attempt backoff), then
   `normalizeCandles` maps the API's `data[]` rows (`timestamp/open/high/low/close/volume`) to
   `[{t,o,h,l,c,v}]` (coerces strings→numbers, drops malformed rows, caps to last `candles`).
2. **Indicators** (`ta/indicators.js`, all pure, index-aligned, `null` during warm-up):
   - `atr(candles, period=14)` — True Range + Wilder smoothing.
   - `bollinger(candles, {period:20, mult:2})` — `{middle, upper, lower}`, **population** stddev (÷N).
   - `supertrend(candles, {period:10, mult:3})` — `{value, direction}`, `direction ∈ {"bullish","bearish"}` (TradingView formulation; value sits on the lower band when bullish, upper band when bearish).
   - `swingLevels(candles, {lookback:5})` — most-recent confirmed fractal pivot low/high → `{support, resistance}`.
3. **Setup** (`ta/setups.js`):

   **`detectEntry(candles, cfg)`** → `null`, or `{entryPrice, stopPrice, targetPrice, reason}`. Fires only when the latest SuperTrend is **bullish** AND either:
   - **pullback to support** — `stValue ≤ close ≤ stValue*(1 + pullbackToSupportPct)`, OR
   - **below lower BB** — `close ≤ lower Bollinger band`.

   Then:
   - `entryPrice` = SuperTrend value (fallback: swing support if ST value unusable).
   - `stopPrice` = `entryPrice * (1 - stopLossPct)`.
   - `targetPrice` = swing resistance if `> entryPrice`, else `entryPrice + targetRMultiple*(entryPrice - stopPrice)`.

   **`detectBreakdown(candles, position, cfg)`** → `true` if latest SuperTrend flips **bearish** OR `latestClose < position.stopPrice`. Missing indicators yield `false` (no forced exit), never throw.

**Exit priority: stop before target.** In the manage cycle the breakdown (stop) branch is evaluated *before* the target-fill branch, so a position that has both broken down and hit target is closed as a stop.

---

## Order Lifecycle

### Scan cycle — `runScanCycle(deps)` (orders.js)
Find new entries, place buy limit orders. Returns `{placed, reason?}`.

1. If `!canOpen(openCount, cfg.orion)` → return `{placed:0, reason:"max orders"}`.
2. `getCandidates()` (wraps `getTopCandidates` → `{pool, token}`); snapshot already-occupied pools/tokens.
3. Per candidate: skip if on per-token cooldown, or if pool/token already has an open/holding order.
4. `fetchOhlcv` → `detectEntry`. If a setup fires and `computeOrderSize > 0`:
   `placeLimitOrder({pool, side:"buy", price:entryPrice, amountSol:size})` → `state.addOrder(...)` (status `"open"`) → `notify(...)`.

### Manage cycle — `runManageCycle(deps)` (orders.js)
Advance every open/holding order. Returns `{actions: [{id, type}]}`. The **scale-out lifecycle**:

| # | Precondition | Action | type |
|---|--------------|--------|------|
| **A** | status `open` & buy `getLimitOrder` reports `filled` **or** `partial` | on `partial`: cancel the unfilled buy remainder first + recompute cost basis (`partialEntry`); then `markFilled` → place TP1 (HALF) SELL limit at `targetPrice` sized from **real held base × `scaleOutPct`** → store `tp1OrderId`/`tp1BinId`, go `holding` | `tp1_placed` |
| **D** | status `open` & `now - createdAt > staleBuyHours` | `cancelLimitOrder(id, {pool, binIds})` → `removeOrder` | `stale` |
| **(a)** | status `holding` & TP1 `getLimitOrder` reports `filled` | bank the half (`partialPnlSol`), move `runnerStop` to breakeven, keep `holding` (runner continues) | `tp1_filled` |
| **stop** | status `holding`, pre-TP1, & breakdown (`price ≤ runnerStop` or `detectBreakdown`) | cancel resting TP1 → `marketExit` (swap full held → SOL) → `closeOrder(reason:"stop")` → `setCooldown(token)` | `stop` |
| **runner** | status `holding`, post-TP1, & `advanceRunner` (or breakdown) signals exit | `marketExit` the runner half → `closeOrder(reason:"runner_breakeven"`/`"runner_trail")` | `runner_exit` |

The stop branch is checked before the runner-advance path (stop-before-target). `isFilled()` accepts **only** `status === "filled"` (a fully-`Fulfilled` `LimitOrderStatus`); `isPartial()` is `status === "partial"`. Fill detection is via the real SDK enum (see `meteora/limit-orders.js getLimitOrder` + `docs/sdk-notes.md`); the live on-chain path itself is pending the smoke test (⚠️ Known Gaps).

---

## Config (`config.orion`)

`config.js` builds `config.orion` from defaults overridden by `orion-config.json` (read once at startup; the loader looks for the top-level `orion` key inside that file). Keys + defaults read from `config.js`:

| Key | Default | Meaning |
|-----|---------|---------|
| ohlcvTimeframe | `"1h"` | Meteora OHLCV interval |
| candles | `200` | History depth fetched |
| supertrendPeriod | `10` | SuperTrend ATR period |
| supertrendMultiplier | `3` | SuperTrend ATR multiplier |
| bbPeriod | `20` | Bollinger period |
| bbStdDev | `2` | Bollinger stddev multiplier |
| pullbackToSupportPct | `0.03` | Arm a buy when close is within 3% above SuperTrend support |
| targetRMultiple | `2.0` | Fallback target = entry + R×(entry−stop) when no swing resistance |
| stopLossPct | `0.10` | stopPrice = entry×(1−0.10); breakdown stop trigger |
| orderSizeSol | `0.2` | Floor order size (SOL) |
| orderSizePct | `0.25` | Fraction of deployable SOL per order |
| maxOrderSizeSol | `0.01` | Hard per-order SOL cap; clamps `computeOrderSize` (cap wins even if below the `orderSizeSol` floor) |
| maxTotalExposureSol | `0.03` | Max summed SOL across open/holding orders; scan skips placement that would exceed it |
| maxConcurrentOrders | `3` | Max simultaneously open orders |
| gasReserve | `0.05` | SOL held back for fees |
| staleBuyHours | `12` | Cancel an unfilled buy after N hours |
| cooldownHoursAfterStop | `6` | Per-token cooldown after a stop-loss |
| scanIntervalMin | `30` | Scan cron interval (minutes) |
| manageIntervalMin | `5` | Manage cron interval (minutes) |

**Overriding:** create `orion-config.json` (gitignored) shaped as `{ "orion": { ...overrides } }`. Any key omitted falls back to the default above. On the VPS, edit this file directly. Note Orion's `risk.js` is **pure** and takes `cfg.orion` as a parameter — it does not import `config.js`.

`config.js` also still carries Meridian's full LP config (risk/screening/gmgn/management/etc.) — left in place intentionally (YAGNI); Orion only reads `config.orion`, `config.tokens`, `config.screening` (via the copied `screening.js`), and `config.api`.

---

## Telegram Commands

Handled directly in `index.js` (`handleTelegramMessage`, bypass any LLM):

| Command | Action |
|---------|--------|
| `/orders` | List open orders: `n. token [status] entry … | tgt … | stop … | age …` |
| `/status` | Wallet SOL + open-order count + DRY_RUN + scan/manage intervals |
| `/cancel <n>` | Cancel the nth open order (`cancelLimitOrder` + `closeOrder` reason `"manual"`) |

Telegram only activates if `telegram.isEnabled()` (a `TELEGRAM_BOT_TOKEN` is configured).

### stdin REPL (local manual use)

`startRepl()` in `index.js` reads lines from stdin:

| Input | Action |
|-------|--------|
| `scan` | run one scan cycle |
| `manage` | run one manage cycle |
| `orders` | print open orders |
| `quit` / `exit` | graceful shutdown |

---

## State (`orion-state.json`, gitignored)

JSON store written atomically (write `.tmp` then rename; load tolerates missing/corrupt file → empty state). `state.js` exports both a `createStore(filePath)` factory (tests pass a temp path) and default-path convenience functions bound to `./orion-state.json`.

```
{ "orders": [ ...orderRecords ], "cooldowns": { "<token>": untilMs } }
```

Order record shape:
```
{
  id, token, pool, side,
  entryPrice, stopPrice, targetPrice, sizeSol,
  binId,           // number | null — placed buy bin id (cancel without refetch)
  status,          // "open" | "holding" | "closed"
  createdAt, filledAt,
  partialEntry,    // boolean — buy partially filled; remainder cancelled, sizeSol = filled cost basis
  tp1OrderId,      // string | null — TP1 (half) limit-sell order id
  tp1BinId,        // number | null — TP1 sell bin id (cancel without refetch)
  tp1Filled, runnerStop, highWater, runnerTrailing, partialPnlSol,  // scale-out/runner state
  closedReason,    // null | "stop" | "runner_breakeven" | "runner_trail" | "stale" | "manual"
  realizedPnlSol   // number | null
}
```

Cooldowns are keyed **by token** (not pool). `getOpenOrders()` returns everything not `closed`.

---

## Running It

**Dependencies — ⚠️ TLS cert blocker.** `npm install` currently fails in this environment with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` (TLS cert-chain interception). Fixes:
- `npm config set cafile <corp-root-ca.pem>`, OR run install on a network without TLS interception, then `npm install`.
- Last resort (not recommended, document if used): `npm install --strict-ssl=false`.

Also note Meridian pins `@meteora-ag/dlmm@1.9.4`; Orion needs **≥1.9.8** (the version that added `placeLimitOrder`), so Meridian's `node_modules` cannot be reused for that package.

**`.env`** (own wallet — see SEPARATE-WALLET RULE):
```
WALLET_PRIVATE_KEY=...   # base58, MUST differ from Meridian/Polaris
RPC_URL=https://mainnet.helius-rpc.com/?api-key=...
TELEGRAM_BOT_TOKEN=      # optional
TELEGRAM_CHAT_ID=        # optional
DRY_RUN=true
LIVE_TRADING=            # optional; must be "true" (with DRY_RUN=false) to arm live trading
```

**Going live requires BOTH `DRY_RUN=false` AND `LIVE_TRADING=true`** (two deliberate acts). The boot gate in `live-mode.js` forces dry-run and logs a warning if `DRY_RUN=false` but `LIVE_TRADING` is not `"true"` — so a half-set env can never trade. Before any **real-size** trading, run the manual mainnet smoke test in `docs/SMOKE-TEST.md` (one ~0.01 SOL round-trip on Orion's own wallet).

**Commands:**
- `DRY_RUN=true npm run dev` — boot in dry-run (no on-chain txs; limit-order/swap wrappers short-circuit and return `{dry_run:true,...}`).
- `npm test` — `node --test` (unit tests for indicators, setups, risk, state, ohlcv, version guard, scan/manage cycles).
- `npm run test:syntax` — runs `scripts/check-syntax.mjs`, a cross-platform (dependency-free) walker that `node --check`s every `.js` (skips `node_modules`/`.git`/dot-dirs). Replaces the old `find -exec` script that broke under npm-on-Windows.
- `npm run backtest <pool>` — walk-forward strategy simulator (`backtest.js`), replays historical OHLCV through `detectEntry`/`detectBreakdown`. Unit-tested in `backtest.test.js`; the CLI fetches live candles (needs network + deps).
- PM2: `pm2 start ecosystem.config.cjs` (process name `orion`), `npm run pm2:restart`, `npm run pm2:logs`.

**Degraded boot:** at startup `index.js checkLimitOrderSdk()` reads `@meteora-ag/dlmm/package.json`. If the SDK is **absent** → warn and keep booting in observe mode (limit orders disabled). If **installed but < 1.9.8** → hard `process.exit(1)`. If `WALLET_PRIVATE_KEY` is unset and not DRY_RUN → exit 1.

---

## ⚠️ Known Gaps / TODO Before Live Trading

These MUST be resolved before risking real funds:

1. **SDK surface wired + unit-tested; live path NOT yet verified.** `meteora/limit-orders.js` has been **rewritten against the real `@meteora-ag/dlmm@1.9.10` instance-method surface** (`DLMM.create` → instance `placeLimitOrder` / `getLimitOrder` / `cancelLimitOrder`; fill detection via `getLimitOrderByUserAndLbPair` + amount-derived `LimitOrderStatus`; sign + send legacy `Transaction`s). The order id is the limit-order account pubkey that `state.addOrder` keys on, and `isFilled()` now requires the derived `"filled"` status. The surface is documented in `docs/sdk-notes.md` and covered by unit tests with an **injected fake DLMM**. **REMAINING:** the live on-chain path itself is still UNVERIFIED end-to-end and is gated behind `docs/SMOKE-TEST.md` — open items only verifiable live: floor/ceil bin direction (buy vs sell), the `DLMM` default-import interop shape, and tx confirm semantics.
2. ~~**Held-amount proxy.**~~ **RESOLVED.** The TP1 sell leg (Branch A) now sizes from the **real on-chain held base balance** (`getWalletTokenBalance`) × `scaleOutPct`, and the market-stop leg (Branch B) already sold the real held balance. Partial-buy entries cancel the unfilled remainder and recompute cost basis from `filledBaseAmount × entryPrice`.
3. **OHLCV verified, live boot not.** The OHLCV response shape is verified against a live response (2026-06-16), but a live `DRY_RUN=true node index.js` end-to-end boot was **not** run because deps were missing in-environment.
4. **VPS deploy is new infra.** Host / path / branch are TODO (see below).

---

## VPS Deployment

- **Process manager**: PM2, process name `orion` (`ecosystem.config.cjs`).
- **Path**: `/root/orion` (TODO — new infra, confirm on provisioning).
- **Host**: `root@TODO` (TODO — Orion must run on its own wallet; pick a host accordingly).
- **Branch**: `feature/orion-core` (TODO — confirm deploy branch).
- **Deploy workflow** (once host is provisioned): `git push` locally → `ssh root@<host> "cd /root/orion && git pull && npm install && pm2 restart orion"`.
- **Config**: `/root/orion/orion-config.json` (not in git, edit directly on VPS).
- **Logs**: `pm2 logs orion --lines 100 --nostream` (or `npm run pm2:logs`).
