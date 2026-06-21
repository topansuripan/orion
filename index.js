/**
 * index.js — Orion main entry point.
 *
 * Orchestration glue only: boots the agent, schedules the scan/manage cycles
 * via node-cron, wires Telegram command handling, and exposes a tiny stdin
 * REPL for local manual use. ALL trading logic lives in orders.js and friends;
 * nothing strategy-related is reimplemented here.
 */

import "dotenv/config";
import cron from "node-cron";
import readline from "readline";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

import { config } from "./config.js";
import { log } from "./logger.js";
import * as telegram from "./telegram.js";
import { runScanCycle, runManageCycle } from "./orders.js";
import { resolveLiveMode } from "./live-mode.js";
import { getOpenOrders, closeOrder } from "./state.js";
import { getWalletBalances } from "./tools/wallet.js";
import {
  cancelLimitOrder,
  assertSdkSupportsLimitOrders,
  MIN_LIMIT_ORDER_SDK_VERSION,
} from "./meteora/limit-orders.js";

// NOTE: there is no module-level DRY_RUN constant. The live-trading gate in
// main() may FORCE process.env.DRY_RUN="true" (fail-safe), so every consumer
// must read process.env.DRY_RUN === "true" dynamically to reflect that.

// Overlap guard: a long scan must not overlap the next cron tick.
let _scanRunning = false;
// Scheduled cron tasks (for graceful shutdown).
const _cronTasks = [];

// ─── SDK capability check (defensive, degraded boot if SDK absent) ──────
// NOTE: @meteora-ag/dlmm is CJS and must be loaded via require() (dynamic import()
// of it throws an anchor ESM directory-import error). We verify the limit-order
// SURFACE directly (more robust than parsing a version string, and the package
// does not even expose ./package.json via its "exports" map). Version is read
// best-effort only for the log line.
async function checkLimitOrderSdk() {
  try {
    const DLMM = require("@meteora-ag/dlmm");
    const hasSurface =
      typeof DLMM?.create === "function" &&
      typeof DLMM?.prototype?.placeLimitOrder === "function";
    if (!hasSurface) {
      // SDK present but lacks the limit-order surface → too old / wrong package.
      log(
        "orion_error",
        `@meteora-ag/dlmm is installed but lacks the limit-order surface (need >= ${MIN_LIMIT_ORDER_SDK_VERSION}); placeLimitOrder/create missing.`,
      );
      process.exit(1);
    }
    // Best-effort version for the log line; do NOT fail boot if unreadable.
    let version = "unknown";
    try {
      version = require("@meteora-ag/dlmm/package.json")?.version ?? "unknown";
      if (version !== "unknown") assertSdkSupportsLimitOrders(version);
    } catch {
      /* exports map may hide ./package.json — capability check above is the gate */
    }
    log("orion", `@meteora-ag/dlmm ${version} OK — limit-order surface present`);
  } catch (e) {
    // Distinguish "not installed" (degraded boot) from "installed but too old" (hard exit).
    const msg = String(e?.message || e);
    const notInstalled =
      e?.code === "ERR_MODULE_NOT_FOUND" ||
      e?.code === "MODULE_NOT_FOUND" ||
      /cannot find (module|package)/i.test(msg) ||
      /failed to resolve/i.test(msg);
    if (notInstalled) {
      log(
        "orion_warn",
        "⚠️ @meteora-ag/dlmm not installed — limit orders disabled until deps are installed (see README/Task 0.4)",
      );
      return; // degraded/observe mode — keep booting
    }
    if (/does not support limit orders/i.test(msg)) {
      log("orion_error", msg);
      process.exit(1);
    }
    // Unknown failure reading the SDK — warn but don't crash the agent.
    log("orion_warn", `⚠️ Could not verify @meteora-ag/dlmm: ${msg}`);
  }
}

// ─── Cycle runners (wrapped: a thrown cycle must never kill the process) ──
async function safeManageCycle() {
  try {
    const res = await runManageCycle();
    const n = res?.actions?.length ?? 0;
    if (n > 0) log("orion", `manage cycle: ${n} action(s)`);
  } catch (e) {
    log("orion_error", `manage cycle failed: ${e?.message || e}`);
  }
}

