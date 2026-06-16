import test from "node:test";
import assert from "node:assert";
import fs from "fs";
import { createStore } from "./state.js";

const TMP = "./orion-state.test.json";
const TMP_REL = "orion-state.test.json";

function cleanup() {
  for (const f of [TMP, TMP + ".tmp", TMP_REL, TMP_REL + ".tmp"]) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* ignore */
    }
  }
}

test.beforeEach(cleanup);
test.afterEach(cleanup);

function sampleOrder(over = {}) {
  return {
    id: "ord-1",
    token: "TokenMint111",
    pool: "Pool111",
    side: "buy",
    entryPrice: 1.0,
    stopPrice: 0.9,
    targetPrice: 1.5,
    sizeSol: 0.2,
    ...over,
  };
}

test("addOrder persists to disk (fresh store sees it)", () => {
  const store = createStore(TMP);
  const stored = store.addOrder(sampleOrder());

  // Defaults filled in
  assert.strictEqual(stored.status, "open");
  assert.strictEqual(stored.filledAt, null);
  assert.strictEqual(stored.sellOrderId, null);
  assert.strictEqual(stored.closedReason, null);
  assert.strictEqual(stored.realizedPnlSol, null);
  assert.ok(typeof stored.createdAt === "number");

  // Fresh store instance proves persistence to disk
  const fresh = createStore(TMP);
  const open = fresh.getOpenOrders();
  assert.strictEqual(open.length, 1);
  assert.strictEqual(open[0].id, "ord-1");
});

test("addOrder respects provided optional fields", () => {
  const store = createStore(TMP);
  const stored = store.addOrder(
    sampleOrder({ id: "ord-x", createdAt: 12345, status: "holding" })
  );
  assert.strictEqual(stored.createdAt, 12345);
  assert.strictEqual(stored.status, "holding");
});

test("getOrder returns record or undefined", () => {
  const store = createStore(TMP);
  store.addOrder(sampleOrder());
  assert.strictEqual(store.getOrder("ord-1").token, "TokenMint111");
  assert.strictEqual(store.getOrder("nope"), undefined);
});

test("updateOrder merges fields and persists", () => {
  const store = createStore(TMP);
  store.addOrder(sampleOrder());
  const updated = store.updateOrder("ord-1", { sellOrderId: "sell-9", entryPrice: 1.1 });
  assert.strictEqual(updated.sellOrderId, "sell-9");
  assert.strictEqual(updated.entryPrice, 1.1);
  // unchanged field preserved
  assert.strictEqual(updated.token, "TokenMint111");

  const fresh = createStore(TMP);
  assert.strictEqual(fresh.getOrder("ord-1").sellOrderId, "sell-9");
});

test("updateOrder on missing id returns undefined", () => {
  const store = createStore(TMP);
  assert.strictEqual(store.updateOrder("nope", { foo: 1 }), undefined);
});

test("markFilled sets status holding + filledAt", () => {
  const store = createStore(TMP);
  store.addOrder(sampleOrder());
  store.markFilled("ord-1", 99999);

  const fresh = createStore(TMP);
  const o = fresh.getOrder("ord-1");
  assert.strictEqual(o.status, "holding");
  assert.strictEqual(o.filledAt, 99999);
});

test("closeOrder sets closed + reason + pnl, removed from open", () => {
  const store = createStore(TMP);
  store.addOrder(sampleOrder());
  store.closeOrder("ord-1", { reason: "target", realizedPnlSol: 0.05 });

  const fresh = createStore(TMP);
  const o = fresh.getOrder("ord-1");
  assert.strictEqual(o.status, "closed");
  assert.strictEqual(o.closedReason, "target");
  assert.strictEqual(o.realizedPnlSol, 0.05);
  assert.strictEqual(fresh.getOpenOrders().length, 0);
});

test("getOpenOrders excludes closed, includes holding", () => {
  const store = createStore(TMP);
  store.addOrder(sampleOrder({ id: "a" }));
  store.addOrder(sampleOrder({ id: "b" }));
  store.addOrder(sampleOrder({ id: "c" }));
  store.markFilled("b", 1);
  store.closeOrder("c", { reason: "stop", realizedPnlSol: -0.1 });

  const open = store.getOpenOrders().map((o) => o.id).sort();
  assert.deepStrictEqual(open, ["a", "b"]);
});

test("removeOrder drops the record and persists", () => {
  const store = createStore(TMP);
  store.addOrder(sampleOrder());
  store.removeOrder("ord-1");

  const fresh = createStore(TMP);
  assert.strictEqual(fresh.getOrder("ord-1"), undefined);
  assert.strictEqual(fresh.getOpenOrders().length, 0);
});

test("setCooldown / getCooldownMap round-trip through disk", () => {
  const store = createStore(TMP);
  store.setCooldown("TOK", 1700000000000);

  const fresh = createStore(TMP);
  assert.strictEqual(fresh.getCooldownMap().TOK, 1700000000000);
});

test("load() on missing file returns empty state, no throw", () => {
  const store = createStore(TMP);
  const state = store.load();
  assert.deepStrictEqual(state, { orders: [], cooldowns: {} });
});

test("load() on corrupt file returns empty state, no throw", () => {
  fs.writeFileSync(TMP, "not json");
  const store = createStore(TMP);
  const state = store.load();
  assert.deepStrictEqual(state, { orders: [], cooldowns: {} });
});

test("addOrder appends without clobbering prior orders across instances", () => {
  createStore(TMP).addOrder(sampleOrder({ id: "first" }));
  createStore(TMP).addOrder(sampleOrder({ id: "second" }));
  const ids = createStore(TMP).getOpenOrders().map((o) => o.id).sort();
  assert.deepStrictEqual(ids, ["first", "second"]);
});
