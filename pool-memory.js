/**
 * pool-memory.js — Orion SHIM (not the Meridian LP pool-memory module).
 *
 * `tools/screening.js` was copied from the Meridian LP agent and statically
 * imports `isBaseMintOnCooldown` / `isPoolOnCooldown` from this path. Orion
 * does not track per-pool deploy history; it tracks per-TOKEN cooldowns in the
 * state store (`state.js` cooldown map). These thin wrappers let screening.js
 * import and run unchanged.
 *
 * Design notes:
 *  - Token cooldowns are backed by the DEFAULT state store's cooldown map
 *    (token -> untilMs). We compare against Date.now().
 *  - Pool-level cooldown always returns false: Orion keys cooldown by token,
 *    not by pool, so there is no pool-scoped cooldown to consult.
 *  - Access to the store is LAZY (resolved per call) so merely importing this
 *    module never reads or writes orion-state.json.
 */

import { createStore } from "./state.js";

// Lazily-created default-path store. Constructing createStore() does no I/O;
// the file is only touched when getCooldownMap() is actually called.
let _store = null;
function store() {
  if (!_store) _store = createStore();
  return _store;
}

/**
 * Whether a base-token mint is currently on cooldown.
 * @param {string} mint
 * @returns {boolean}
 */
export function isBaseMintOnCooldown(mint) {
  if (!mint) return false;
  const until = store().getCooldownMap()[mint];
  return typeof until === "number" && Date.now() < until;
}

/**
 * Whether a pool is on cooldown. Orion tracks cooldown by token only, so this
 * is always false. Kept to satisfy screening.js's import surface.
 * @param {string} _pool
 * @returns {boolean}
 */
export function isPoolOnCooldown(_pool) {
  return false;
}
