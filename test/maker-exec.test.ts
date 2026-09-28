// Scalper phase 3: maker execution. A post-only limit that waits, then is cancelled; paper fills that need the market
// to trade through the price; and an OKX path that never knowingly leaves an order resting.
import { describe, expect, it } from "vitest";
import { OkxExecutor, SCALP_PREFIX, SimExecutor, UNFILLED } from "../src/exec/executor.js";
import { formatPx, roundToTick } from "../src/exec/sizing.js";
import type { CliCall, OkxCli } from "../src/okx/cli.js";
import type { Instrument, Ticker } from "../src/market/types.js";

const inst: Instrument = { instId: "BTC-USDT-SWAP", coin: "BTC", kind: "crypto", ctVal: 0.01, lotSz: 1, minSz: 1, tickSz: 0.1, state: "live" };
const tk = (bid: number, ask: number, last = (bid + ask) / 2): Ticker => ({ instId: inst.instId, last, bid, ask, mid: (bid + ask) / 2, spreadBp: ((ask - bid) / bid) * 1e4, vol24hUsd: 1e9, open24h: last, ts: 0 });
const req = (over = {}) => ({ instId: inst.instId, side: "buy" as const, contracts: 10, reduceOnly: false, clOrdId: "sc1", px: 100, waitMs: 3000, ...over });

/** A market whose ticker follows a script, one step per poll (the sim executor's sleep advances it). */
function scripted(path: Ticker[], opts: { makerFeeRate?: number; throughBps?: number } = {}) {
  let i = 0;
  let clock = 0;
  const exec = new SimExecutor(
    () => ({ tickers: new Map([[inst.instId, path[Math.min(i, path.length - 1)]!]]), instruments: new Map([[inst.instId, inst]]) }),
    0.0005,
    () => clock,
    { ...opts, pollMs: 1000, sleep: async (ms) => void (clock += ms, i++) },
  );
  return { exec, polls: () => i };
}

describe("tick rounding", () => {
  it("stays passive: a buy rounds down and a sell rounds up", () => {
    expect(roundToTick(100.07, 0.1, "buy")).toBe(100);
    expect(roundToTick(100.03, 0.1, "sell")).toBe(100.1);
    expect(roundToTick(100.1, 0.1, "buy")).toBe(100.1);
    expect(roundToTick(100.1, 0.1, "sell")).toBe(100.1);
    expect(formatPx(100, inst)).toBe("100.0");
  });
});

describe("SimExecutor.limit (paper maker fills)", () => {
  it("a post-only order that would cross the book is refused, as on OKX", async () => {
    const { exec } = scripted([tk(99.9, 100.0)]);
    const r = await exec.limit("bee1", req({ px: 100.0 })); // a buy AT the ask crosses
    expect(r).toMatchObject({ ok: false, state: "rejected", error: { code: "POST_ONLY" } });
    const s = await scripted([tk(99.9, 100.0)]).exec.limit("bee1", req({ side: "sell", px: 99.9 }));
    expect(s).toMatchObject({ ok: false, error: { code: "POST_ONLY" } });
  });

  it("touching the price is not a fill: the market has to trade through it", async () => {
    const touch = scripted([tk(99.9, 100.1), tk(99.9, 100.1, 100.0), tk(100.0, 100.05, 100.0)]);
    expect(await touch.exec.limit("bee1", req({ px: 100.0, waitMs: 2000 }))).toMatchObject({ ok: false, error: { code: UNFILLED } });
    const through = scripted([tk(99.9, 100.1), tk(99.5, 99.9, 99.9), tk(99.0, 99.4, 99.2)]);
    const r = await through.exec.limit("bee1", req({ px: 100.0, waitMs: 5000 }));
    expect(r).toMatchObject({ ok: true, avgPx: 100.0, contracts: 10 });
  });

  it("a sell fills when the bid trades up through it, and pays the maker fee", async () => {
    const { exec } = scripted([tk(99.9, 100.1), tk(100.4, 100.6, 100.5)], { makerFeeRate: 0.0002 });
    const r = await exec.limit("bee1", req({ side: "sell", px: 100.2, reduceOnly: true }));
    expect(r).toMatchObject({ ok: true, avgPx: 100.2 });
    if (r.ok) expect(r.feeUsd).toBeCloseTo(10 * 0.01 * 100.2 * 0.0002, 9);
  });

  it("gives up after its wait, and only then", async () => {
    const { exec, polls } = scripted([tk(99.9, 100.1)]);
    const r = await exec.limit("bee1", req({ px: 99.9, waitMs: 3000 }));
    expect(r).toMatchObject({ ok: false, error: { code: UNFILLED } });
    expect(polls()).toBe(3);
  });

  it("an unknown coin is rejected", async () => {
    const { exec } = scripted([tk(99.9, 100.1)]);
    expect(await exec.limit("bee1", req({ instId: "XXX-USDT-SWAP" }))).toMatchObject({ ok: false, error: { code: "SIM" } });
  });
});

