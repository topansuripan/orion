import test from "node:test";
import assert from "node:assert";
import { resolveLiveMode } from "./live-mode.js";

test("resolveLiveMode: DRY_RUN unset → dry, no force, no warning", () => {
  const r = resolveLiveMode({});
  assert.deepEqual(r, { live: false, forceDry: false, warning: null });
});

test("resolveLiveMode: DRY_RUN='true' → dry, no force, no warning", () => {
  const r = resolveLiveMode({ DRY_RUN: "true" });
  assert.equal(r.live, false);
  assert.equal(r.forceDry, false);
  assert.equal(r.warning, null);
});

test("resolveLiveMode: DRY_RUN='false', LIVE_TRADING unset → forceDry with warning", () => {
  const r = resolveLiveMode({ DRY_RUN: "false" });
  assert.equal(r.live, false);
  assert.equal(r.forceDry, true);
  assert.ok(r.warning);
});

test("resolveLiveMode: DRY_RUN='false', LIVE_TRADING='true' → live, no force, no warning", () => {
  const r = resolveLiveMode({ DRY_RUN: "false", LIVE_TRADING: "true" });
  assert.deepEqual(r, { live: true, forceDry: false, warning: null });
});
