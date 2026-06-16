# Orion

Orion is an autonomous limit-order TA "sniper" agent for Meteora DLMM pools on Solana — the third agent in the **Meridian / Polaris / Orion** fleet.

It:

1. **Auto-screens** liquid Meteora DLMM pools for tradable setups.
2. Runs **deterministic technical analysis** (SuperTrend + Bollinger Bands) on each candidate.
3. Places **Meteora single-bin limit orders** at TA-derived entry prices.
4. Protects fills with a **Jupiter market stop-loss**.

Unlike Meridian (LP yield) and Polaris, Orion is purely directional: enter on signal, exit on target or stop.

## Usage

```bash
cp .env.example .env   # then fill in WALLET_PRIVATE_KEY + RPC_URL
npm install
npm start              # or: npm run dev  (DRY_RUN=true)
```

Runtime config lives in `orion-config.json` and runtime state in `orion-state.json` (both gitignored).

## ⚠️ Requirements / Known caveats

- **Requires `@meteora-ag/dlmm@^1.9.8`** — this is the version that added the limit-order functions Orion depends on. Older versions will not work.
- **`npm install` currently fails in this environment** with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. Fix npm's cert config before installing — e.g. `npm config set cafile <root-ca.pem>` to trust your network's root CA, or run the install on a non-intercepted network.
- **Use a SEPARATE wallet** from the other two fleet agents (Meridian / Polaris). Sharing a wallet makes the agents collide on the same funds.
