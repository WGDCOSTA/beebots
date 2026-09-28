// CoinMarketCap context (market/cmc.ts): parsing, budget, failures, and what Jev and the brains get.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { coinInfos, coinEvidence } from "../src/brains/watchlist.js";
import { checkCmcKey, CmcSource, jevMarketLine, loadMood, marketMood, saveMood } from "../src/market/cmc.js";
import { coin, view } from "./fixtures.js";

const KEY = "0000aaaa-1111-2222-3333-444455556666";
const LISTINGS = {
  status: { error_code: 0 },
  data: [
    { symbol: "BTC", cmc_rank: 1, quote: { USD: { market_cap: 1.9e12, volume_24h: 4.1e10, percent_change_1h: 0.1, percent_change_24h: 1.5, percent_change_7d: 4, percent_change_30d: 12.34 } } },
    { symbol: "SOL", cmc_rank: 5, quote: { USD: { market_cap: 8.2e10, volume_24h: 3.3e9, percent_change_24h: -2.2, percent_change_30d: -8 } } },
    { symbol: "SOL", cmc_rank: 900, quote: { USD: { market_cap: 1e6 } } },
  ],
};
const GLOBAL = { status: { error_code: 0 }, data: { btc_dominance: 57.345, eth_dominance: 11.2, quote: { USD: { total_market_cap: 3.4e12, total_volume_24h: 1.1e11, total_market_cap_yesterday_percentage_change: -1.234 } } } };
const FNG = { status: { error_code: 0 }, data: { value: 38, value_classification: "Fear" } };

