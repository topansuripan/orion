# Orion Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build Orion — an autonomous agent that auto-screens liquid Meteora DLMM pools, runs deterministic technical analysis on their OHLCV, places Meteora single-bin limit BUY orders at support, and on fill places a limit SELL at target plus a Jupiter market stop-loss on breakdown.

**Architecture:** Reuse Meridian's proven infra (config loader, logger, Telegram, wallet/Jupiter swap, pool screening) copied into `D:\aiproject\orion`. Build a brand-new, fully unit-tested TA core (`ta/`), a Meteora limit-order wrapper (`meteora/`), an order/position lifecycle registry (`state.js` + `orders.js`), and cron orchestration (`index.js`). No LLM in the decision path.

**Tech Stack:** Node.js (ESM, `"type": "module"`), `@meteora-ag/dlmm@^1.9.8` (limit-order SDK), `@solana/web3.js`, `node-cron`, Jupiter swap API, Meteora OHLCV API (`https://dlmm.datapi.meteora.ag`). Tests: Node's built-in `node:test` + `node:assert`.

**Reference design:** `docs/plans/2026-06-16-orion-design.md`

**Source to copy from:** `D:\aiproject\meridian` (sibling). Key reusable exports already verified:
- `tools/wallet.js` → `getWalletBalances()`, `getWalletTokenBalance(mint)`, `swapToken({input_mint, output_mint, amount})`, `normalizeMint(mint)`
- `tools/screening.js` → `discoverPools({...})`, `getTopCandidates({...})`, `getPoolDetail({pool_address, timeframe})`
- `config.js` → `export const config`, loader pattern from `user-config.json`
- `logger.js` → `log(category, message)`, `logAction(action)`
- `telegram.js` → `sendMessage`, `sendHTML`, `startPolling(onMessage)`, etc.
- `tools/chart-indicators.js` → **reference only** for setup-rule logic (`evaluatePreset`, `buildSignalSummary`). Orion computes indicators locally instead of via relay.

---

## Phase 0 — Project scaffold

### Task 0.1: Base files

**Files:**
- Create: `D:\aiproject\orion\package.json`
- Create: `D:\aiproject\orion\.gitignore`
- Create: `D:\aiproject\orion\.env.example`
- Create: `D:\aiproject\orion\README.md`

**Step 1:** Create `package.json`:

```json
{
  "name": "orion-agent",
  "version": "1.0.0",
  "type": "module",
  "description": "Autonomous Meteora limit-order TA agent on Solana",
  "main": "index.js",
  "bin": { "orion": "index.js" },
  "scripts": {
    "start": "node index.js",
    "dev": "DRY_RUN=true node index.js",
    "test": "node --test",
    "test:syntax": "find . -path ./node_modules -prune -o -name '*.js' -exec node --check {} \\;",
    "backtest": "node backtest.js",
    "pm2:start": "pm2 start ecosystem.config.cjs",
    "pm2:restart": "pm2 restart orion --update-env",
    "pm2:logs": "pm2 logs orion --lines 100"
  },
  "dependencies": {
    "@meteora-ag/dlmm": "^1.9.8",
    "@solana/spl-token": "^0.3.11",
    "@solana/web3.js": "^1.95.0",
    "bn.js": "^5.2.1",
    "bs58": "^5.0.0",
    "dotenv": "^17.3.1",
    "node-cron": "^3.0.3"
  },
  "engines": { "node": ">=18.0.0" }
}
```

**Step 2:** Create `.gitignore` (mirror Meridian's, renamed state file):

```
node_modules/
.env
.env.*
!.env.example
orion-config.json
orion-state.json
logs/
.DS_Store
docs/   # keep? see note below
```

> NOTE: Meridian gitignores `docs/`. Orion should NOT gitignore `docs/plans/` (we want the design + plan in git). Use `logs/` and state/secret ignores only; remove the `docs/` line.

**Step 3:** Create `.env.example`:

```
# ⚠️ ORION: use a wallet DIFFERENT from Meridian (BeEGreU2nwr8bXmrsi1Tf8ALZbVWP9VomfeaEMDLmSYg)
# and Polaris. A shared wallet makes the agents collide on the same funds.
WALLET_PRIVATE_KEY=your_base58_private_key_here
RPC_URL=https://mainnet.helius-rpc.com/?api-key=your_helius_api_key_here
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
DRY_RUN=true
```

**Step 4:** Create a short `README.md` describing Orion's role (limit-order TA sniper) and the ⚠️ npm/SDK caveat (see Task 0.4).

**Step 5: Commit**

```bash
git add package.json .gitignore .env.example README.md
git commit -m "chore: scaffold Orion project base files"
```

### Task 0.2: Copy reusable infra modules from Meridian

**Files (copy from `D:\aiproject\meridian` → `D:\aiproject\orion`):**
- `config.js`, `logger.js`, `telegram.js`
- `tools/wallet.js`, `tools/screening.js`, and their internal deps:
  `tools/agent-meridian.js`, `utils/number.js`, plus anything `wallet.js`/`screening.js` import (resolve transitively).

**Step 1:** Copy the files, preserving the `tools/` and `utils/` layout.

**Step 2:** Resolve imports — run `node --check` on each copied file and follow any missing-module errors; copy each missing dependency until all imports resolve. Do NOT copy LP-specific modules (`state.js`, `lessons.js`, `pool-memory.js`, `dlmm.js`, `executor.js`, `definitions.js`) — Orion writes its own.

**Step 3:** Trim `config.js` — keep the loader mechanism and shared keys (rpc, wallet, tokens, telegram, screening filters). Add an `orion` section (see Task 0.3). It's fine to leave unused LP keys for now (YAGNI: don't aggressively prune working config).