// ---------- OKX through a fake CLI ----------
type Row = Record<string, string>;
function fakeCli(script: { get: Row[]; onPlace?: () => Row[]; open?: Row[] }) {
  const calls: string[][] = [];
  let g = 0;
  const cli: OkxCli = {
    async run<T>(call: CliCall): Promise<T> {
      calls.push(call.args);
      const [a, b] = call.args;
      if (a === "account") return [{ posMode: "net_mode" }] as T;
      if (a === "futures" && b === "leverage") return [{}] as T;
      if (a === "futures" && b === "place") return (script.onPlace?.() ?? [{ sCode: "0", ordId: "77" }]) as T;
      if (a === "futures" && b === "get") return [script.get[Math.min(g++, script.get.length - 1)]!] as T;
      if (a === "futures" && b === "cancel") return [{ sCode: "0" }] as T;
      if (a === "futures" && b === "orders") return (script.open ?? []) as T;
      throw new Error(`unexpected ${call.args.join(" ")}`);
    },
  };
  const exec = new OkxExecutor(cli, { bee1: { apiKey: "k", secretKey: "s", passphrase: "p" } }, true, () => inst, 2);
  return { exec, calls };
}
const filled = (o: Row = {}): Row => ({ state: "filled", ordId: "77", accFillSz: "10", avgPx: "100.0", fee: "-0.002", uTime: "1700000000000", ...o });
const live = (o: Row = {}): Row => ({ state: "live", ordId: "77", accFillSz: "0", avgPx: "", fee: "0", ...o });

describe("OkxExecutor.limit", () => {
  it("places a post-only limit at the tick-rounded price and returns the fill with the exchange's fee", async () => {
    const { exec, calls } = fakeCli({ get: [live(), filled()] });
    const r = await exec.limit("bee1", req({ px: 100.07, waitMs: 5000 }));
    expect(r).toMatchObject({ ok: true, contracts: 10, avgPx: 100, feeUsd: 0.002, ordId: "77" });
    const place = calls.find((c) => c[1] === "place")!;
    expect(place).toEqual(expect.arrayContaining(["--ordType", "post_only", "--px", "100.0", "--sz", "10", "--tdMode", "isolated", "--clOrdId", "sc1"]));
    expect(place).not.toContain("--reduceOnly");
  });

  it("an exit carries reduceOnly", async () => {
    const { exec, calls } = fakeCli({ get: [filled()] });
    await exec.limit("bee1", req({ side: "sell", reduceOnly: true }));
    expect(calls.find((c) => c[1] === "place")).toContain("--reduceOnly");
    expect(calls.some((c) => c[1] === "leverage")).toBe(false);
  });

  it("an order the exchange cancelled at once (it would have crossed) is a rejection, not a fill", async () => {
    const { exec } = fakeCli({ get: [{ state: "canceled", accFillSz: "0", ordId: "77" }] });
    expect(await exec.limit("bee1", req())).toMatchObject({ ok: false, state: "rejected", error: { code: "POST_ONLY" } });
  });

  it("on timeout it cancels, reads the final state, and reports UNFILLED when nothing traded", async () => {
    const { exec, calls } = fakeCli({ get: [live(), live(), { state: "canceled", accFillSz: "0", ordId: "77" }] });
    const r = await exec.limit("bee1", req({ waitMs: 1 }));
    expect(r).toMatchObject({ ok: false, state: "rejected", error: { code: UNFILLED } });
    expect(calls.filter((c) => c[1] === "cancel")).toHaveLength(1);
    expect(calls.find((c) => c[1] === "cancel")).toEqual(["futures", "cancel", inst.instId, "--clOrdId", "sc1"]);
  });

  it("a fill that lands while cancelling is reported as the fill it is (partial included)", async () => {
    const { exec } = fakeCli({ get: [live(), { state: "canceled", accFillSz: "4", avgPx: "100.0", fee: "-0.001", ordId: "77" }] });
    const r = await exec.limit("bee1", req({ waitMs: 1 }));
    expect(r).toMatchObject({ ok: true, contracts: 4, avgPx: 100 });
  });

  it("if the final state cannot be read the result is unknown, so reconciliation settles it", async () => {
    const { exec } = fakeCli({ get: [live()] });
    const r = await exec.limit("bee1", req({ waitMs: 1 }));
    expect(r).toMatchObject({ ok: false, state: "unknown", error: { code: "UNCONFIRMED" } });
  });

  it("an exchange rejection at placement is a rejection", async () => {
    const { exec } = fakeCli({ get: [], onPlace: () => [{ sCode: "51008", sMsg: "insufficient margin" }] });
    expect(await exec.limit("bee1", req())).toMatchObject({ ok: false, state: "rejected", error: { code: "51008" } });
  });

  it("init cancels leftover scalper orders after a crash, and only those", async () => {
    const { exec, calls } = fakeCli({ get: [], open: [{ clOrdId: `${SCALP_PREFIX}abc`, instId: inst.instId }, { clOrdId: "manual-1", instId: inst.instId }, { clOrdId: "be1x", instId: inst.instId }] });
    await exec.init("bee1");
    const cancels = calls.filter((c) => c[1] === "cancel");
    expect(cancels).toEqual([["futures", "cancel", inst.instId, "--clOrdId", "scabc"]]);
  });
});
