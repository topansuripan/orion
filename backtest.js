/**
 * backtest.js
 *
 * PURE walk-forward backtest harness for Orion's deterministic TA strategy.
 *
 * It replays an OHLCV candle array through the SAME entry/exit logic used in
 * live trading (`ta/setups.js` → detectEntry / detectBreakdown), so a strategy
 * can be validated on history before risking funds.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * NO LOOKAHEAD
 * At each step i, the simulator only ever looks at the past+current slice
 * `candles.slice(0, i + 1)`. detectEntry / detectBreakdown never see a future
 * bar. Fills and exits at bar i use only bar i's own o/h/l/c.
 *
 * FILL / EXIT MODEL (chosen, single, documented)
 *   • At most ONE open simulated position at a time (v1 simplicity).
 *   • ENTRY (arm-then-fill limit buy):
 *       - When FLAT, detectEntry(slice, cfg) on bar i may return a setup.
 *         The entry is ARMED (entryPrice/stopPrice/targetPrice recorded), but
 *         NOT filled on the signal bar — a limit buy sits at/below support.
 *       - On a SUBSEQUENT bar j (> signal bar) where `low <= entryPrice`,
 *         the buy fills at exactly entryPrice. The position's entryIndex is j
 *         (the fill bar). If a fresh entry signal re-arms while still waiting,
 *         the latest setup's prices replace the armed order.
 *   • EXIT (checked each bar AFTER the fill bar, priority order):
 *       1. STOP first: if `low <= stopPrice` OR detectBreakdown(slice,pos,cfg)
 *          → exit at stopPrice → LOSS. (Stop is checked before target so a bar
 *          that straddles both is treated conservatively as a loss.)
 *       2. TARGET: else if `high >= targetPrice` → exit at targetPrice → WIN.
 *     The fill bar itself is not used for an exit (entry and exit never share a
 *     bar) — keeps the model unambiguous and lookahead-free.
 *
 * RETURNS
 *   returnPct per trade = (exitPrice - entryPrice) / entryPrice  (a fraction;
 *   0.2 == +20%).
 *   totalReturnPct = SIMPLE SUM of per-trade returnPct (NOT compounded). This
 *   is a deliberate v1 choice: simple sum is order-independent and easy to
 *   reason about; compounding can be layered on later if position sizing is
 *   modeled.
 *
 * An armed-but-never-filled order, and a filled position still open at the end
 * of the data, produce NO trade (only completed round-trips are recorded).
 * ───────────────────────────────────────────────────────────────────────────
 */

import { detectEntry, detectBreakdown } from "./ta/setups.js";

/**
 * @param {Array<{t:number,o:number,h:number,l:number,c:number,v:number}>} candles
 * @param {object} cfg orion config slice
 * @returns {{trades:Array, winRate:number, totalReturnPct:number, count:number}}
 */
export function backtest(candles, cfg) {
  const trades = [];

  if (!Array.isArray(candles) || candles.length === 0) {
    return { trades, winRate: 0, totalReturnPct: 0, count: 0 };
  }

  // Simulation state machine: FLAT → ARMED → HOLDING → FLAT.
  let armed = null; // { entryPrice, stopPrice, targetPrice }
  let position = null; // { entryPrice, stopPrice, targetPrice, entryIndex }

  for (let i = 0; i < candles.length; i++) {
    const slice = candles.slice(0, i + 1); // past + current only — no lookahead
    const bar = candles[i];

    if (position) {
      // HOLDING: never exit on the same bar we filled.
      if (i === position.entryIndex) continue;

      // 1) STOP (priority): explicit stop touch OR breakdown signal.
      const stopHit =
        bar.l <= position.stopPrice ||
        detectBreakdown(slice, position, cfg) === true;

      if (stopHit) {
        const exitPrice = position.stopPrice;
        trades.push(makeTrade(position, i, exitPrice, "loss"));
        position = null;
        armed = null;
        continue;
      }

      // 2) TARGET.
      if (bar.h >= position.targetPrice) {
        const exitPrice = position.targetPrice;
        trades.push(makeTrade(position, i, exitPrice, "win"));
        position = null;
        armed = null;
        continue;
      }

      continue; // still holding
    }

    // Not holding. If we have an armed order, try to fill it on this bar.
    if (armed) {
      if (bar.l <= armed.entryPrice) {
        position = {
          entryPrice: armed.entryPrice,
          stopPrice: armed.stopPrice,
          targetPrice: armed.targetPrice,
          entryIndex: i,
        };
        armed = null;
        continue; // filled this bar; exits begin next bar
      }
      // else: order stays armed; fall through to allow re-arming below.
    }

    // FLAT (or armed & unfilled): look for a (possibly newer) entry signal.
    const setup = detectEntry(slice, cfg);
    if (setup && Number.isFinite(setup.entryPrice)) {
      armed = {
        entryPrice: setup.entryPrice,
        stopPrice: setup.stopPrice,
        targetPrice: setup.targetPrice,
      };
    }
  }

  const count = trades.length;
  const wins = trades.filter((t) => t.outcome === "win").length;
  const winRate = count > 0 ? wins / count : 0;
  const totalReturnPct = trades.reduce((sum, t) => sum + t.returnPct, 0);

  return { trades, winRate, totalReturnPct, count };
}

function makeTrade(position, exitIndex, exitPrice, outcome) {
  const { entryPrice, entryIndex } = position;
  const returnPct = (exitPrice - entryPrice) / entryPrice;
  return { entryIndex, exitIndex, entryPrice, exitPrice, returnPct, outcome };
}

// ───────────────────────────────────────────────────────────────────────────
// Runnable CLI (manual use only; NOT exercised by `node --test`).
//   node backtest.js <poolAddress> [timeframe] [candles]
// Fetches real candles via meteora/ohlcv.js and prints a summary.
// Guarded so importing this module (e.g. from tests) never triggers network.
// ───────────────────────────────────────────────────────────────────────────
async function main() {
  const [poolAddress, timeframe, candleCount] = process.argv.slice(2);
  if (!poolAddress) {
    console.error("Usage: node backtest.js <poolAddress> [timeframe] [candles]");
    process.exit(1);
  }

  const { fetchOhlcv } = await import("./meteora/ohlcv.js");
  const { config } = await import("./config.js");
  const cfg = config.orion;

  const candles = await fetchOhlcv(poolAddress, {
    timeframe: timeframe ?? cfg.ohlcvTimeframe,
    candles: candleCount ? Number(candleCount) : cfg.candles,
  });

  const res = backtest(candles, cfg);

  console.log(`\nBacktest — pool ${poolAddress}`);
  console.log(`  candles:        ${candles.length}`);
  console.log(`  trades:         ${res.count}`);
  console.log(`  winRate:        ${(res.winRate * 100).toFixed(1)}%`);
  console.log(`  totalReturnPct: ${(res.totalReturnPct * 100).toFixed(2)}%`);
  for (const t of res.trades) {
    console.log(
      `    [${t.outcome}] entry@${t.entryPrice.toFixed(6)} (bar ${t.entryIndex})` +
        ` → exit@${t.exitPrice.toFixed(6)} (bar ${t.exitIndex})` +
        ` = ${(t.returnPct * 100).toFixed(2)}%`,
    );
  }
}

// ESM entrypoint guard: only run main() when executed directly, not on import.
if (
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`
) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