**Step 4: Commit**

```bash
git add config.js logger.js telegram.js tools/ utils/
git commit -m "chore: copy reusable infra from Meridian (config, logger, telegram, wallet, screening)"
```

### Task 0.3: Orion config section

**Files:**
- Modify: `config.js` (add `orion` config block + `orion-config.json` loading)
- Create: `orion-config.example.json`

**Step 1:** Add to the config object an `orion` section with defaults:

```js
orion: {
  // TA
  ohlcvTimeframe: "1h",         // Meteora OHLCV interval
  candles: 200,                 // history depth
  supertrendPeriod: 10,
  supertrendMultiplier: 3,
  bbPeriod: 20,
  bbStdDev: 2,
  // entry/exit rules
  pullbackToSupportPct: 0.03,   // price within 3% of SuperTrend/support to arm a buy
  targetRMultiple: 2.0,         // sell target = entry + R*(entry-stop) ... or prior-high (see setups.js)
  stopLossPct: 0.10,            // market stop-loss if price < entry*(1-stopLossPct)
  // sizing & limits
  orderSizeSol: 0.2,
  orderSizePct: 0.25,           // % of deployable SOL, like Meridian computeDeployAmount
  maxConcurrentOrders: 3,
  gasReserve: 0.05,
  staleBuyHours: 12,            // cancel unfilled buy after N hours
  cooldownHoursAfterStop: 6,    // per-token cooldown after a stop-loss
  // schedule
  scanIntervalMin: 30,
  manageIntervalMin: 5,
},
```

**Step 2:** Create `orion-config.example.json` mirroring the above so users can override on the VPS.

**Step 3: Commit** `git commit -am "feat: add orion config section + example"`

### Task 0.4: Dependencies (⚠️ known blocker)

**Step 1:** `cd D:\aiproject\orion && npm install`

**Expected problem:** In the current environment npm fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` (TLS cert chain). Also Meridian's `node_modules` cannot be reused wholesale because it pins `@meteora-ag/dlmm@1.9.4` and Orion needs `>=1.9.8` (the version that added `placeLimitOrder`).

**Resolution options (pick one before proceeding past Phase 1):**
1. Fix npm cert config: `npm config set cafile <corp-root-ca.pem>` (or run install on a network without TLS interception), then `npm install`.
2. Temporary/last resort: `npm install --strict-ssl=false` (NOT recommended; document if used).

**Step 2:** Verify the limit-order API exists in the installed SDK:

```bash
node -e "import('@meteora-ag/dlmm').then(m=>{const d=m.default||m; console.log('placeLimitOrder' in (d.prototype||{}) || Object.keys(d))})"
```
Expected: confirms `placeLimitOrder` / `getLimitOrder` / `cancelLimitOrder` are available. If the names differ in the real SDK, **stop and reconcile** `meteora/limit-orders.js` (Phase 5) with the actual surface before continuing.

**Step 3: Commit** the `package-lock.json` once install succeeds.

---

## Phase 1 — OHLCV client

### Task 1.1: Confirm the real OHLCV response shape

**Step 1:** Pick any active Meteora pool address (e.g. from `discoverPools`) and fetch a sample:

```bash
curl -s "https://dlmm.datapi.meteora.ag/pools/<POOL>/ohlcv?timeframe=1h" | head -c 2000
```

**Step 2:** Record the exact field names for each candle (open/high/low/close/volume/time) in a comment at the top of `meteora/ohlcv.js`. The parser in Task 1.2 MUST match the real shape — do not assume.

### Task 1.2: OHLCV fetch + normalize

**Files:**
- Create: `meteora/ohlcv.js`
- Test: `meteora/ohlcv.test.js`

**Step 1: Write the failing test** (parser only — pure function, no network):

```js
import { test } from "node:test";
import assert from "node:assert";
import { normalizeCandles } from "./ohlcv.js";

