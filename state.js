/**
 * Orion state registry — JSON-backed store for limit orders / positions
 * and per-token cooldowns. Persisted to orion-state.json.
 *
 * State shape:
 *   { orders: [ ...orderRecords ], cooldowns: { [token]: untilMs } }
 *
 * Order record shape:
 *   {
 *     id, token, pool, side,
 *     entryPrice, stopPrice, targetPrice, sizeSol,
 *     status,          // "open" | "holding" | "closed"
 *     createdAt, filledAt,
 *     sellOrderId,     // string | null
 *     closedReason,    // null | "target" | "stop" | "stale" | "manual"
 *     realizedPnlSol   // number | null
 *   }
 *
 * Persistence is atomic (write to .tmp then rename) so a crash mid-write
 * never corrupts the live file. Load tolerates a missing or malformed file.
 */

import fs from "fs";

const DEFAULT_FILE = "./orion-state.json";

function emptyState() {
  return { orders: [], cooldowns: {} };
}

/**
 * Factory: returns a store bound to `filePath`. Tests pass a temp path so
 * the real orion-state.json is never touched.
 */
export function createStore(filePath = DEFAULT_FILE) {
  function load() {
    if (!fs.existsSync(filePath)) return emptyState();
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return {
        orders: Array.isArray(parsed?.orders) ? parsed.orders : [],
        cooldowns:
          parsed?.cooldowns && typeof parsed.cooldowns === "object"
            ? parsed.cooldowns
            : {},
      };
    } catch {
      // Missing/corrupt file -> empty state, never throw.
      return emptyState();
    }
  }

  function save(state) {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, filePath);
  }

  function addOrder(order) {
    if (!order || !order.id) throw new Error("addOrder: order.id required");
    const state = load();
    const record = {
      sellOrderId: null,
      filledAt: null,
      closedReason: null,
      realizedPnlSol: null,
      ...order,
      status: order.status ?? "open",
      createdAt: order.createdAt ?? Date.now(),
    };
    state.orders.push(record);
    save(state);
    return record;
  }

  function getOpenOrders() {
    return load().orders.filter((o) => o.status !== "closed");
  }

  function getOrder(id) {
    return load().orders.find((o) => o.id === id);
  }

  function updateOrder(id, patch) {
    const state = load();
    const idx = state.orders.findIndex((o) => o.id === id);
    if (idx === -1) return undefined;
    state.orders[idx] = { ...state.orders[idx], ...patch };
    save(state);
    return state.orders[idx];
  }

  function markFilled(id, filledAtMs) {
    return updateOrder(id, { status: "holding", filledAt: filledAtMs });
  }

  function closeOrder(id, { reason, realizedPnlSol } = {}) {
    return updateOrder(id, {
      status: "closed",
      closedReason: reason ?? null,
      realizedPnlSol: realizedPnlSol ?? null,
    });
  }

  function removeOrder(id) {
    const state = load();
    const next = state.orders.filter((o) => o.id !== id);
    if (next.length === state.orders.length) return false;
    state.orders = next;
    save(state);
    return true;
  }

  function setCooldown(token, untilMs) {
    const state = load();
    state.cooldowns[token] = untilMs;
    save(state);
    return state.cooldowns;
  }

  function getCooldownMap() {
    return load().cooldowns;
  }

  return {
    filePath,
    load,
    addOrder,
    getOpenOrders,
    getOrder,
    updateOrder,
    markFilled,
    closeOrder,
    removeOrder,
    setCooldown,
    getCooldownMap,
  };
}

// ─── Default-path convenience functions ────────────────────────────
// Bound to orion-state.json for use by other modules at runtime.

const defaultStore = createStore(DEFAULT_FILE);

export const load = defaultStore.load;
export const addOrder = defaultStore.addOrder;
export const getOpenOrders = defaultStore.getOpenOrders;
export const getOrder = defaultStore.getOrder;
export const updateOrder = defaultStore.updateOrder;
export const markFilled = defaultStore.markFilled;
export const closeOrder = defaultStore.closeOrder;
export const removeOrder = defaultStore.removeOrder;
export const setCooldown = defaultStore.setCooldown;
export const getCooldownMap = defaultStore.getCooldownMap;
