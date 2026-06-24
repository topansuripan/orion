// observe-scan.mjs — READ-ONLY dry observe of Orion's scan + filter pipeline,
// now using the Agent Meridian chart-indicators RELAY (precomputed ST/BB/RSI,
// ~180-266 candles), keyed by token mint. NO wallet, NO SOL, NO orders.
//
// Run: NODE_TLS_REJECT_UNAUTHORIZED=0 DRY_RUN=true node observe-scan.mjs

import { config } from "./config.js";
import { getTopCandidates } from "./tools/screening.js";
import { fetchChartIndicatorsForMint, buildSignalSummary } from "./tools/chart-indicators.js";
import { detectEntryFromIndicators } from "./ta/relay-setups.js";

const LIMIT = Number(process.env.OBSERVE_LIMIT || 10);
const f = (n, d = 8) => (Number.isFinite(n) ? Number(n).toFixed(d) : "n/a");

console.log("=== Orion observe-scan (RELAY indicators, READ-ONLY, no SOL) ===");
const o = config.orion || {};
console.log("interval:", o.indicatorInterval, "| TA:", `ST(${o.supertrendPeriod},${o.supertrendMultiplier}) BB(${o.bbPeriod},${o.bbStdDev}) pullback ${o.pullbackToSupportPct} stop ${o.stopLossPct}`);
console.log("Relay:", config.api?.url, "| serverDiscovery:", !!config.api?.publicApiKey);

let candidates = [];
try {
  console.log(`\nDiscovering candidates (limit ${LIMIT})...`);
  const res = await getTopCandidates({ limit: LIMIT });
  candidates = res?.candidates ?? res ?? [];
  console.log(`Screening returned ${candidates.length} candidate(s) that passed filters.`);
} catch (e) {
  console.error("[screening failed]", e?.message || e);
  if (String(e?.message || e).match(/LEAF_SIGNATURE|self-signed|fetch failed/i))
    console.error(">> Re-run with NODE_TLS_REJECT_UNAUTHORIZED=0");
  process.exit(1);
}

console.log("\n=== Relay indicators + entry detector per candidate ===");
let fired = 0;
for (const c of candidates) {
  const name = c.name || c.symbol || "?";
  const mint = c.base?.mint || c.base_mint;
  if (!mint) { console.log(`- ${name}: no mint`); continue; }
  try {
    const payload = await fetchChartIndicatorsForMint(mint, { interval: o.indicatorInterval });
    const s = buildSignalSummary(payload);
    const n = payload?.candleCount ?? payload?.candles?.length ?? "?";
    const setup = detectEntryFromIndicators(payload, o);
    if (setup) {
      fired++;
      console.log(`\n✅ ${name}  [${n} candles] ST=${s.supertrendDirection} close=${f(s.close)} bbLow=${f(s.lowerBand)} rsi=${f(s.rsi,1)}`);
      console.log(`   ENTRY ${f(setup.entryPrice)}  STOP ${f(setup.stopPrice)}  TARGET ${f(setup.targetPrice)}  — ${setup.reason}`);
    } else {
      console.log(`- ${name}: no setup [${n} candles] ST=${s.supertrendDirection} close=${f(s.close)} bbLow=${f(s.lowerBand)} rsi=${f(s.rsi,1)}`);
    }
  } catch (e) {
    console.log(`- ${name}: relay/TA error — ${e?.message || e}`);
  }
}
console.log(`\n=== Done. ${candidates.length} filtered, ${fired} entry setup(s) fired. Read-only, no orders. ===`);
