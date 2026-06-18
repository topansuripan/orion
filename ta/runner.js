/**
 * ta/runner.js
 *
 * THE single source of truth for the post-TP1 trailing-runner state machine.
 *
 * Both the live engine (orders.js, holding branch) and the paper engine
 * (backtest.js, runner portion) call advanceRunner() for the high-water /
 * trail-arm / trailing-stop / exit decision, so the two engines can never
 * drift. orders.js still owns the market-sell + closeOrder; backtest.js still
 * owns its own fill bookkeeping — only the runner STATE transition lives here.
 *
 * PURE: no I/O, no config import, no mutation of inputs.
 */

/**
 * Advance the trailing-runner state by one price observation.
 *
 * Behavior (the approved live semantics):
 *   - highWater = max(highWater, price)
 *   - arm trailing once price >= entryPrice*(1 + runnerTargetPct)
 *   - while trailing: runnerStop = max(entryPrice, highWater*(1 - runnerTrailPct))
 *     (the breakeven floor — the stop never drops below entry)
 *   - exit = price <= runnerStop  (evaluated against the updated stop)
 *
 * @param {{entryPrice:number, runnerStop:number, highWater:number, runnerTrailing:boolean}} state
 * @param {number} price  the single price to advance against (live: bar/relay CLOSE; backtest: bar close)
 * @param {{runnerTargetPct:number, runnerTrailPct:number}} cfg
 * @returns {{highWater:number, runnerTrailing:boolean, runnerStop:number, exit:boolean}}
 */
export function advanceRunner(state, price, cfg) {
  const entryPrice = state.entryPrice;
  const prevHigh = Number.isFinite(state.highWater) ? state.highWater : entryPrice;
  const runnerTargetPct = cfg.runnerTargetPct ?? 0.6;
  const runnerTrailPct = cfg.runnerTrailPct ?? 0.15;

  const highWater = Number.isFinite(price) && price > prevHigh ? price : prevHigh;

  let runnerTrailing = state.runnerTrailing === true;
  if (
    !runnerTrailing &&
    Number.isFinite(price) &&
    price >= entryPrice * (1 + runnerTargetPct)
  ) {
    runnerTrailing = true;
  }

  let runnerStop = Number.isFinite(state.runnerStop) ? state.runnerStop : entryPrice;
  if (runnerTrailing) {
    // Never below breakeven (entryPrice).
    runnerStop = Math.max(entryPrice, highWater * (1 - runnerTrailPct));
  }

  const exit = Number.isFinite(price) && price <= runnerStop;

  return { highWater, runnerTrailing, runnerStop, exit };
}
