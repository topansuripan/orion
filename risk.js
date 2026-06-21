// risk.js — Pure order-sizing and risk-limit helpers for Orion.
//
// All functions are PURE and take the orion config slice (`cfg`) as a
// parameter. They do NOT import config.js. Relevant cfg keys:
//   orderSizeSol           — floor order size in SOL (default 0.2)
//   orderSizePct           — fraction of deployable balance to size (default 0.25)
//   maxConcurrentOrders    — max simultaneously open orders (default 3)
//   gasReserve             — SOL held back for fees (default 0.05)
//   cooldownHoursAfterStop — cooldown after a stop-loss, in hours (default 6)

const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

/**
 * Compute the order size (SOL) given the wallet balance and open-order count.
 * Mirrors Meridian's computeDeployAmount: size as a % of deployable balance,
 * clamped to a floor (orderSizeSol) and a ceiling (deployable).
 *
 * @param {number} walletSol  current wallet SOL balance
 * @param {number} openOrders number of currently open orders (parity/future use)
 * @param {object} cfg        orion config slice
 * @returns {number} order size in SOL (0 if not enough to open a floor order)
 */
export function computeOrderSize(walletSol, openOrders, cfg) {
  const deployable = walletSol - cfg.gasReserve;
  if (deployable < cfg.orderSizeSol) return 0;
  let size = clamp(deployable * cfg.orderSizePct, cfg.orderSizeSol, deployable);
  // Hard cap wins even when below the orderSizeSol floor (fail-closed).
  if (Number.isFinite(cfg.maxOrderSizeSol) && size > cfg.maxOrderSizeSol) {
    size = cfg.maxOrderSizeSol;
  }
  return size;
}

/**
 * Whether adding an order of `newSizeSol` would push total committed SOL
 * (sum of open/holding order sizes + new) over cfg.maxTotalExposureSol.
 * Fail-open ONLY when no cap is configured (undefined/non-finite). PURE.
 */
export function exposureWouldExceed(openOrders, newSizeSol, cfg) {
  const cap = cfg.maxTotalExposureSol;
  if (!Number.isFinite(cap)) return false;
  const committed = (openOrders || []).reduce((a, o) => a + (Number(o.sizeSol) || 0), 0);
  return committed + (Number(newSizeSol) || 0) > cap;
}

/**
 * Whether a new order may be opened given the current open-order count.
 * @param {number} openOrders
 * @param {object} cfg
 * @returns {boolean}
 */
export function canOpen(openOrders, cfg) {
  return openOrders < cfg.maxConcurrentOrders;
}

/**
 * Whether a token is currently on cooldown.
 * @param {string} token
 * @param {number} nowMs       current epoch ms
 * @param {object} cooldownMap map of token -> untilMs
 * @param {object} cfg         orion config slice (unused; kept for signature parity)
 * @returns {boolean}
 */
export function isOnCooldown(token, nowMs, cooldownMap, cfg) {
  const until = cooldownMap[token];
  return until !== undefined && nowMs < until;
}

/**
 * Compute the cooldown expiry timestamp when a stop-loss happens.
 * @param {number} nowMs current epoch ms
 * @param {object} cfg    orion config slice
 * @returns {number} epoch ms until which the token is on cooldown
 */
export function cooldownUntil(nowMs, cfg) {
  return nowMs + cfg.cooldownHoursAfterStop * 3600_000;
}
