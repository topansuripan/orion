import { test } from "node:test";
import assert from "node:assert";
import { fetchChartIndicatorsForMint } from "./chart-indicators.js";

// Build a minimal fetch Response stand-in for agentMeridianJsonOnce, which
// reads res.ok / res.status / res.statusText / await res.text() and
// res.headers.get("retry-after").
function fakeRes({ ok, status, statusText, body }) {
  return {
    ok,
    status,
    statusText,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    headers: { get: () => null },
  };
}

// A transient relay 429 (Jupiter upstream rate-limit) on the FIRST attempt must
// not drop the candidate — fetchChartIndicatorsForMint must retry and succeed
// once the relay recovers. Regression for: scan candidates skipped on a single
// "Jupiter HTTP 429 Too Many Requests" from /chart-indicators.
test("fetchChartIndicatorsForMint retries past a transient relay 429", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return fakeRes({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        body: { error: "Jupiter HTTP 429 Too Many Requests" },
      });
    }
    return fakeRes({
      ok: true,
      status: 200,
      statusText: "OK",
      body: { mint: "MINT_B", interval: "15_MINUTE", candles: [{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 1 }] },
    });
  };

  try {
    const payload = await fetchChartIndicatorsForMint("MINT_B", { interval: "15_MINUTE" });
    assert.strictEqual(payload.mint, "MINT_B", "returns the relay payload after retry");
    assert.strictEqual(calls, 2, "should retry exactly once past the 429");
  } finally {
    globalThis.fetch = realFetch;
  }
});
