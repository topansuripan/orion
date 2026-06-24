/**
 * tools/dlmm.js — Orion SHIM (NOT the Meteora DLMM SDK wrapper).
 *
 * `tools/screening.js` was copied from the Meridian LP agent and dynamically
 * imports `getMyPositions` from this path (around line 574) to exclude pools /
 * base mints the wallet already has a position in:
 *
 *     const { getMyPositions } = await import("./dlmm.js");
 *     const { positions } = await getMyPositions();
 *     const occupiedPools = new Set(positions.map((p) => p.pool));
 *     const occupiedMints = new Set(positions.map((p) => p.base_mint).filter(Boolean));
 *
 * So screening.js needs `{ positions: [{ pool, base_mint }, ...] }`. Orion has
 * no DLMM positions — its "held" assets are limit orders that have FILLED
 * (status "holding"). We map each such order to { pool, base_mint } so the
 * screener won't re-surface a pool/token Orion is already holding.
 *
 * Access to the state store is LAZY so importing this module does no I/O.
 */

import { createStore } from "../state.js";

let _store = null;
function store() {
  if (!_store) _store = createStore();
  return _store;
}

/**
 * Orion shim for the Meridian DLMM `getMyPositions`. Returns the pools/tokens
 * Orion is currently holding (filled buy orders), shaped so screening.js can
 * read `.pool` and `.base_mint` off each entry.
 *
 * @returns {Promise<{positions: Array<{pool:string, base_mint:string}>}>}
 */
export async function getMyPositions() {
  const held = store()
    .getOpenOrders()
    .filter((o) => o.status === "holding");
  const positions = held.map((o) => ({
    pool: o.pool,
    base_mint: o.token,
  }));
  return { positions };
}
