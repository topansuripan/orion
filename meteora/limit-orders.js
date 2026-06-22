import { log } from "../logger.js";
import { createRequire } from "node:module";

// @meteora-ag/dlmm is CJS (`module.exports = class DLMM`). It MUST be loaded via
// require(): dynamic import() of it throws "Directory import … @coral-xyz/anchor/
// dist/cjs/utils/bytes is not supported resolving ES modules" (an unresolvable
// ESM directory-import deep in anchor). require() resolves it correctly. Verified
// 2026-06-21 against @meteora-ag/dlmm@1.9.10.
const require = createRequire(import.meta.url);

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
 * PURE. Scale a decimal amount by 10^decimals into an EXACT integer string,
 * with no floating-point precision loss (string arithmetic only).
 *
 * e.g. scaleToRaw(0.01, 9) -> "10000000"; scaleToRaw("1.5", 6) -> "1500000".
 * Used for SOL lamports (decimals=9) and held base (token decimals). Fractional
 * digits beyond `decimals` are truncated (floor toward zero).
 */
export function scaleToRaw(amount, decimals) {
  // toFixed gives a non-exponential, fully-expanded decimal string for numbers.
  const s = typeof amount === "number" ? amount.toFixed(decimals) : String(amount);
  const neg = s.startsWith("-");
  const [intPart, fracPart = ""] = (neg ? s.slice(1) : s).split(".");
  const frac = (fracPart + "0".repeat(decimals)).slice(0, decimals);
  const raw = (intPart + frac).replace(/^0+(?=\d)/, "");
  return (neg ? "-" : "") + (raw === "" ? "0" : raw);
}

// Convert a UI price → DLMM bin id (floor when min=true, ceil when min=false).
// Extracted as a pure, testable seam: the inline version inside getDlmm was
// never exercised because getDlmm is stubbed in every test.
export function priceToBinId(DLMM, price, binStep, min = true) {
  // This SDK's getBinIdFromPrice expects the UI price DIRECTLY (verified vs live
  // pools: getBinIdFromPrice(getActiveBin().price, binStep) === getActiveBin().binId).
  // A previous getPricePerLamport(decimalsX, decimalsY, price) pre-conversion
  // produced wrong bins + "offset out of range" overflows on placement.
  return DLMM.getBinIdFromPrice(price, binStep, min);
}

// ─────────────────────────────────────────────────────────────────────────
// Test-injectable chain seam.
//
// All on-chain interaction in the LIVE path is routed through this `__deps`
// object. The DEFAULT implementations lazily import the chain deps
// (@meteora-ag/dlmm, @coral-xyz/anchor, @solana/web3.js, tools/wallet.js) so
// that importing this module (and exercising the DRY_RUN paths) never requires
// those deps installed. Unit tests call __setDeps(...) to inject fakes and
// __resetDeps() to restore defaults — see ./limit-orders.test.js.
//
// NOTE: DRY_RUN branches are checked FIRST in every exported function and
// short-circuit BEFORE any __deps member is read, keeping DRY_RUN chain-free.
// ─────────────────────────────────────────────────────────────────────────

// Per-pool DLMM instance cache (keyed by pool address). Holds the wrapped
// instance returned by the default getDlmm (with decimals/binStep/priceToBinId).
const _dlmmCache = new Map();