function fakeFetch(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const f = (async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const path = new URL(url).pathname;
    const body = path in overrides ? overrides[path] : path.includes("listings") ? LISTINGS : path.includes("global") ? GLOBAL : path.includes("fear") ? FNG : { status: { error_code: 0 } };
    if (body instanceof Error) throw body;
    const status = (body as { httpStatus?: number }).httpStatus ?? 200;
    return { ok: status < 400, status, json: async () => body } as Response;
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("CmcSource", () => {
  it("reads listings, global metrics and Fear & Greed; the key only travels in the header", async () => {
    const { f, calls } = fakeFetch();
    const src = new CmcSource({ apiKey: KEY, fetch: f, top: 50, now: () => 1_700_000_000_000 });
    const s = (await src.refresh())!;
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/v1/cryptocurrency/listings/latest", "/v1/global-metrics/quotes/latest", "/v3/fear-and-greed/latest"]);
    expect(calls[0]!.url).toContain("limit=50");
    expect(calls.every((c) => c.headers["X-CMC_PRO_API_KEY"] === KEY && !c.url.includes(KEY))).toBe(true);
    expect(s.coins.get("BTC")).toMatchObject({ rank: 1, mcapUsd: 1.9e12, pct30d: 12.34 });
    expect(s.coins.get("SOL")!.rank).toBe(5); // the best-ranked coin keeps a shared ticker
    expect(s.global).toMatchObject({ btcDominancePct: 57.345, mcapChange24hPct: -1.234 });
    expect(s.fearGreed).toEqual({ value: 38, label: "Fear" });
    expect(jevMarketLine(s)).toEqual({ fear_greed: 38, btc_dom_pct: 57.3, mcap_24h_pct: -1.23 });
    expect(marketMood(s)).toMatchObject({ source: "CoinMarketCap", fearGreed: "38 (Fear)", totalMcapTusd: 3.4 });
  });

  it("keeps the last good part when one call fails, and goes stale after 2 hours", async () => {
    let t = 1_700_000_000_000;
    const ok = fakeFetch();
    const src = new CmcSource({ apiKey: KEY, fetch: ok.f, now: () => t });
    await src.refresh();
    const bad = fakeFetch({ "/v3/fear-and-greed/latest": { httpStatus: 429, status: { error_code: 1008, error_message: "rate limit" } } });
    (src as unknown as { f: typeof fetch }).f = bad.f;
    t += 60_000;
    const s = (await src.refresh())!;
    expect(s.fearGreed).toEqual({ value: 38, label: "Fear" });
    expect(src.status().error).toMatch(/fear&greed: CoinMarketCap 429: rate limit/);
    t += 3 * 3_600_000;
    expect(src.get()).toBeNull();
    expect(jevMarketLine(null)).toBeNull();
  });

  it("stops at the daily call budget", async () => {
    const { f, calls } = fakeFetch();
    const src = new CmcSource({ apiKey: KEY, fetch: f, maxCallsDay: 4, now: () => 1_700_000_000_000 });
    await src.refresh();
    await src.refresh();
    expect(calls).toHaveLength(4);
    expect(src.status()).toMatchObject({ callsToday: 4, maxCallsDay: 4 });
    expect(src.status().error).toMatch(/budget/);
  });

  it("checks a key with the free key/info call", async () => {
    expect(await checkCmcKey(KEY, fakeFetch().f)).toBeNull();
    const refused = fakeFetch({ "/v1/key/info": { httpStatus: 401, status: { error_code: 1001, error_message: "This API Key is invalid." } } });
    expect(await checkCmcKey("bad-key-000", refused.f)).toMatch(/refused the key \(401: This API Key is invalid\.\)/);
    expect(await checkCmcKey(KEY, fakeFetch({ "/v1/key/info": new Error("offline") }).f)).toMatch(/could not be reached/);
  });

  it("saves the mood for the lab's CLI council", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cmc-"));
    const now = Date.now();
    const src = new CmcSource({ apiKey: KEY, fetch: fakeFetch().f, now: () => now, onUpdate: (s) => saveMood(dir, s) });
    await src.refresh();
    expect(loadMood(dir, now)).toMatchObject({ fearGreed: "38 (Fear)" });
    expect(loadMood(dir, now + 3 * 3_600_000)).toBeNull();
  });
});

describe("CoinMarketCap in the brains' evidence", () => {
  it("adds rank, market cap and all-exchange volume to each known coin", async () => {
    const src = new CmcSource({ apiKey: KEY, fetch: fakeFetch().f });
    const s = await src.refresh();
    const v = view([coin("BTC", {}, 80000), coin("SOL", {}, 150), coin("DOGE", {}, 0.1)]);
    const infos = coinInfos(v, 40, s);
    expect(infos.find((c) => c.coin === "BTC")!.cmc).toEqual({ rank: 1, mcapMusd: 1_900_000, volAllMusd: 41_000, pct24h: 1.5, pct30d: 12.3 });
    expect(infos.find((c) => c.coin === "DOGE")!.cmc).toBeUndefined();
    const ev = coinEvidence({ candidates: ["SOL", "DOGE"], ranking: null, adoptedSkills: [], record: [], universe: infos });
    expect(ev[0]!.live!.cmc).toMatchObject({ rank: 5 });
    expect(ev[1]!.live!.cmc).toBeUndefined();
    expect(coinInfos(v).every((c) => c.cmc === undefined)).toBe(true);
  });
});

describe("CoinMarketCap in Jev's state", () => {
  async function run(env: Record<string, string>) {
    const { Alerts } = await import("../src/alerts.js");
    const { Db } = await import("../src/db.js");
    const { Engine } = await import("../src/engine.js");
    const { EventBus } = await import("../src/events.js");
    const { SimExecutor } = await import("../src/exec/executor.js");
    const { Jev } = await import("../src/jev.js");
    const { NOW, testConfig } = await import("./fixtures.js");
    const cfg = testConfig({ DRY_RUN: "true", ...env });
    const v = view([coin("BTC", { ret24hPct: 3, ret7dPct: 9 }, 80000), coin("SOL", { ret24hPct: 12, ret7dPct: 40 }, 150), coin("ETH", { ret24hPct: 2, ret7dPct: 5 }, 3000)]);
    const feed = { view: () => v, refresh: async () => {}, refreshTickers: async () => {}, lastRefreshAt: NOW } as never;
    const seen: string[] = [];
    const client = {
      async systemOne(req: unknown) {
        seen.push(JSON.stringify(req));
        return { model: "fake", usage: { input_tokens: 1, output_tokens: 0 }, answers: { action: { type: "choice", choice: "NOPE", confidence: 1, probabilities: { NOPE: 1 } }, conviction: { type: "score", score: 1, confidence: 1, legend: {}, probabilities: {} } } } as never;
      },
    };
    const src = new CmcSource({ apiKey: KEY, fetch: fakeFetch().f, now: () => NOW });
    await src.refresh();
    const db = new Db(":memory:");
    const engine = new Engine({ cfg, db, feed, jev: new Jev({ ...cfg.jev, client, now: () => NOW }), exec: new SimExecutor(() => v, cfg.risk.takerFeeRate), bus: new EventBus(db), alerts: new Alerts(undefined), now: () => NOW, cmc: () => src.get() });
    await engine.start();
    engine.stop();
    await engine.tick();
    return { seen, system: engine.snapshot().system };
  }

  it("crypto bees see the mkt line and the note; the system bar gets the mood", async () => {
    const { seen, system } = await run({});
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((s) => s.includes('\\"fear_greed\\":38') || s.includes('"fear_greed":38'))).toBe(true);
    expect(seen.some((s) => s.includes("CoinMarketCap"))).toBe(true);
    expect(system.cmc).toMatchObject({ fearGreed: { value: 38, label: "Fear" }, btcDominancePct: 57.3 });
  });

  it("CMC_IN_JEV=false keeps it out of Jev's state", async () => {
    const { seen } = await run({ CMC_IN_JEV: "false" });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((s) => s.includes("fear_greed"))).toBe(false);
  });
});
