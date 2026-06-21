/**
 * orders.js — Orion's scan + manage orchestration cycles.
 *
 * This is the most complex Orion module: it wires together TA setups, risk
 * sizing, the state store, OHLCV, and the Meteora limit-order / swap surfaces.
 * EVERYTHING that touches the network, chain, or wall clock is injected via a
 * `deps` object so the whole thing is testable with fakes (see orders.test.js).
 *
 * Two entry points:
 *   runScanCycle(deps)   — find new entries and place buy limit orders.
 *   runManageCycle(deps) — advance open/holding orders through their lifecycle.
 *
 * The production wiring (index.js) supplies the real collaborators; the
 * `*Defaults` factories below provide sane production defaults so callers can
 * omit anything they don't want to override.
 */

import { config } from "./config.js";
import * as state from "./state.js";
import { log } from "./logger.js";
import {
  detectEntryFromIndicators as realDetectEntryFromIndicators,
  detectBreakdownFromIndicators as realDetectBreakdownFromIndicators,
} from "./ta/relay-setups.js";
import { buildSignalSummary } from "./tools/chart-indicators.js";
import { computeOrderSize as realComputeOrderSize, canOpen as realCanOpen, isOnCooldown as realIsOnCooldown, cooldownUntil as realCooldownUntil } from "./risk.js";
import { advanceRunner } from "./ta/runner.js";

// NOTE: TA data now comes from PRECOMPUTED indicators on the Agent Meridian
// relay, keyed by token MINT (not pool). The relay returns ~180-266 candles of
// server-computed SuperTrend/Bollinger/RSI — enough for Bollinger(20)/
// SuperTrend(10), which the raw ~10-candle OHLCV feed could never satisfy. The
// local candle path (ta/setups.js + meteora/ohlcv.js) remains valid and is
// still used by backtest.js, but is no longer on the live scan/manage path.

// NOTE: the limit-order and wallet collaborators are imported LAZILY inside the
// default factories below. tools/wallet.js statically imports @solana/web3.js,
// and meteora/limit-orders.js dynamically imports @meteora-ag/dlmm; keeping
// these out of the top-level import graph means importing orders.js (and
// running tests with injected fakes) never requires those chain deps to be
// installed/resolved.

/**
 * Whether a getLimitOrder() result indicates the order has FULLY FILLED.
 *
 * Verified against @meteora-ag/dlmm@1.9.10 (see docs/sdk-notes.md): getLimitOrder
 * returns a derived `status` of "open" | "partial" | "filled". A fully-filled
 * order — and ONLY a fully-filled order — reports status === "filled".
 */
export function isFilled(orderStatus) {
  return String(orderStatus?.status ?? "").toLowerCase() === "filled";
}

/**
 * Whether a getLimitOrder() result indicates the order is PARTIALLY filled
 * (status === "partial"). For a BUY this means some base was acquired but SOL
 * still rests at the bin; the manage cycle finalizes the entry by cancelling
 * the remainder before placing the TP1 sell.
 */
export function isPartial(orderStatus) {
  return String(orderStatus?.status ?? "").toLowerCase() === "partial";
}

/**
 * Market-exit the held token back to SOL. swapToken's `amount` is in units of
 * input_mint (the TOKEN), so we sell the REAL on-chain held balance — not a SOL
 * figure. If nothing is held (0/null/unavailable), skip the swap (caller still
 * closes the order) and log a warning.
 */
async function marketExit(order, { getHeldBalance, swapToken, log, SOL_MINT, id }) {
  const heldAmount = await getHeldBalance(order.token);
  if (heldAmount && heldAmount > 0) {
    await swapToken({
      input_mint: order.token,
      output_mint: SOL_MINT,
      amount: heldAmount,
    });
  } else {
    log(
      "orion_stop_warn",
      `${order.token} market-exit but held balance is ${heldAmount} — skipping swap, closing anyway (order ${id})`,
    );
  }
}

// ─── Production default collaborators ───────────────────────────────