test("normalizeCandles maps raw API rows to {t,o,h,l,c,v} numbers", () => {
  // Replace these keys with the REAL ones confirmed in Task 1.1
  const raw = [{ time: 1, open: "2", high: "4", low: "1", close: "3", volume: "10" }];
  const out = normalizeCandles(raw);
  assert.deepStrictEqual(out, [{ t: 1, o: 2, h: 4, l: 1, c: 3, v: 10 }]);
});
```

**Step 2: Run** `node --test meteora/ohlcv.test.js` → FAIL (module/function missing).

**Step 3: Implement** `normalizeCandles(rawRows)` (coerce strings→numbers, drop malformed rows) and `fetchOhlcv(poolAddress, {timeframe, candles})` (fetch + `normalizeCandles`, with retry/backoff). Keep network fetch out of the unit test.

**Step 4: Run** test → PASS.

**Step 5: Commit** `git commit -am "feat(ohlcv): fetch + normalize Meteora pool candles"`

---

## Phase 2 — TA indicators (pure, unit-tested core)

> All indicator functions take a normalized candle array `[{t,o,h,l,c,v}]` and return arrays aligned by index (null for warm-up periods). Pure, no I/O. These are the most important tests in the project.

### Task 2.1: ATR (needed by SuperTrend)

**Files:** Create `ta/indicators.js`; Test `ta/indicators.test.js`

**Step 1: Failing test** — assert `atr(candles, period)` matches a hand-computed value on a small fixture (Wilder's smoothing). Include the fixture inline.

**Step 2: Run** → FAIL.

**Step 3: Implement** `atr(candles, period=14)` using True Range + Wilder smoothing.

**Step 4: Run** → PASS. **Step 5: Commit.**

### Task 2.2: Bollinger Bands

**Step 1: Failing test** — `bollinger(candles, {period:20, mult:2})` returns `{middle, upper, lower}` arrays; assert against hand-computed SMA + population stddev on a fixture.

**Step 2:** FAIL → **Step 3:** implement (SMA + stddev) → **Step 4:** PASS → **Step 5:** commit.

### Task 2.3: SuperTrend

**Step 1: Failing test** — `supertrend(candles, {period:10, mult:3})` returns array of `{value, direction}` where direction ∈ {"bullish","bearish"}; assert direction flips on a constructed up→down fixture and the band value matches the standard recursive formula.

**Step 2:** FAIL → **Step 3:** implement standard SuperTrend (basic upper/lower bands from `(h+l)/2 ± mult*ATR`, recursive final bands, direction flip rules) → **Step 4:** PASS → **Step 5:** commit.

> Reference for expected semantics: Meridian's `chart-indicators.js` `buildSignalSummary` uses `supertrend.direction` "bullish"/"bearish" and `states.supertrendBreakUp/Down`. Match that vocabulary so setup rules read the same.

### Task 2.4: Swing support/resistance

**Step 1: Failing test** — `swingLevels(candles, {lookback:5})` returns `{support, resistance}` = most recent pivot low / pivot high (a low with `lookback` higher lows on each side, etc.). Assert on a fixture with a clear pivot.

**Step 2:** FAIL → **Step 3:** implement pivot detection → **Step 4:** PASS → **Step 5:** commit.

---

## Phase 3 — Setup detector

### Task 3.1: Entry setup

**Files:** Create `ta/setups.js`; Test `ta/setups.test.js`

**Step 1: Failing test** — `detectEntry(candles, cfg)` returns `null` when no setup, or `{ entryPrice, stopPrice, targetPrice, reason }` when the rule fires. Rule (from approved design + Meridian `supertrend_break`/`bollinger_reversion` reference):
> SuperTrend is **bullish** AND latest close is within `pullbackToSupportPct` of SuperTrend value OR ≤ lower Bollinger band.
- `entryPrice` = support (SuperTrend value or recent swing support).
- `stopPrice` = `entryPrice * (1 - stopLossPct)`.
- `targetPrice` = recent swing resistance (prior high); fallback `entryPrice + targetRMultiple*(entryPrice-stopPrice)`.

Build two fixtures: one that fires, one that doesn't (bearish SuperTrend).

**Step 2:** FAIL → **Step 3:** implement `detectEntry` composing the Phase 2 indicators → **Step 4:** PASS → **Step 5:** commit.

### Task 3.2: Breakdown (stop) detector

**Step 1: Failing test** — `detectBreakdown(candles, position, cfg)` returns `true` when SuperTrend flips bearish OR latest close < `position.stopPrice`. Fixtures for both branches + a no-trigger case.

**Step 2:** FAIL → **Step 3:** implement → **Step 4:** PASS → **Step 5:** commit.

---

## Phase 4 — Risk module

### Task 4.1: Sizing, limits, cooldown

**Files:** Create `risk.js`; Test `risk.test.js`

**Step 1: Failing tests:**
- `computeOrderSize(walletSol, openOrders, cfg)` → `clamp(deployable*orderSizePct, floor=orderSizeSol, ceil=…)`, returns 0 if `walletSol - gasReserve < orderSizeSol`. (Mirror Meridian `computeDeployAmount`.)
- `canOpen(openOrders, cfg)` → false when `openOrders >= maxConcurrentOrders`.
- `isOnCooldown(token, now, cooldownMap, cfg)` → true within `cooldownHoursAfterStop`.

**Step 2:** FAIL → **Step 3:** implement pure functions → **Step 4:** PASS → **Step 5:** commit.

---

## Phase 5 — Meteora limit-order wrapper

### Task 5.1: SDK version guard

**Files:** Create `meteora/limit-orders.js`; Test `meteora/version.test.js`

**Step 1: Failing test** — `assertSdkSupportsLimitOrders(version)` throws for `"1.9.4"`, passes for `"1.9.8"`/`"1.10.0"` (semver compare ≥1.9.8).

**Step 2:** FAIL → **Step 3:** implement semver check; call it at module load using the installed SDK version → **Step 4:** PASS → **Step 5:** commit.

### Task 5.2: Place / get / cancel wrappers (DRY_RUN-aware)

**Files:** Modify `meteora/limit-orders.js`; Test `meteora/limit-orders.dryrun.test.js`

**Step 1: Failing test** — with `DRY_RUN=true`, `placeLimitOrder({...})` returns `{dry_run:true, ...}` without touching the chain (mirror `wallet.js swapToken` DRY_RUN pattern). Same for `cancelLimitOrder`.

**Step 2:** FAIL → **Step 3:** implement thin wrappers over the real SDK (`placeLimitOrder`/`getLimitOrder`/`cancelLimitOrder`) using the surface confirmed in Task 0.4. Single-bin buy = limit order at target bin, side = buy (SOL→token); compute bin from price. Add DRY_RUN short-circuits and `log()` calls.

**Step 4:** PASS → **Step 5:** commit.

> If the SDK's actual method names/params differ from Task 0.4's confirmation, adapt here and note it in the file header. This is the one place coupled to the new SDK.

---

## Phase 6 — State registry

### Task 6.1: Order/position store

**Files:** Create `state.js`; Test `state.test.js` (use a temp file path / `orion-state.test.json`)

**Step 1: Failing tests** — `addOrder(o)`, `getOpenOrders()`, `updateOrder(id, patch)`, `markFilled(id)`, `removeOrder(id)`, `setCooldown(token, untilTs)`, `getCooldownMap()` persist to and reload from JSON. Order record shape: `{id, token, pool, side, entryPrice, stopPrice, targetPrice, sizeSol, status, createdAt, filledAt, sellOrderId}`.

**Step 2:** FAIL → **Step 3:** implement JSON-backed registry (load/save, atomic write) → **Step 4:** PASS → **Step 5:** commit.

---

## Phase 7 — Order lifecycle orchestration

### Task 7.1: Scan cycle

**Files:** Create `orders.js`; Test `orders.scan.test.js`

**Step 1: Failing test** — `runScanCycle({deps})` with injected fakes (fake `discoverPools`, fake `fetchOhlcv`, fake `detectEntry` returning a setup, fake `placeLimitOrder`, in-memory state): when `canOpen` and not on cooldown and a setup fires, it calls `placeLimitOrder` once and records the order. When `canOpen` is false, it places nothing.

> Use dependency injection (pass collaborators in) so the cycle is testable without network/chain.

**Step 2:** FAIL → **Step 3:** implement `runScanCycle` (screen → for each candidate: cooldown/limit checks → `fetchOhlcv` → `detectEntry` → `computeOrderSize` → `placeLimitOrder` → `addOrder` → Telegram notify) → **Step 4:** PASS → **Step 5:** commit.

### Task 7.2: Manage cycle

**Files:** Modify `orders.js`; Test `orders.manage.test.js`

**Step 1: Failing tests** (injected fakes) covering each branch:
- Buy order filled (per `getLimitOrder`) → places limit sell at `targetPrice`, updates order to `holding`, stores `sellOrderId`.
- Holding + `detectBreakdown` true → cancels sell order, `swapToken` token→SOL, marks closed (loss), sets cooldown.
- Sell filled → marks closed (win), records realized PnL.
- Unfilled buy older than `staleBuyHours` → `cancelLimitOrder`, removes order.

**Step 2:** FAIL → **Step 3:** implement `runManageCycle` handling all four branches → **Step 4:** PASS → **Step 5:** commit.

---

## Phase 8 — Entry point (cron + Telegram + REPL)

### Task 8.1: index.js wiring

**Files:** Create `index.js`, `ecosystem.config.cjs`

**Step 1:** `ecosystem.config.cjs` with PM2 process name `orion` (mirror Meridian's, renamed).

**Step 2:** `index.js`:
- Load config + `.env`; assert wallet present (or DRY_RUN).
- Call `assertSdkSupportsLimitOrders` at boot.
- `node-cron`: scan every `scanIntervalMin`, manage every `manageIntervalMin`. Add a `_scanLastTriggered` guard (mirror Meridian's `_screeningLastTriggered`) to prevent overlapping scans.
- Telegram `startPolling` with commands: `/orders` (list open orders + status), `/cancel <n>` (cancel by index), `/status` (wallet + open count). Bypass any LLM — pure command handlers.
- Minimal stdin REPL for local manual triggers (`scan`, `manage`, `orders`).

**Step 3: Verify** `node --check index.js` passes and `DRY_RUN=true node index.js` boots, runs one manage cycle, and exits cleanly on SIGINT (manual smoke).

**Step 4: Commit** `git commit -am "feat: orion entry point — cron orchestration, Telegram commands, REPL"`

---

## Phase 9 — Backtest harness

### Task 9.1: Replay historical OHLCV through the strategy

**Files:** Create `backtest.js`; Test `backtest.test.js`

**Step 1: Failing test** — `backtest(candles, cfg)` walks candles forward, applies `detectEntry`/`detectBreakdown`/target logic with a simulated fill model (buy fills when low ≤ entryPrice; sell fills when high ≥ targetPrice; stop when close < stopPrice), and returns `{trades, winRate, totalReturnPct}`. Assert on a constructed fixture with one known winning trade.

**Step 2:** FAIL → **Step 3:** implement the walk-forward simulator (reusing `ta/*` and `ta/setups.js`) → **Step 4:** PASS → **Step 5:** commit.

**Step 6:** Run `npm run backtest` against real fetched candles for 2–3 tokens; sanity-check output. (Manual, not a unit test.)

---

## Phase 10 — Docs, fleet wiring, final verification

### Task 10.1: CLAUDE.md

**Files:** Create `D:\aiproject\orion\CLAUDE.md`

Document: architecture, the TA pipeline, config keys (the `orion` section), order lifecycle, Telegram commands, the SDK ≥1.9.8 requirement, VPS deploy (PM2 process `orion`, own host/path/branch as TODO), and the ⚠️ separate-wallet rule.

### Task 10.2: Full verification (REQUIRED SUB-SKILL: superpowers:verification-before-completion)

**Step 1:** `npm test` — all unit tests pass. Capture output.
**Step 2:** `npm run test:syntax` — every file parses.
**Step 3:** `DRY_RUN=true node index.js` — boots, runs a scan + manage cycle against fakes/real data without sending a tx. Capture log.
**Step 4:** Confirm `orion-state.json`, `.env`, `orion-config.json` are gitignored and untracked.
**Step 5: Commit** any final fixes.

### Task 10.3: Finish the branch (REQUIRED SUB-SKILL: superpowers:finishing-a-development-branch)

---

## Out of scope (YAGNI — do NOT build now)

- 50-bin range orders (single-bin only for v1).
- LLM confirmation / vision.
- Lessons/threshold evolution.
- HiveMind sync.
- Manual watchlist (auto-screen only for v1).

## Open items to resolve during execution

1. **npm/SDK install** (Task 0.4) — blocker for anything touching the real chain; unit tests (Phases 1–4, 6, 9) run without it.
2. **Real OHLCV field names** (Task 1.1) — confirm before writing the parser.
3. **Real limit-order SDK surface** (Task 0.4 / Phase 5) — method names/params must be verified against `@meteora-ag/dlmm@1.9.8`; the docs say `placeLimitOrder`/`getLimitOrder`/`cancelLimitOrder` but confirm signatures.
