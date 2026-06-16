# Orion — Meteora Limit-Order TA Agent (Design)

**Date:** 2026-06-16
**Status:** Approved (design phase)
**Folder:** `D:\aiproject\orion` — own git repo, own wallet, own `.env`

## Fleet context

Three autonomous Solana agents sharing Meridian's architecture lineage:

| Agent | Product | Role |
|-------|---------|------|
| Meridian | Meteora DLMM LP | LP — quick |
| Polaris | Meteora DLMM LP | LP — overnight |
| **Orion** | **Meteora limit orders** | **Limit-order TA sniper** |

## Concept

Orion auto-screens liquid Meteora DLMM pools, runs **deterministic technical
analysis** on their OHLCV, and when a setup triggers it places a **Meteora
single-bin limit buy** at support. On fill it places a **limit sell at target**
and arms a **market stop-loss** (Jupiter swap) for breakdowns.

It is a directional order bot, NOT an LP bot — fundamentally different core logic
from Meridian/Polaris.

## Meteora limit orders — confirmed facts (researched 2026-06-16)

- Launched on DLMM **May 20, 2026**.
- Exposed via `@meteora-ag/dlmm` SDK **v1.9.8+**: `placeLimitOrder`,
  `getLimitOrder`, `cancelLimitOrder`.
- A limit order = liquidity deposited into a target **bin**; when market price
  crosses it, incoming swaps **fill it automatically on-chain** — no keeper/crank.
- **Maker earns 50% of swap fees** on fill.
- Two order types: **single-bin** (one exact price) and **50-bin range** (DCA-like).
- Fillable by any Solana router (Jupiter, Titan, …).

Sources:
- https://ourcryptotalk.com/news/meteora-launches-limit-orders-solana-dlmm
- https://solana.com/news/solana-ecosystem-roundup-may-2026

## Decisions (from brainstorming)

1. **Name:** Orion (continues Meridian/Polaris navigation theme; "the hunter").
2. **Mechanism:** Meteora DLMM single-bin limit orders (SDK v1.9.8+).
3. **Decision logic:** Pure deterministic TA — no LLM. SuperTrend(10,3) +
   Bollinger Bands(20,2) + swing support/resistance.
4. **Architecture:** Reuse Meridian's proven infra; write a brand-new TA engine
   and order-lifecycle core. Own folder + wallet.
5. **Token universe:** Auto-screen Meteora pools (Meridian-style liquidity filters),
   then run TA on the results.
6. **Exit:** Limit SELL at target + **market stop-loss via Jupiter** on breakdown.

## Architecture

### Reused from Meridian (copied, lightly adapted)
- `config.js` (→ `orion-config.json`)
- `logger.js`
- `telegram.js`
- `wallet.js` (SOL/token balances + Jupiter swap — also used for stop-loss exits)
- pool discovery / `screening.js`
- OHLCV fetch (Meteora pool price/volume history)

### New core (built from scratch)
- `ta/indicators.js` — SuperTrend(10,3), Bollinger Bands(20,2), ATR, swing
  support/resistance. Pure functions, unit-tested.
- `ta/setups.js` — combines indicators into a trigger (e.g. *SuperTrend bullish
  AND price pulled back to support / lower band*).
- `meteora/limit-orders.js` — wraps `@meteora-ag/dlmm` v1.9.8+
  (`placeLimitOrder` / `getLimitOrder` / `cancelLimitOrder`).
- `orders.js` + `state.js` — order/position lifecycle registry (`orion-state.json`).
- `risk.js` — position sizing, max concurrent orders, stop-loss math, per-token cooldown.
- `index.js` — cron orchestration + Telegram + REPL.

## Data flow / lifecycle

1. **Scan cron** (~30m): screen pools → fetch OHLCV → compute indicators →
   detect setup → **place single-bin limit buy** at support bin
   (size = % of wallet). Track order.
2. **Manage cron** (~5m): poll `getLimitOrder`:
   - Buy **filled** → place **limit sell** at target (prior high / R-multiple).
   - Holding + **breakdown** (SuperTrend flips red, or price < entry·(1−stopLossPct))
     → cancel sell, **market-sell via Jupiter**, record loss.
   - Sell **filled** → realize PnL, record.
   - **Stale** unfilled buy (price ran away) → cancel after N hours.

## Error handling

- `DRY_RUN` mode skips all on-chain txs.
- **SDK version guard**: assert `@meteora-ag/dlmm` ≥ 1.9.8 at startup.
- RPC retries with backoff.
- Idempotent order tracking by on-chain order id.
- Pre-place safety checks: min liquidity, sufficient SOL + gas reserve, token not
  blacklisted.
- Per-token cooldown after a stop-loss to avoid re-entering a falling knife.

## Testing

- Unit tests for each indicator against known fixtures (deterministic TA is the
  big win here — fully testable).
- **Backtest harness**: replay historical OHLCV to validate setups before risking
  funds.
- Syntax checks on all modules.
- DRY_RUN end-to-end smoke test.

## Known blocker

- Orion requires `@meteora-ag/dlmm@1.9.8+`. Meridian pins `1.9.4`, so its
  `node_modules` **cannot** be reused for that package.
- `npm install` currently fails in this environment with
  `UNABLE_TO_VERIFY_LEAF_SIGNATURE` (TLS cert chain issue).
- Therefore: code + scaffold can be written now, but **making Orion runnable
  requires fixing npm's cert config** (`npm config set cafile …`) or installing
  the package from a working network.

## Safety

- Separate wallet from Meridian (`BeEGreU2…`) and Polaris. Own `.env`.
- Single-side SOL entries; gas reserve enforced.
