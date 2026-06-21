// live-mode.js — pure resolution of the live-trading kill-switch.
// Live trading requires BOTH DRY_RUN=false AND LIVE_TRADING=true (two deliberate acts).
// If DRY_RUN=false but LIVE_TRADING!=true, we FORCE dry (fail-safe) and warn.
export function resolveLiveMode(env = process.env) {
  const dryRunFalse = env.DRY_RUN === "false";
  const liveOptIn = env.LIVE_TRADING === "true";
  const live = dryRunFalse && liveOptIn;
  const forceDry = dryRunFalse && !liveOptIn;
  let warning = null;
  if (forceDry) {
    warning = "DRY_RUN=false but LIVE_TRADING is not 'true' — refusing to trade live; forcing DRY_RUN. Set LIVE_TRADING=true to arm live trading.";
  }
  return { live, forceDry, warning };
}