const _defaultDeps = {
  // Resolve the trading wallet Keypair (from tools/wallet.js's getWallet via a
  // tiny re-export shim). We import @solana/web3.js + bs58 here lazily.
  async getWallet() {
    const { Keypair } = await import("@solana/web3.js");
    const bs58 = (await import("bs58")).default;
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
    return Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
  },

  // Fresh order Keypair; its pubkey IS our order id.
  async makeOrderKeypair() {
    const { Keypair } = await import("@solana/web3.js");
    return Keypair.generate();
  },

  // Wrap a base58 string in a web3 PublicKey.
  async makePublicKey(s) {
    const { PublicKey } = await import("@solana/web3.js");
    return new PublicKey(s);
  },

  // Wrap a raw-units string in an anchor BN at the SDK boundary.
  // NOTE: @coral-xyz/anchor is CJS; under dynamic import() Node does NOT expose
  // `BN` as a detected named export (it lands on `.default`), so the old
  // `const { BN } = await import(...)` yielded undefined → "BN is not a
  // constructor". Read it off the default export instead.
  async makeBN(rawString) {
    const { default: anchor } = await import("@coral-xyz/anchor");
    return new anchor.BN(rawString);
  },

  // Create (and cache) a DLMM instance for `pool`, augmented with the token
  // decimals, binStep, and a priceToBinId(price,{min}) helper.
  async getDlmm(pool) {
    if (_dlmmCache.has(pool)) return _dlmmCache.get(pool);

    // The module IS the DLMM class (CJS `module.exports = class`; no `default`
    // export) — see docs/sdk-notes.md "Module / construction". Loaded via require()
    // because dynamic import() of this package fails under ESM (see note at top).
    const DLMM = require("@meteora-ag/dlmm");
    const { Connection, PublicKey } = await import("@solana/web3.js");
    const connection = new Connection(process.env.RPC_URL, "confirmed");
    const dlmm = await DLMM.create(connection, new PublicKey(pool));

    const decimalsX = dlmm.tokenX.mint.decimals;
    const decimalsY = dlmm.tokenY.mint.decimals;
    const binStep = dlmm.lbPair.binStep;

    dlmm.__decimalsX = decimalsX;
    dlmm.__decimalsY = decimalsY;
    dlmm.__binStep = binStep;
    dlmm.__baseMint = dlmm.tokenX.mint.address?.toBase58?.() ?? String(dlmm.tokenX.mint.address);
    dlmm.supportsLimitOrder = DLMM.isSupportLimitOrder(dlmm.lbPair);
    dlmm.priceToBinId = (price, { min = true } = {}) =>
      priceToBinId(DLMM, price, binStep, min);

    _dlmmCache.set(pool, dlmm);
    return dlmm;
  },

  // Sign a legacy web3 Transaction and send + confirm; return signature string.
  //
  // Failure semantics: ANY send/confirm error THROWS so the caller never records
  // an unconfirmed order as confirmed. The thrown message includes the signature
  // when available, so a tx that landed but failed to confirm is recoverable from
  // logs (and can be reconciled later — see follow-up note below).
  //
  // Uses the modern blockhash + lastValidBlockHeight confirmation strategy (the
  // signature-only overload is deprecated). The SDK sets recentBlockhash +
  // feePayer on the tx; legacy txs may lack lastValidBlockHeight, so we fall back
  // to the signature-only overload only when it is genuinely absent.
  //
  // FOLLOW-UP (not in scope here): full startup reconciliation of in-flight
  // orders via dlmm.getLimitOrderByUserAndLbPair should recover any order that
  // landed on-chain but whose confirmation threw — see docs/sdk-notes.md.
  async signAndSend(tx, signers) {
    const { Connection } = await import("@solana/web3.js");
    const connection = new Connection(process.env.RPC_URL, "confirmed");

    tx.sign(...signers);
    const raw = tx.serialize();
    let sig;
    try {
      sig = await connection.sendRawTransaction(raw, { skipPreflight: false });
    } catch (err) {
      throw new Error(`limit-order tx send failed: ${err?.message ?? err}`);
    }

    log("limit_order", `sent tx sig=${sig}; awaiting confirmation`);

    const blockhash = tx.recentBlockhash;
    const lastValidBlockHeight = tx.lastValidBlockHeight;
    let conf;
    try {
      conf = await connection.confirmTransaction(
        lastValidBlockHeight != null
          ? { signature: sig, blockhash, lastValidBlockHeight }
          : sig,
        "confirmed"
      );
    } catch (err) {
      throw new Error(`limit-order tx confirm failed: ${sig} err=${err?.message ?? err}`);
    }

    if (conf?.value?.err) {
      throw new Error(`limit-order tx failed on-chain: ${sig} err=${JSON.stringify(conf.value.err)}`);
    }
    return sig;
  },
};

// Active deps (default impls; overridable by tests).
let __deps = { ..._defaultDeps };

/** TEST ONLY — inject partial fake deps for the live path. */
export function __setDeps(partial = {}) {
  __deps = { ...__deps, ...partial };
}

/** TEST ONLY — restore default (lazy chain-importing) deps + clear caches. */
export function __resetDeps() {
  __deps = { ..._defaultDeps };
  _dlmmCache.clear();
}

