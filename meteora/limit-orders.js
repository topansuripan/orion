import { log } from "../logger.js";

/**
 * Minimum @meteora-ag/dlmm version that exposes the limit-order surface
 * (placeLimitOrder / getLimitOrder / cancelLimitOrder). Limit orders on DLMM
 * shipped in v1.9.8 (May 2026).
 */
export const MIN_LIMIT_ORDER_SDK_VERSION = "1.9.8";

/**
 * Parse a semver string into a numeric [major, minor, patch] tuple.
 * Strips a single leading range/prefix char (^, ~, v) if present.
 * Throws on input it can't parse into three numeric components.
 */
function parseSemver(version) {
  if (typeof version !== "string") {
    throw new Error(`Invalid SDK version: expected string, got ${typeof version}`);
  }
  const cleaned = version.trim().replace(/^[\^~v]+/, "");
  const parts = cleaned.split(".");
  if (parts.length < 3) {
    throw new Error(`Invalid SDK version string: "${version}"`);
  }
  const nums = parts.slice(0, 3).map((p) => {
    // Drop any pre-release / build suffix on the patch component (e.g. "8-beta.1").
    const n = parseInt(p, 10);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`Invalid SDK version string: "${version}"`);
    }
    return n;
  });
  return nums;
}

/**
 * PURE. Assert the installed @meteora-ag/dlmm version supports limit orders.
 * Throws a clear Error if version < MIN_LIMIT_ORDER_SDK_VERSION; returns true otherwise.
 *
 * Accepts plain versions ("1.9.8"), and defensively strips a leading
 * caret/tilde/v ("^1.9.4", "~1.10.0", "v2.0.0").
 */
export function assertSdkSupportsLimitOrders(version) {
  const [maj, min, pat] = parseSemver(version);
  const [reqMaj, reqMin, reqPat] = parseSemver(MIN_LIMIT_ORDER_SDK_VERSION);

  const current = maj * 1_000_000 + min * 1_000 + pat;
  const required = reqMaj * 1_000_000 + reqMin * 1_000 + reqPat;

  if (current < required) {
    throw new Error(
      `@meteora-ag/dlmm ${version} does not support limit orders; ` +
        `>= ${MIN_LIMIT_ORDER_SDK_VERSION} is required (functions placeLimitOrder/getLimitOrder/cancelLimitOrder).`
    );
  }
  return true;
}

/**
 * Place a single-bin limit order on a Meteora DLMM pool.
 *
 * DRY_RUN: returns a {dry_run:true,...} descriptor with a deterministic fake id
 * and DOES NOT import the SDK or touch the chain (mirrors tools/wallet.js swapToken).
 *
 * Live path:
 * ⚠️ UNVERIFIED SDK SURFACE — confirm placeLimitOrder signature/params against the
 *    installed @meteora-ag/dlmm >=1.9.8 before production. The SDK was NOT available
 *    when this was written; the call below is against the DOCUMENTED surface only and
 *    MUST be validated against the real package (see Task 0.4).
 *
 * @param {object} args
 * @param {string} args.pool       Pool (LB pair) address
 * @param {"buy"|"sell"} args.side Order side; "buy" = SOL -> token
 * @param {number} args.price      Target price bin to fill at
 * @param {number} args.amountSol  SOL amount to deposit into the target bin
 */
export async function placeLimitOrder({ pool, side, price, amountSol, ...rest } = {}) {
  if (process.env.DRY_RUN === "true") {
    log("limit_order", `DRY RUN place ${side} ${pool} @ ${price} for ${amountSol} SOL`);
    return {
      dry_run: true,
      would_place: { pool, side, price, amountSol },
      id: `dry-${pool}-${price}`,
      message: "DRY RUN — no limit order placed",
    };
  }

  // ─── Live, on-chain path ─────────────────────────────────────────────
  // ⚠️ UNVERIFIED SDK SURFACE — confirm placeLimitOrder signature/params against
  //    installed @meteora-ag/dlmm >=1.9.8 before production.
  log("limit_order", `place ${side} ${pool} @ ${price} for ${amountSol} SOL`);
  const dlmm = await import("@meteora-ag/dlmm");
  const place = dlmm.placeLimitOrder ?? dlmm.default?.placeLimitOrder;
  if (typeof place !== "function") {
    throw new Error("placeLimitOrder not found on @meteora-ag/dlmm — verify SDK surface (Task 0.4)");
  }
  const result = await place({ pool, side, price, amountSol, ...rest });
  log("limit_order", `placed id=${result?.id ?? "?"}`);
  return result;
}

/**
 * Fetch the status of a limit order by id.
 *
 * DRY_RUN: returns {dry_run:true, id, status:"open"} with no SDK import.
 *
 * Live path:
 * ⚠️ UNVERIFIED SDK SURFACE — confirm getLimitOrder signature/params against the
 *    installed @meteora-ag/dlmm >=1.9.8 before production (Task 0.4).
 */
export async function getLimitOrder(id) {
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, id, status: "open" };
  }

  // ⚠️ UNVERIFIED SDK SURFACE — confirm getLimitOrder signature/params against
  //    installed @meteora-ag/dlmm >=1.9.8 before production.
  const dlmm = await import("@meteora-ag/dlmm");
  const get = dlmm.getLimitOrder ?? dlmm.default?.getLimitOrder;
  if (typeof get !== "function") {
    throw new Error("getLimitOrder not found on @meteora-ag/dlmm — verify SDK surface (Task 0.4)");
  }
  return get(id);
}

/**
 * Cancel an open limit order by id (withdraws the deposited liquidity).
 *
 * DRY_RUN: returns {dry_run:true, id, cancelled:true, message} with no SDK import.
 *
 * Live path:
 * ⚠️ UNVERIFIED SDK SURFACE — confirm cancelLimitOrder signature/params against the
 *    installed @meteora-ag/dlmm >=1.9.8 before production (Task 0.4).
 */
export async function cancelLimitOrder(id) {
  if (process.env.DRY_RUN === "true") {
    log("limit_order", `DRY RUN cancel ${id}`);
    return {
      dry_run: true,
      id,
      cancelled: true,
      message: "DRY RUN — no cancel sent",
    };
  }

  // ⚠️ UNVERIFIED SDK SURFACE — confirm cancelLimitOrder signature/params against
  //    installed @meteora-ag/dlmm >=1.9.8 before production.
  log("limit_order", `cancel ${id}`);
  const dlmm = await import("@meteora-ag/dlmm");
  const cancel = dlmm.cancelLimitOrder ?? dlmm.default?.cancelLimitOrder;
  if (typeof cancel !== "function") {
    throw new Error("cancelLimitOrder not found on @meteora-ag/dlmm — verify SDK surface (Task 0.4)");
  }
  return cancel(id);
}