async function safeScanCycle() {
  if (_scanRunning) {
    log("orion_warn", "scan cycle skipped — previous scan still running");
    return;
  }
  _scanRunning = true;
  try {
    const res = await runScanCycle();
    if (res?.placed) log("orion", `scan cycle: placed ${res.placed} order(s)`);
    else if (res?.reason) log("orion", `scan cycle: no orders (${res.reason})`);
  } catch (e) {
    log("orion_error", `scan cycle failed: ${e?.message || e}`);
  } finally {
    _scanRunning = false;
  }
}

// ─── Telegram command handlers (bypass any LLM; defensive) ───────────
function fmtAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

function ordersText() {
  const orders = getOpenOrders();
  if (orders.length === 0) return "No open orders.";
  const now = Date.now();
  const lines = orders.map((o, i) => {
    const tok = String(o.token || "?").slice(0, 8);
    return (
      `${i + 1}. ${tok} [${o.status}] ` +
      `entry ${o.entryPrice ?? "?"} | tgt ${o.targetPrice ?? "?"} | stop ${o.stopPrice ?? "?"} ` +
      `| age ${fmtAge(now - (o.createdAt ?? now))}`
    );
  });
  return `Open orders (${orders.length}):\n` + lines.join("\n");
}

async function statusText() {
  let solStr = "unavailable";
  try {
    const bal = await getWalletBalances();
    solStr = bal?.error ? `unavailable (${bal.error})` : `${bal.sol} SOL`;
  } catch (e) {
    solStr = `unavailable (${e?.message || e})`;
  }
  const openCount = getOpenOrders().length;
  return (
    `Orion status\n` +
    `Wallet: ${solStr}\n` +
    `Open orders: ${openCount}\n` +
    `DRY_RUN: ${process.env.DRY_RUN === "true"}\n` +
    `Scan: every ${config.orion.scanIntervalMin}m | Manage: every ${config.orion.manageIntervalMin}m`
  );
}

async function cancelByIndex(n) {
  const orders = getOpenOrders();
  const idx = Number(n) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= orders.length) {
    return `Invalid order number. Use /orders to see the list (1-${orders.length}).`;
  }
  const order = orders[idx];
  try {
    const res = await cancelLimitOrder(order.id);
    closeOrder(order.id, { reason: "manual" });
    const tag = res?.dry_run ? " (DRY RUN)" : "";
    return `Cancelled order ${idx + 1} — ${String(order.token).slice(0, 8)}${tag}.`;
  } catch (e) {
    return `Failed to cancel order ${idx + 1}: ${e?.message || e}`;
  }
}

const HELP =
  "Commands:\n" +
  "/orders — list open orders\n" +
  "/status — wallet + agent status\n" +
  "/cancel <n> — cancel the nth open order";

async function handleTelegramMessage(msg) {
  try {
    const text = String(msg?.text || "").trim();
    if (!text.startsWith("/")) return;
    const [cmd, ...args] = text.split(/\s+/);

    let reply;
    switch (cmd.toLowerCase()) {
      case "/orders":
        reply = ordersText();
        break;
      case "/status":
        reply = await statusText();
        break;
      case "/cancel":
        reply = await cancelByIndex(args[0]);
        break;
      default:
        reply = HELP;
    }
    await telegram.sendMessage(reply);
  } catch (e) {
    log("telegram_error", `command handler failed: ${e?.message || e}`);
    try {
      await telegram.sendMessage(`Error: ${e?.message || e}`);
    } catch {
      /* ignore */
    }
  }
}

// ─── Minimal stdin REPL (local manual use) ───────────────────────────
function startRepl() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("line", async (line) => {
    const cmd = line.trim().toLowerCase();
    try {
      switch (cmd) {
        case "scan":
          console.log("running scan cycle...");
          await safeScanCycle();
          break;
        case "manage":
          console.log("running manage cycle...");
          await safeManageCycle();
          break;
        case "orders":
          console.log(ordersText());
          break;
        case "quit":
        case "exit":
          rl.close();
          await shutdown("repl");
          return;
        case "":
          break;
        default:
          console.log("commands: scan | manage | orders | quit");
      }
    } catch (e) {
      console.error(`repl error: ${e?.message || e}`);
    }
  });
  return rl;
}

