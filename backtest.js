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
 *   • EXIT — SCALE-OUT + TRAILING RUNNER (mirrors live orders.js):
 *       Each bar AFTER the fill bar, in priority order:
 *       BEFORE TP1 fills:
 *         1. STOP first: `low <= stopPrice` OR detectBreakdown(slice,pos,cfg)
 *            → the WHOLE position exits at stopPrice → LOSS (combined return is
 *            the full-position loss). Stop is checked before target so a bar
 *            straddling both is conservatively a loss.
 *         2. TARGET: `high >= targetPrice` → TP1: HALF (scaleOutPct) is banked
 *            at targetPrice, the runner stop moves to BREAKEVEN (entryPrice),
 *            highWater initialises to entryPrice. No exit yet — runner holds.
 *       AFTER TP1 (runner half only):
 *         - highWater ratchets up with bar.h.
 *         - Once bar.h >= entry*(1+runnerTargetPct) the 15% trailing stop arms.
 *         - While trailing, runnerStop = max(entry, highWater*(1-runnerTrailPct))
 *           (never below breakeven). Trail is updated BEFORE the stop check so
 *           the runner can ratchet up on the same bar it later pulls back.
 *         - If bar.l <= runnerStop the runner exits at runnerStop. The trade is
 *           a WIN with combined return = half@target + half@runnerStop.
 *     The fill bar itself is never used for an exit (lookahead-free).
 *
 * RETURNS
 *   returnPct per trade = the COMBINED position return, summing the scaled
 *   contributions of the TP1 half and the runner half:
 *     scaleOutPct*(tp1Exit-entry)/entry + (1-scaleOutPct)*(runnerExit-entry)/entry
 *   (a full-position stop before TP1 is simply (stop-entry)/entry). A fraction;
 *   0.2 == +20%.
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

  const scaleOutPct = cfg.scaleOutPct ?? 0.5;
  const runnerTargetPct = cfg.runnerTargetPct ?? 0.6;
  const runnerTrailPct = cfg.runnerTrailPct ?? 0.15;

  // Simulation state machine: FLAT → ARMED → HOLDING → FLAT.
  let armed = null; // { entryPrice, stopPrice, targetPrice }
  // position adds runner fields: tp1Filled, runnerStop, highWater, runnerTrailing.
  let position = null;

  for (let i = 0; i < candles.length; i++) {
    const slice = candles.slice(0, i + 1); // past + current only — no lookahead
    const bar = candles[i];

    if (position) {
      // HOLDING: never exit on the same bar we filled.
      if (i === position.entryIndex) continue;

      if (!position.tp1Filled) {
        // BEFORE TP1: STOP (priority) — whole position exits at stop → LOSS.
        const stopHit =
          bar.l <= position.stopPrice ||
          detectBreakdown(slice, position, cfg) === true;
        if (stopHit) {
          trades.push(makeStopTrade(position, i));
          position = null;
          armed = null;
          continue;
        }

        // TARGET → TP1: bank the half, move runner stop to breakeven, hold.
        if (bar.h >= position.targetPrice) {
          position.tp1Filled = true;
          position.runnerStop = position.entryPrice; // breakeven
          position.highWater = position.entryPrice;
          position.runnerTrailing = false;
          // No exit on the TP1 bar — runner resolves on a later bar.
          continue;
        }

        continue; // before TP1, neither stop nor target → hold
      }

      // AFTER TP1 (runner half only).
      // 1) Ratchet the high-water mark up with this bar's high.
      if (bar.h > position.highWater) position.highWater = bar.h;
      // 2) Arm the trailing stop once the runner reaches +runnerTargetPct.
      if (!position.runnerTrailing && bar.h >= position.entryPrice * (1 + runnerTargetPct)) {
        position.runnerTrailing = true;
      }
      // 3) While trailing, ratchet the runner stop up (never below breakeven).
      if (position.runnerTrailing) {
        position.runnerStop = Math.max(
          position.entryPrice,
          position.highWater * (1 - runnerTrailPct),
        );
      }
      // 4) Stop check (breakdown OR trailing/breakeven stop touch) → runner out.
      const runnerHit =
        bar.l <= position.runnerStop ||
        detectBreakdown(slice, { entryPrice: position.entryPrice, stopPrice: position.runnerStop }, cfg) === true;
      if (runnerHit) {
        trades.push(makeRunnerTrade(position, i, scaleOutPct));
        position = null;
        armed = null;
        continue;
      }

      continue; // runner still holding
    }

    // Not holding. If we have an armed order, try to fill it on this bar.
    if (armed) {
      if (bar.l <= armed.entryPrice) {
        position = {
          entryPrice: armed.entryPrice,
          stopPrice: armed.stopPrice,
          targetPrice: armed.targetPrice,
          entryIndex: i,
          // runner lifecycle
          tp1Filled: false,
          runnerStop: armed.stopPrice, // original hard stop until TP1
          highWater: armed.entryPrice,
          runnerTrailing: false,
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

// Full-position stop BEFORE TP1: the whole position exits at the hard stop.
function makeStopTrade(position, exitIndex) {
  const { entryPrice, entryIndex, stopPrice } = position;
  const returnPct = (stopPrice - entryPrice) / entryPrice;
  return {
    entryIndex,
    exitIndex,
    entryPrice,
    exitPrice: stopPrice,
    tp1ExitPrice: null,
    runnerExitPrice: stopPrice,
    returnPct,
    outcome: "loss",
  };
}

// Runner exit AFTER TP1: half banked at target, runner half at runnerStop.
// Combined return weights each half by its size. A WIN whenever TP1 filled
// (the banked half is always +; the runner is breakeven-or-better).
function makeRunnerTrade(position, exitIndex, scaleOutPct) {
  const { entryPrice, entryIndex, targetPrice, runnerStop } = position;
  const tp1Ret = (targetPrice - entryPrice) / entryPrice;
  const runnerRet = (runnerStop - entryPrice) / entryPrice;
  const returnPct = scaleOutPct * tp1Ret + (1 - scaleOutPct) * runnerRet;
  return {
    entryIndex,
    exitIndex,
    entryPrice,
    exitPrice: runnerStop, // final (runner) exit price
    tp1ExitPrice: targetPrice,
    runnerExitPrice: runnerStop,
    returnPct,
    outcome: "win",
  };
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
