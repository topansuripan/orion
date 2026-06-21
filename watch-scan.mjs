// watch-scan.mjs — READ-ONLY all-day watcher. Scans on an interval, samples
// many candidates, and logs any that WOULD fire an entry (with notional sizing).
// NO wallet, NO SOL, NO orders are ever placed.
//
// Env: MAX_HOURS (default 24), GAP_MS (default 900000 = 15min, matches relay
//      15m candles), OBSERVE_LIMIT (default 30), NOTIONAL_SOL (default 1).
// Run: NODE_TLS_REJECT_UNAUTHORIZED=0 DRY_RUN=true node watch-scan.mjs
//
// Logs: logs/observe-fires.log (would-fire events), logs/observe-watch.log
// (per-cycle heartbeat). Both are under logs/ which is gitignored.

import { appendFileSync, mkdirSync } from "node:fs";
import { config } from "./config.js";
import { getTopCandidates } from "./tools/screening.js";
import { fetchChartIndicatorsForMint, buildSignalSummary } from "./tools/chart-indicators.js";
import { detectEntryFromIndicators } from "./ta/relay-setups.js";
import { computeOrderSize } from "./risk.js";

const MAX_HOURS = Number(process.env.MAX_HOURS || 24);
const GAP_MS = Number(process.env.GAP_MS || 900000);
const LIMIT = Number(process.env.OBSERVE_LIMIT || 30);
const NOTIONAL = Number(process.env.NOTIONAL_SOL || 1);
const o = config.orion || {};
const f = (n, d = 8) => (Number.isFinite(n) ? Number(n).toFixed(d) : "n/a");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);

mkdirSync("./logs", { recursive: true });
const FIRES = "./logs/observe-fires.log";
const HEARTBEAT = "./logs/observe-watch.log";
const logFire = (line) => { console.log(line); try { appendFileSync(FIRES, line + "\n"); } catch {} };
const logBeat = (line) => { console.log(line); try { appendFileSync(HEARTBEAT, line + "\n"); } catch {} };

const deadline = now() + MAX_HOURS * 3600_000;
logBeat(`[${ts()}] === watch-scan START: until +${MAX_HOURS}h, every ${GAP_MS / 60000}min, limit ${LIMIT}, notional ${NOTIONAL} SOL, interval ${o.indicatorInterval}. READ-ONLY. ===`);

let cycle = 0;
let totalFired = 0;
while (now() < deadline) {
  cycle++;
  let candidates = [];
  try {
    const res = await getTopCandidates({ limit: LIMIT });
    candidates = res?.candidates ?? res ?? [];
  } catch (e) {
    logBeat(`[${ts()}] cycle ${cycle}: screening failed — ${e?.message || e}`);
    { const rem = deadline - now(); if (rem <= 0) break; await sleep(Math.min(GAP_MS, rem)); }
    continue;
  }

  let fired = 0, bullish = 0;
  for (const c of candidates) {
    const name = c.name || c.symbol || "?";
    const mint = c.base?.mint || c.base_mint;
    if (!mint) continue;
    try {
      const payload = await fetchChartIndicatorsForMint(mint, { interval: o.indicatorInterval });
      const s = buildSignalSummary(payload);
      if (s.supertrendDirection === "bullish") bullish++;
      const setup = detectEntryFromIndicators(payload, o);
      if (setup) {
        fired++; totalFired++;
        const size = computeOrderSize(NOTIONAL, 0, o);
        logFire(`[${ts()}] 🎯 WOULD FIRE ${name} | mint ${mint} | pool ${c.pool ?? "?"} | ENTRY ${f(setup.entryPrice)} STOP ${f(setup.stopPrice)} TARGET ${f(setup.targetPrice)} | price@fire ${f(s.close)} | size ${size} SOL | rsi ${f(s.rsi, 1)} | ${setup.reason} | [DRY, no order]`);
      }
    } catch { /* skip candidate */ }
  }
  logBeat(`[${ts()}] cycle ${cycle}: ${candidates.length} candidates, ${bullish} bullish, ${fired} would-fire (total ${totalFired})`);
  const rem = deadline - now();
  if (rem <= 0) break;
  await sleep(Math.min(GAP_MS, rem));
}

logBeat(`[${ts()}] === watch-scan END after ${cycle} cycles. ${totalFired} would-fire event(s). No orders, no SOL. ===`);