// ─── Graceful shutdown ───────────────────────────────────────────────
let _shuttingDown = false;
async function shutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  log("orion", `shutting down (${signal})`);
  for (const t of _cronTasks) {
    try {
      t.stop();
    } catch {
      /* ignore */
    }
  }
  if (telegram.isEnabled()) {
    try {
      telegram.stopPolling();
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
}

// ─── Boot ────────────────────────────────────────────────────────────
async function main() {
  // ─── Live-trading kill-switch (must precede every other boot check) ──
  // Live trading requires BOTH DRY_RUN=false AND LIVE_TRADING=true. If only
  // DRY_RUN=false, we fail-safe to dry and warn. The wrappers read
  // process.env.DRY_RUN at call time, so forcing it here is sufficient.
  const liveMode = resolveLiveMode(process.env);
  if (liveMode.forceDry) {
    process.env.DRY_RUN = "true"; // fail-safe: wrappers read process.env at call time
    log("orion_warn", `⚠️ ${liveMode.warning}`);
    try {
      if (telegram.isEnabled()) await telegram.sendMessage(`⚠️ Orion: ${liveMode.warning}`);
    } catch {
      /* ignore */
    }
  }
  const dryRun = process.env.DRY_RUN === "true"; // re-derive AFTER the gate (module-level DRY_RUN is now stale)
  const mode = liveMode.live ? "LIVE" : "DRY-RUN";

  if (!dryRun && !process.env.WALLET_PRIVATE_KEY) {
    log(
      "orion_error",
      "WALLET_PRIVATE_KEY is not set and DRY_RUN is not enabled. Set a wallet key or run with DRY_RUN=true.",
    );
    process.exit(1);
  }

  await checkLimitOrderSdk();

  // Best-effort wallet pubkey for the banner (do not block boot on it).
  let walletStr = "n/a";
  try {
    const bal = await getWalletBalances();
    walletStr = bal?.wallet ?? bal?.address ?? bal?.pubkey ?? bal?.publicKey ?? "n/a";
  } catch {
    walletStr = "n/a";
  }

  const { maxOrderSizeSol, maxTotalExposureSol, maxConcurrentOrders, scanIntervalMin, manageIntervalMin } =
    config.orion;
  log("orion", "──────────────────────────────────────────");
  log("orion", "Orion — Meteora limit-order TA agent");
  log("orion", `Mode: ${mode}`);
  log("orion", `Wallet: ${walletStr}`);
  log(
    "orion",
    `Caps: maxOrderSizeSol=${maxOrderSizeSol} | maxTotalExposureSol=${maxTotalExposureSol} | maxConcurrentOrders=${maxConcurrentOrders}`,
  );
  log("orion", `Scan every ${scanIntervalMin}m | Manage every ${manageIntervalMin}m`);
  log("orion", "──────────────────────────────────────────");

  // Manage cycle (more frequent).
  _cronTasks.push(
    cron.schedule(`*/${config.orion.manageIntervalMin} * * * *`, () => {
      safeManageCycle();
    }),
  );
  // Scan cycle (less frequent).
  _cronTasks.push(
    cron.schedule(`*/${config.orion.scanIntervalMin} * * * *`, () => {
      safeScanCycle();
    }),
  );

  // Telegram commands (only if a bot token is configured).
  if (telegram.isEnabled()) {
    telegram.startPolling(handleTelegramMessage);
    log("orion", "Telegram commands enabled (/orders /status /cancel)");
    try {
      await telegram.sendMessage(
        `Orion online — mode: ${mode} (DRY_RUN=${dryRun}).\n` +
          `Caps: maxOrderSizeSol=${maxOrderSizeSol} | maxTotalExposureSol=${maxTotalExposureSol} | maxConcurrentOrders=${maxConcurrentOrders}\n` +
          `Scan every ${scanIntervalMin}m | Manage every ${manageIntervalMin}m\n` +
          HELP,
      );
    } catch {
      /* ignore */
    }
  } else {
    log("orion", "Telegram disabled (no TELEGRAM_BOT_TOKEN)");
  }

  startRepl();

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((e) => {
  log("orion_error", `fatal during boot: ${e?.message || e}`);
  process.exit(1);
});