function scanDefaults() {
  return {
    store: state,
    // getCandidates wraps screening's getTopCandidates → minimal {pool, token}.
    getCandidates: async () => {
      const { getTopCandidates } = await import("./tools/screening.js");
      const res = await getTopCandidates();
      const arr = Array.isArray(res) ? res : res?.candidates ?? [];
      return arr
        .map((c) => ({
          pool: c.pool ?? c.pool_address,
          token: c.base?.mint ?? c.base_mint ?? c.token,
        }))
        .filter((c) => c.pool && c.token);
    },
    // Relay TA data fetch, keyed by token MINT. Lazily imports the relay
    // client so importing orders.js never requires chain/config deps in tests.
    fetchIndicators: async (mint) => {
      const { fetchChartIndicatorsForMint } = await import("./tools/chart-indicators.js");
      return fetchChartIndicatorsForMint(mint, { interval: config.orion.indicatorInterval });
    },
    detectEntryFromIndicators: realDetectEntryFromIndicators,
    computeOrderSize: realComputeOrderSize,
    canOpen: realCanOpen,
    isOnCooldown: realIsOnCooldown,
    // Lazy: only resolves meteora/limit-orders.js (which pulls @meteora-ag/dlmm)
    // when actually invoked in production.
    placeLimitOrder: async (args) => {
      const { placeLimitOrder } = await import("./meteora/limit-orders.js");
      return placeLimitOrder(args);
    },
    getWalletSol: async () => {
      const { getWalletBalances } = await import("./tools/wallet.js");
      return (await getWalletBalances()).sol;
    },
    notify: () => {},
    cfg: config,
    now: () => Date.now(),
  };
}

function manageDefaults() {
  return {
    store: state,
    // Relay TA data fetch, keyed by token MINT (see scanDefaults note).
    fetchIndicators: async (mint) => {
      const { fetchChartIndicatorsForMint } = await import("./tools/chart-indicators.js");
      return fetchChartIndicatorsForMint(mint, { interval: config.orion.indicatorInterval });
    },
    detectBreakdownFromIndicators: realDetectBreakdownFromIndicators,
    // Current price from a relay payload: the latest close from the normalized
    // signal summary. Injectable so tests can supply prices directly without
    // constructing full relay payloads.
    priceOf: (payload) => buildSignalSummary(payload).close,
    // Lazy chain-dep imports (see note at top of file).
    getLimitOrder: async (id, opts) => {
      const { getLimitOrder } = await import("./meteora/limit-orders.js");
      return getLimitOrder(id, opts);
    },
    placeLimitOrder: async (args) => {
      const { placeLimitOrder } = await import("./meteora/limit-orders.js");
      return placeLimitOrder(args);
    },
    cancelLimitOrder: async (id, opts) => {
      const { cancelLimitOrder } = await import("./meteora/limit-orders.js");
      return cancelLimitOrder(id, opts);
    },
    swapToken: async (args) => {
      const { swapToken } = await import("./tools/wallet.js");
      return swapToken(args);
    },
    // Real on-chain held balance for a token mint (UI amount). Lazy chain-dep
    // import (see note at top of file). getWalletTokenBalance returns an object
    // { mint, symbol, balance, decimals, accounts } — we read `.balance`, the
    // summed uiAmount across the wallet's token accounts.
    getHeldBalance: async (tokenMint) => {
      const { getWalletTokenBalance } = await import("./tools/wallet.js");
      const res = await getWalletTokenBalance(tokenMint);
      return res?.balance ?? 0;
    },
    // Token cooldown expiry helper (epoch ms) given now.
    setCooldownExpiry: (nowMs, cfg) => realCooldownUntil(nowMs, cfg.orion),
    notify: () => {},
    cfg: config,
    now: () => Date.now(),
  };
}

/**
 * Scan candidates and place buy limit orders for firing setups.
 *
 * @param {object} deps see scanDefaults() for shape/defaults.
 * @returns {Promise<{placed:number, reason?:string}>}
 */