/**
 * Place a single-bin limit order on a Meteora DLMM pool.
 *
 * DRY_RUN: returns a {dry_run:true,...} descriptor with a deterministic fake id
 * and DOES NOT touch __deps / the chain (mirrors tools/wallet.js swapToken).
 *
 * Live path (verified against @meteora-ag/dlmm@1.9.10 — see docs/sdk-notes.md):
 *  - capability guard via DLMM.isSupportLimitOrder(dlmm.lbPair)
 *  - price → absolute bin id via getPricePerLamport + getBinIdFromPrice
 *  - BUY  → isAskSide:false, deposit QUOTE (SOL/Y); amount = scaleToRaw(amountSol,9) lamports.
 *  - SELL → isAskSide:true,  deposit BASE (X);  amount = scaleToRaw(baseAmount, decimalsX).
 *    `baseAmount` is an EXPLICIT base-token (UI) quantity supplied by the caller —
 *    used for scale-out HALF sells; the wrapper no longer fetches the full held
 *    balance (the orders.js manage cycle sizes TP1 to a fraction of held base).
 *  - dlmm.placeLimitOrder(...) returns an UNSIGNED legacy Transaction; we sign
 *    with [wallet, orderKeypair] and send. The order keypair pubkey IS the id.
 *
 * @param {object} args
 * @param {string} args.pool        Pool (LB pair) address
 * @param {"buy"|"sell"} args.side  Order side; "buy" = SOL -> token
 * @param {number} args.price       Target price (quote per base) to fill at
 * @param {number} args.amountSol   SOL amount to deposit (BUY only; ignored for SELL)
 * @param {number} args.baseAmount  Base-token (UI) amount to sell (SELL only; ignored for BUY)
 * @returns {Promise<{id:string, signature:string, binId:number, side:string, pool:string}>}
 */
export async function placeLimitOrder({ pool, side, price, amountSol, baseAmount } = {}) {
  if (process.env.DRY_RUN === "true") {
    log("limit_order", `DRY RUN place ${side} ${pool} @ ${price} for ${side === "sell" ? baseAmount + " base" : amountSol + " SOL"}`);
    return {
      dry_run: true,
      would_place: { pool, side, price, amountSol, baseAmount },
      id: `dry-${pool}-${price}`,
      message: "DRY RUN — no limit order placed",
    };
  }

  // ─── Pre-flight (fail closed BEFORE touching any chain dep) ──────────
  if (!pool || (side !== "buy" && side !== "sell")) {
    throw new Error(`placeLimitOrder: invalid args (pool=${pool}, side=${side})`);
  }
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`placeLimitOrder: invalid price ${price}`);
  }
  const isAskSide = side === "sell";
  if (!isAskSide && (!Number.isFinite(amountSol) || amountSol <= 0)) {
    throw new Error(`placeLimitOrder: invalid amountSol ${amountSol} for buy`);
  }
  if (isAskSide && (!Number.isFinite(baseAmount) || baseAmount <= 0)) {
    throw new Error(`placeLimitOrder: invalid sell amount ${baseAmount} (baseAmount must be a positive base-token quantity)`);
  }

  // ─── Live, on-chain path ─────────────────────────────────────────────
  log("limit_order", `place ${side} ${pool} @ ${price} for ${isAskSide ? baseAmount + " base" : amountSol + " SOL"}`);

  const wallet = await __deps.getWallet();
  const dlmm = await __deps.getDlmm(pool);
  if (!dlmm.supportsLimitOrder) {
    throw new Error(`pool ${pool} does not support limit orders`);
  }

  // Compute raw deposit amount (string) ourselves, wrap in BN only at the boundary.
  let rawAmountString;
  if (isAskSide) {
    // Decimals MUST be known — a 0 fallback would mis-size the sell by orders of
    // magnitude. The DLMM instance carries the base-token (X) decimals.
    const decimalsX = dlmm.__decimalsX;
    if (!Number.isFinite(decimalsX)) {
      throw new Error(`placeLimitOrder: cannot size sell: unknown base-token decimals for pool ${pool}`);
    }
    rawAmountString = scaleToRaw(baseAmount, decimalsX);
    if (!rawAmountString || Number(rawAmountString) <= 0) {
      throw new Error(`placeLimitOrder: sell amount ${baseAmount} scales to zero raw units in pool ${pool}`);
    }
  } else {
    rawAmountString = scaleToRaw(amountSol, 9); // SOL has 9 decimals (lamports)
  }

  // BUY (bid) at/below support → floor (min=true); SELL (ask) at target → ceil (min=false).
  const binId = dlmm.priceToBinId(price, { min: !isAskSide });
  const amount = await __deps.makeBN(rawAmountString);
  const orderKeypair = await __deps.makeOrderKeypair();
  const owner = wallet.publicKey;

  const tx = await dlmm.placeLimitOrder({
    owner,
    payer: owner,
    sender: owner,
    limitOrder: orderKeypair.publicKey,
    params: { bins: [{ id: binId, amount }], isAskSide },
  });

  const signature = await __deps.signAndSend(tx, [wallet, orderKeypair]);
  const id = orderKeypair.publicKey.toBase58();
  log("limit_order", `placed ${side} id=${id} bin=${binId} sig=${signature}`);

  return { id, signature, binId, side, pool };
}

/**
 * Derive overall fill status from a single-bin order's parsed limitOrderData.
 * Amount fields are UI-decimal strings (see docs/sdk-notes.md "Status derivation").
 *
 * @param {object} d        limitOrderData
 * @param {"buy"|"sell"} [side] deposit-side hint; derived if absent.
 */
