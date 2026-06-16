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
import { fetchOhlcv as realFetchOhlcv } from "./meteora/ohlcv.js";
import { detectEntry as realDetectEntry, detectBreakdown as realDetectBreakdown } from "./ta/setups.js";
import { computeOrderSize as realComputeOrderSize, canOpen as realCanOpen, isOnCooldown as realIsOnCooldown, cooldownUntil as realCooldownUntil } from "./risk.js";

// NOTE: the limit-order and wallet collaborators are imported LAZILY inside the
// default factories below. tools/wallet.js statically imports @solana/web3.js,
// and meteora/limit-orders.js dynamically imports @meteora-ag/dlmm; keeping
// these out of the top-level import graph means importing orders.js (and
// running tests with injected fakes) never requires those chain deps to be
// installed/resolved.

/**
 * Whether a getLimitOrder() result indicates the order has FILLED.
 *
 * ⚠️ UNVERIFIED SDK SURFACE — the real fill-detection field is not yet
 * confirmed against @meteora-ag/dlmm >=1.9.8 (Task 0.4). We accept the most
 * likely shapes defensively: status "filled"/"completed"/"closed", or a
 * boolean `filled`/`isFilled` flag. MUST be validated against the live SDK.
 */
function isFilled(orderStatus) {
  if (!orderStatus || typeof orderStatus !== "object") return false;
  if (orderStatus.filled === true || orderStatus.isFilled === true) return true;
  const s = String(orderStatus.status ?? "").toLowerCase();
  return s === "filled" || s === "completed" || s === "closed";
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
    fetchOhlcv: realFetchOhlcv,
    detectEntry: realDetectEntry,
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
    fetchOhlcv: realFetchOhlcv,
    detectBreakdown: realDetectBreakdown,
    // Lazy chain-dep imports (see note at top of file).
    getLimitOrder: async (id) => {
      const { getLimitOrder } = await import("./meteora/limit-orders.js");
      return getLimitOrder(id);
    },
    placeLimitOrder: async (args) => {
      const { placeLimitOrder } = await import("./meteora/limit-orders.js");
      return placeLimitOrder(args);
    },
    cancelLimitOrder: async (id) => {
      const { cancelLimitOrder } = await import("./meteora/limit-orders.js");
      return cancelLimitOrder(id);
    },
    swapToken: async (args) => {
      const { swapToken } = await import("./tools/wallet.js");
      return swapToken(args);
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
    fetchOhlcv,
    detectEntry,
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

    const candles = await fetchOhlcv(pool, {
      timeframe: cfg.orion.ohlcvTimeframe,
      candles: cfg.orion.candles,
    });
    const setup = detectEntry(candles, cfg.orion);
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
    });
    notify(`Orion: placed buy ${token} @ ${setup.entryPrice} for ${size} SOL (${setup.reason})`);

    occupiedPools.add(pool);
    occupiedTokens.add(token);
    openCount += 1;
    placed += 1;
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
    fetchOhlcv,
    detectBreakdown,
    getLimitOrder,
    placeLimitOrder,
    cancelLimitOrder,
    swapToken,
    setCooldownExpiry,
    notify,
    cfg,
    now,
  } = { ...manageDefaults(), ...deps };

  const SOL_MINT = cfg.tokens?.SOL ?? "So11111111111111111111111111111111111111112";
  const staleMs = (cfg.orion.staleBuyHours ?? 12) * 3600_000;
  const actions = [];

  for (const order of store.getOpenOrders()) {
    const { id, status } = order;

    if (status === "open") {
      // Branch A: buy filled → place the sell (target) leg, go holding.
      const buyState = await getLimitOrder(id);
      if (isFilled(buyState)) {
        store.markFilled(id, now());
        const sellRes = await placeLimitOrder({
          pool: order.pool,
          side: "sell",
          price: order.targetPrice,
          amountSol: order.sizeSol, // ⚠️ held-amount proxy — see Task 0.4 note.
        });
        store.updateOrder(id, { sellOrderId: sellRes?.id ?? null });
        notify(`Orion: ${order.token} buy filled — sell placed @ ${order.targetPrice}`);
        actions.push({ id, type: "sell_placed" });
        continue;
      }

      // Branch D: stale unfilled buy → cancel and forget.
      if (now() - order.createdAt > staleMs) {
        await cancelLimitOrder(id);
        store.removeOrder(id);
        notify(`Orion: cancelled stale buy ${order.token} (unfilled > ${cfg.orion.staleBuyHours}h)`);
        actions.push({ id, type: "stale" });
        continue;
      }

      continue; // still open, not filled, not stale → nothing to do
    }

    if (status === "holding") {
      const candles = await fetchOhlcv(order.pool, {
        timeframe: cfg.orion.ohlcvTimeframe,
        candles: cfg.orion.candles,
      });

      // Branch B: breakdown → cancel sell leg, market-exit via swap, stop-close.
      const breakdown = detectBreakdown(
        candles,
        { entryPrice: order.entryPrice, stopPrice: order.stopPrice },
        cfg.orion,
      );
      if (breakdown) {
        if (order.sellOrderId) await cancelLimitOrder(order.sellOrderId);
        // Market-exit the held token back to SOL. We don't know the exact
        // on-chain held amount here (see concern), so sizeSol is a proxy.
        await swapToken({
          input_mint: order.token,
          output_mint: SOL_MINT,
          amount: order.sizeSol,
        });
        store.closeOrder(id, { reason: "stop", realizedPnlSol: null });
        store.setCooldown(order.token, setCooldownExpiry(now(), cfg));
        notify(`Orion: STOP ${order.token} — breakdown, market-exited`);
        actions.push({ id, type: "stop" });
        continue;
      }

      // Branch C: sell (target) limit filled → close as a win.
      if (order.sellOrderId) {
        const sellState = await getLimitOrder(order.sellOrderId);
        if (isFilled(sellState)) {
          // Approximate realized PnL from the price move on the placed size.
          const pnl =
            Number.isFinite(order.entryPrice) &&
            Number.isFinite(order.targetPrice) &&
            order.entryPrice > 0
              ? order.sizeSol * ((order.targetPrice - order.entryPrice) / order.entryPrice)
              : null;
          store.closeOrder(id, { reason: "target", realizedPnlSol: pnl });
          notify(`Orion: TARGET ${order.token} — sell filled @ ${order.targetPrice}`);
          actions.push({ id, type: "target" });
          continue;
        }
      }

      continue; // holding, no breakdown, sell not yet filled → hold
    }
  }

  return { actions };
}