export async function runScanCycle(deps = {}) {
  const {
    store,
    getCandidates,
    fetchIndicators,
    detectEntryFromIndicators,
    computeOrderSize,
    canOpen,
    isOnCooldown,
    placeLimitOrder,
    getWalletSol,
    notify,
    cfg,
    now,
  } = { ...scanDefaults(), ...deps };

  let openCount = store.getOpenOrders().length;
  if (!canOpen(openCount, cfg.orion)) {
    return { placed: 0, reason: "max orders" };
  }

  const candidates = (await getCandidates()) || [];
  let placed = 0;

  // Snapshot occupied pools/tokens once; refresh as we add within the loop.
  const occupiedPools = new Set();
  const occupiedTokens = new Set();
  for (const o of store.getOpenOrders()) {
    occupiedPools.add(o.pool);
    occupiedTokens.add(o.token);
  }

  for (const cand of candidates) {
    if (!canOpen(openCount, cfg.orion)) break;
    const { pool, token } = cand;
    if (!pool || !token) continue;

    // Per-token cooldown.
    if (isOnCooldown(token, now(), store.getCooldownMap(), cfg.orion)) continue;

    // Dedupe: skip if we already have an open/holding order for this pool/token.
    if (occupiedPools.has(pool) || occupiedTokens.has(token)) continue;

    // Per-iteration error isolation: a throwing collaborator (e.g. fetchOhlcv
    // after exhausting retries) must not abort the whole scan — skip this
    // candidate and move on.
    try {
      // Relay TA is keyed by MINT (token), not pool. Placement below still
      // uses the pool.
      const indicators = await fetchIndicators(token, cfg.orion.indicatorInterval);
      const setup = detectEntryFromIndicators(indicators, cfg.orion);
      if (!setup) continue;

      const size = computeOrderSize(await getWalletSol(), openCount, cfg.orion);
      if (!(size > 0)) continue;

      const res = await placeLimitOrder({
        pool,
        side: "buy",
        price: setup.entryPrice,
        amountSol: size,
      });
      if (!res || !res.id) continue;

      store.addOrder({
        id: res.id,
        token,
        pool,
        side: "buy",
        entryPrice: setup.entryPrice,
        stopPrice: setup.stopPrice,
        targetPrice: setup.targetPrice,
        sizeSol: size,
        status: "open",
        createdAt: now(),
        binId: res.binId ?? null,
      });
      notify(`Orion: placed buy ${token} @ ${setup.entryPrice} for ${size} SOL (${setup.reason})`);

      occupiedPools.add(pool);
      occupiedTokens.add(token);
      openCount += 1;
      placed += 1;
    } catch (err) {
      log("orion_scan_error", `candidate ${pool}/${token} failed: ${err?.message ?? err}`);
      continue;
    }
  }

  return { placed };
}

/**
 * Advance every open/holding order through its lifecycle. Handles the four
 * branches: buy filled, holding+breakdown (stop), sell filled (target), and
 * stale unfilled buy.
 *
 * @param {object} deps see manageDefaults() for shape/defaults.
 * @returns {Promise<{actions: Array<{id:string,type:string}>}>}
 */