function deriveStatus(d, side) {
  const filledX = Number(d.totalFilledAmountX ?? 0);
  const filledY = Number(d.totalFilledAmountY ?? 0);
  const unfilledX = Number(d.totalUnfilledAmountX ?? 0);
  const unfilledY = Number(d.totalUnfilledAmountY ?? 0);
  const eps = 1e-12;

  if (side === "buy") {
    if (filledX <= eps) return "open";
    if (unfilledY <= eps) return "filled";
    return "partial";
  }
  if (side === "sell") {
    if (filledY <= eps) return "open";
    if (unfilledX <= eps) return "filled";
    return "partial";
  }

  // side unknown → derive from both sides.
  const anyFilled = filledX > eps || filledY > eps;
  const anyUnfilled = unfilledX > eps || unfilledY > eps;
  if (!anyFilled) return "open";
  if (anyFilled && anyUnfilled) return "partial";
  return "filled";
}

/**
 * Fetch the status of a limit order by id.
 *
 * DRY_RUN: returns {dry_run:true, id, status:"open"} with no chain access.
 *
 * Live path (see docs/sdk-notes.md "getLimitOrder"): fill detection is NOT a
 * single status field. We list the wallet's orders for the pool via
 * getLimitOrderByUserAndLbPair, find ours by pubkey, and derive status from the
 * parsed UI-string amounts.
 *
 * @param {string} id
 * @param {{pool?:string, side?:"buy"|"sell"}} [opts]
 * @returns {Promise<{status:"open"|"partial"|"filled", filledBaseAmount?:number, raw?:object, notFound?:boolean}>}
 */
export async function getLimitOrder(id, { pool, side } = {}) {
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, id, status: "open" };
  }

  const wallet = await __deps.getWallet();
  const dlmm = await __deps.getDlmm(pool);
  const list = await dlmm.getLimitOrderByUserAndLbPair(wallet.publicKey);
  const mine = (list || []).find((o) => o.publicKey?.toBase58?.() === id);

  if (!mine) {
    // Conservative: not found ≠ filled (could be cancelled/auto-closed).
    log("limit_order", `getLimitOrder ${id} not found in pool ${pool} order list`);
    return { status: "open", notFound: true };
  }

  const d = mine.limitOrderData;
  const status = deriveStatus(d, side);
  const filledBaseAmount = Number(d.totalFilledAmountX ?? 0);
  return { status, filledBaseAmount, raw: d };
}

/**
 * Cancel an open limit order by id (withdraws the deposited liquidity).
 *
 * DRY_RUN: returns {dry_run:true, id, cancelled:true, message} with no chain access.
 *
 * Live path (see docs/sdk-notes.md "cancelLimitOrder"): build the unsigned
 * legacy Transaction via dlmm.cancelLimitOrder, sign with [wallet], send.
 * If `binIds` is not supplied, it is looked up from the order's parsed bin data.
 *
 * @param {string} id
 * @param {{pool?:string, binIds?:number[]}} [opts]
 * @returns {Promise<{id:string, signature:string, cancelled:true}>}
 */
export async function cancelLimitOrder(id, { pool, binIds } = {}) {
  if (process.env.DRY_RUN === "true") {
    log("limit_order", `DRY RUN cancel ${id}`);
    return {
      dry_run: true,
      id,
      cancelled: true,
      message: "DRY RUN — no cancel sent",
    };
  }

  log("limit_order", `cancel ${id}`);
  const wallet = await __deps.getWallet();
  const dlmm = await __deps.getDlmm(pool);

  // Resolve bin ids if the caller didn't persist them.
  let resolvedBinIds = Array.isArray(binIds) ? binIds : null;
  if (!resolvedBinIds) {
    const list = await dlmm.getLimitOrderByUserAndLbPair(wallet.publicKey);
    const mine = (list || []).find((o) => o.publicKey?.toBase58?.() === id);
    const perBin = mine?.limitOrderData?.limitOrderBinData ?? [];
    resolvedBinIds = perBin.map((b) => (typeof b.binId === "function" ? b.binId() : b.binId));
    if (resolvedBinIds.length === 0) {
      throw new Error(`cancelLimitOrder: could not resolve binIds for ${id} (pass binIds explicitly)`);
    }
  }

  const limitOrderPubkey = await __deps.makePublicKey(id);
  const tx = await dlmm.cancelLimitOrder({
    limitOrderPubkey,
    owner: wallet.publicKey,
    rentReceiver: wallet.publicKey,
    binIds: resolvedBinIds,
  });

  const signature = await __deps.signAndSend(tx, [wallet]);
  log("limit_order", `cancelled ${id} sig=${signature}`);
  return { id, signature, cancelled: true };
}