export async function runManageCycle(deps = {}) {
  const {
    store,
    fetchIndicators,
    detectBreakdownFromIndicators,
    priceOf,
    getLimitOrder,
    placeLimitOrder,
    cancelLimitOrder,
    swapToken,
    getHeldBalance,
    setCooldownExpiry,
    notify,
    cfg,
    now,
  } = { ...manageDefaults(), ...deps };

  const SOL_MINT = cfg.tokens?.SOL ?? "So11111111111111111111111111111111111111112";
  const staleMs = (cfg.orion.staleBuyHours ?? 12) * 3600_000;
  const actions = [];

  for (let order of store.getOpenOrders()) {
    const { id, status } = order;

    // Per-iteration error isolation: a throwing collaborator on ONE order
    // (e.g. fetchOhlcv after exhausting retries) must not abort the cycle and
    // starve other orders — a holding order with a pending stop-loss in
    // particular must still get processed.
    try {
    if (status === "open") {
      // Branch A: buy filled (fully OR partially) → finalize the entry, place the
      // TP1 (HALF) sell leg at target sized from REAL held base, arm the runner
      // (other half) at the original hard stop, go holding.
      const buyState = await getLimitOrder(id, { pool: order.pool, side: "buy" });
      if (isFilled(buyState) || isPartial(buyState)) {
        const partial = isPartial(buyState);
        // A partial buy leaves unfilled SOL resting at the bin — cancel the
        // remainder first so the entry is finalized (reclaims the resting SOL)
        // before we size and place the sell.
        if (partial) {
          await cancelLimitOrder(id, {
            pool: order.pool,
            binIds: order.binId != null ? [order.binId] : undefined,
          });
        }

        store.markFilled(id, now());

        // Size TP1 (half) from the REAL on-chain held base balance.
        const heldBase = await getHeldBalance(order.token);
        const tp1Base = heldBase * cfg.orion.scaleOutPct;
        const tp1Res = await placeLimitOrder({
          pool: order.pool,
          side: "sell",
          price: order.targetPrice,
          baseAmount: tp1Base,
        });

        const patch = {
          tp1OrderId: tp1Res?.id ?? null,
          tp1BinId: tp1Res?.binId ?? null,
          tp1Filled: false,
          runnerStop: order.stopPrice, // original hard stop
          highWater: order.entryPrice,
          runnerTrailing: false,
        };
        if (partial) {
          patch.partialEntry = true;
          // Recompute cost basis from the actually-filled base × entry price.
          patch.sizeSol =
            Number.isFinite(buyState.filledBaseAmount) && order.entryPrice > 0
              ? buyState.filledBaseAmount * order.entryPrice
              : order.sizeSol;
        }
        store.updateOrder(id, patch);
        notify(
          `Orion: ${order.token} buy ${partial ? "PARTIAL entry" : "filled"} — TP1 (half) placed @ ${order.targetPrice}`,
        );
        actions.push({ id, type: "tp1_placed" });
        continue;
      }

      // Branch D: stale unfilled buy → cancel and forget.
      if (now() - order.createdAt > staleMs) {
        await cancelLimitOrder(id, {
          pool: order.pool,
          binIds: order.binId != null ? [order.binId] : undefined,
        });
        store.removeOrder(id);
        notify(`Orion: cancelled stale buy ${order.token} (unfilled > ${cfg.orion.staleBuyHours}h)`);
        actions.push({ id, type: "stale" });
        continue;
      }

      continue; // still open, not filled, not stale → nothing to do
    }

    if (status === "holding") {
      // Relay TA is keyed by the token MINT (order.token), not the pool.
      const indicators = await fetchIndicators(order.token, cfg.orion.indicatorInterval);
      const { scaleOutPct } = cfg.orion;

      // Current price = latest close from the relay summary. Live trails on the
      // single relay CLOSE — the SAME price advanceRunner uses, so the backtest
      // (which now also feeds bar close) matches live runner semantics.
      const price = priceOf(indicators);

      // Branch (a): TP1 (half) limit filled → bank the partial, move the
      // runner stop to breakeven, keep holding (runner continues). We still
      // ratchet the high-water mark on this cycle so the runner doesn't lose
      // the bar's high after banking.
      if (!order.tp1Filled && order.tp1OrderId) {
        const tp1State = await getLimitOrder(order.tp1OrderId, { pool: order.pool, side: "sell" });
        if (isFilled(tp1State)) {
          const partial =
            Number.isFinite(order.entryPrice) &&
            Number.isFinite(order.targetPrice) &&
            order.entryPrice > 0
              ? order.sizeSol * scaleOutPct * ((order.targetPrice - order.entryPrice) / order.entryPrice)
              : 0;
          const prevHigh = Number.isFinite(order.highWater) ? order.highWater : order.entryPrice;
          const highWater = Number.isFinite(price) && price > prevHigh ? price : prevHigh;
          order = store.updateOrder(id, {
            tp1Filled: true,
            runnerStop: order.entryPrice, // breakeven
            highWater,
            partialPnlSol: partial,
          });
          notify(`Orion: TP1 ${order.token} — half sold @ ${order.targetPrice}, runner to breakeven`);
          actions.push({ id, type: "tp1_filled" });
          continue; // one transition per cycle
        }
      }

      if (!order.tp1Filled) {
        // ── Pre-TP1 path: the runner is NOT armed yet; exit is governed by the
        // original hard stop plus indicator breakdown (a real intrabar concern
        // that detectBreakdown encodes). advanceRunner is NOT used here. ──
        const prevHigh = Number.isFinite(order.highWater) ? order.highWater : order.entryPrice;
        const highWater = Number.isFinite(price) && price > prevHigh ? price : prevHigh;
        if (highWater !== order.highWater) order = store.updateOrder(id, { highWater });

        const runnerStop = Number.isFinite(order.runnerStop) ? order.runnerStop : order.stopPrice;
        const breakdown =
          (Number.isFinite(price) && price <= runnerStop) ||
          detectBreakdownFromIndicators(
            indicators,
            { entryPrice: order.entryPrice, stopPrice: runnerStop },
            cfg.orion,
          ) === true;
        if (breakdown) {
          // Cancel the resting TP1 limit, market-sell the FULL position.
          if (order.tp1OrderId) {
            await cancelLimitOrder(order.tp1OrderId, {
              pool: order.pool,
              binIds: order.tp1BinId != null ? [order.tp1BinId] : undefined,
            });
          }
          await marketExit(order, { getHeldBalance, swapToken, log, SOL_MINT, id });
          // ⚠️ MODELED PnL: realizedPnlSol here is an ESTIMATE computed at the
          // STOP level, not the actual swap out-amount (unknowable in DRY). The
          // true realized SOL must come from the swapToken result once live.
          const realized =
            order.entryPrice > 0
              ? order.sizeSol * ((runnerStop - order.entryPrice) / order.entryPrice)
              : null;
          store.closeOrder(id, { reason: "stop", realizedPnlSol: realized });
          store.setCooldown(order.token, setCooldownExpiry(now(), cfg));
          notify(`Orion: STOP ${order.token} — breakdown before TP1, market-exited`);
          actions.push({ id, type: "stop" });
          continue;
        }
        continue; // pre-TP1, no stop → hold
      }

      // ── Post-TP1 runner path: delegate the high-water / arm / trail / exit
      // decision to the SHARED advanceRunner (ta/runner.js) — the SAME pure
      // function the backtest uses, so the two engines cannot drift. ──
      const adv = advanceRunner(
        {
          entryPrice: order.entryPrice,
          runnerStop: Number.isFinite(order.runnerStop) ? order.runnerStop : order.entryPrice,
          highWater: order.highWater,
          runnerTrailing: order.runnerTrailing,
        },
        price,
        cfg.orion,
      );
      // Persist the runner state transition, keeping the in-memory order fresh.
      order = store.updateOrder(id, {
        highWater: adv.highWater,
        runnerTrailing: adv.runnerTrailing,
        runnerStop: adv.runnerStop,
      });

      // Indicator breakdown can still force the runner out independent of price.
      const exit =
        adv.exit ||
        detectBreakdownFromIndicators(
          indicators,
          { entryPrice: order.entryPrice, stopPrice: adv.runnerStop },
          cfg.orion,
        ) === true;
      if (exit) {
        // Post-TP1 (runner only): market-sell the runner half.
        await marketExit(order, { getHeldBalance, swapToken, log, SOL_MINT, id });
        const partial = Number.isFinite(order.partialPnlSol) ? order.partialPnlSol : 0;
        // ⚠️ MODELED PnL: the runner leg's realizedPnlSol is an ESTIMATE at the
        // runnerStop level, not the actual swap out-amount (unknowable in DRY).
        // The true realized SOL must come from the swapToken result once live.
        const runnerPnl =
          order.entryPrice > 0
            ? order.sizeSol * (1 - scaleOutPct) * ((adv.runnerStop - order.entryPrice) / order.entryPrice)
            : 0;
        const reason = adv.runnerStop === order.entryPrice ? "runner_breakeven" : "runner_trail";
        store.closeOrder(id, { reason, realizedPnlSol: partial + runnerPnl });
        store.setCooldown(order.token, setCooldownExpiry(now(), cfg));
        notify(`Orion: ${reason.toUpperCase()} ${order.token} — runner market-exited`);
        actions.push({ id, type: "runner_exit" });
        continue;
      }

      continue; // holding, no transition this cycle → hold
    }
    } catch (err) {
      log("orion_manage_error", `order ${id} failed: ${err?.message ?? err}`);
      continue;
    }
  }

  return { actions };
}
