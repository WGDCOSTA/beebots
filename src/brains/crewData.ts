// The crew's data tools (brains/crew.ts): what each member reads every round. Plain JSON, numbers rounded, nothing secret.
//   owlData: each bunny's numbers, its last day of calls (waits, opens, holds, vetoes, confidence) and its latest trades.
//   ratData: the whole market, from CoinMarketCap (mood, season, dominance, sectors, top movers) and OKX (moves, funding,
//            open interest, RSI, volatility) as the engine's market board already has them.
//   pigData: the books, per bunny and for the warren: realised P&L, fees, funding, model spend, trades, budgets and their use.
import type { DatabaseSync } from "node:sqlite";
import { marketMood, type CmcState } from "../market/cmc.js";

const DAY = 86_400_000;
const r2 = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);

/** The parts of the engine's snapshot the crew reads (engine.snapshot()). */
export interface CrewSnapshot {
  startEquityUsd: number;
  bees: Array<{
    bee: string;
    equityUsd: number;
    startEquityUsd?: number;
    pnlUsd: number;
    pnlPct: number;
    position: { coin: string; side: string; sizeUsd: number | null; uplUsd: number; minutesHeld: number } | null;
    tradesToday: number;
    maxTradesPerDay: number;
    feesTodayUsd: number;
    feeBudgetUsd: number;
    cap: string | null;
    totals: { feesUsd: number; fundingUsd: number; jevUsd: number; realisedUsd: number; decisions: number; orders: number };
    last?: { choice: string | null; confidence: number | null; status: string } | null;
  }>;
  jev: { spentTodayUsd: number; dailyCapUsd: number; capTripped: boolean; down: boolean };
  market: { board?: Array<{ coin: string; kind: string; px: number; ret1hPct: number | null; ret24hPct: number | null; ret7dPct: number | null; vol24hUsd: number; spreadBp: number | null; atrPct: number | null; rsi: number | null; fundingPct: number | null; oiUsd: number | null; cmcRank: number | null }> };
}

export interface CrewBee {
  slot: string;
  name: string;
  style: string;
  coins: string[];
  rules: string;
}

/** The coach's view of each bunny: its numbers, its last day of calls and its latest trades. */
export function owlData(raw: DatabaseSync, snap: CrewSnapshot, bees: CrewBee[], now: number): unknown {
  return {
    bunnies: bees.map((b) => {
      const s = snap.bees.find((x) => x.bee === b.slot);
      const calls = raw
        .prepare(
          `SELECT choice, status, confidence, vetoed_by AS vetoed, forced_by AS forced FROM decisions WHERE bee = ? AND ts >= ? ORDER BY ts DESC LIMIT 400`,
        )
        .all(b.slot, now - DAY) as Array<{ choice: string | null; status: string | null; confidence: number | null; vetoed: string | null; forced: string | null }>;
      const kinds = new Map<string, number>();
      for (const c of calls) {
        const k = (c.choice ?? c.status ?? "none").split("_")[0]!.toUpperCase();
        kinds.set(k, (kinds.get(k) ?? 0) + 1);
      }
      const conf = calls.map((c) => c.confidence).filter((x): x is number => x !== null);
      const trades = raw
        .prepare(`SELECT ts, inst_id AS inst, side, realised_usd AS realised, fee_usd AS fee FROM fills WHERE bee = ? AND realised_usd != 0 ORDER BY ts DESC LIMIT 8`)
        .all(b.slot) as Array<{ ts: number; inst: string; side: string; realised: number; fee: number }>;
      return {
        slot: b.slot,
        name: b.name,
        style: b.style,
        coins: b.coins,
        rules: b.rules,
        equityUsd: r2(s?.equityUsd),
        pnlPct: r2(s?.pnlPct),
        position: s?.position ? `${s.position.side} ${s.position.coin}, ${r2(s.position.uplUsd)} USD open, ${s.position.minutesHeld} min` : "flat",
        benched: s?.cap ?? null,
        tradesToday: s ? `${s.tradesToday}/${s.maxTradesPerDay}` : null,
        callsLast24h: { total: calls.length, byKind: Object.fromEntries(kinds), avgConfidence: conf.length ? r2(conf.reduce((a, x) => a + x, 0) / conf.length) : null, vetoed: calls.filter((c) => c.vetoed).length, forcedByRules: calls.filter((c) => c.forced).length },
        lastCall: s?.last ? { choice: s.last.choice, confidence: r2(s.last.confidence), status: s.last.status } : null,
        recentClosedTrades: trades.map((t) => ({ hoursAgo: r2((now - t.ts) / 3_600_000), coin: t.inst.split("-")[0], side: t.side, netUsd: r2(t.realised - t.fee) })),
      };
    }),
  };
}

/** The analyst's view of the market: CoinMarketCap's mood and movers, and the exchange's board. */
export function ratData(snap: CrewSnapshot, cmc: CmcState | null): unknown {
  const board = (snap.market.board ?? []).filter((c) => c.kind === "crypto");
  const by = (k: "ret24hPct" | "ret7dPct" | "fundingPct", dir: 1 | -1, n = 5) =>
    board
      .filter((c) => c[k] !== null)
      .sort((a, b) => ((b[k] as number) - (a[k] as number)) * dir)
      .slice(0, n)
      .map((c) => ({ coin: c.coin, [k]: r2(c[k]), ret24hPct: r2(c.ret24hPct), fundingPct: r2(c.fundingPct), rsi: r2(c.rsi), atrPct: r2(c.atrPct), volMusd: r2(c.vol24hUsd / 1e6) }));
  const movers = cmc
    ? [...cmc.coins.values()]
        .filter((c) => c.rank <= 150 && c.pct24h !== null)
        .sort((a, b) => (b.pct24h as number) - (a.pct24h as number))
    : [];
  const breadth = board.filter((c) => c.ret24hPct !== null);
  return {
    coinMarketCap: marketMood(cmc),
    topMovers24h: movers.slice(0, 6).map((c) => ({ coin: c.symbol, rank: c.rank, pct24h: r2(c.pct24h), pct7d: r2(c.pct7d) })),
    bottomMovers24h: movers.slice(-6).reverse().map((c) => ({ coin: c.symbol, rank: c.rank, pct24h: r2(c.pct24h), pct7d: r2(c.pct7d) })),
    okx: {
      coins: board.length,
      breadth24h: { up: breadth.filter((c) => (c.ret24hPct as number) > 0).length, down: breadth.filter((c) => (c.ret24hPct as number) < 0).length },
      majors: board.filter((c) => ["BTC", "ETH", "SOL"].includes(c.coin)).map((c) => ({ coin: c.coin, px: c.px, ret1hPct: r2(c.ret1hPct), ret24hPct: r2(c.ret24hPct), ret7dPct: r2(c.ret7dPct), fundingPct: r2(c.fundingPct), rsi: r2(c.rsi), atrPct: r2(c.atrPct), oiMusd: c.oiUsd === null ? null : r2(c.oiUsd / 1e6) })),
      strongest7d: by("ret7dPct", 1),
      weakest7d: by("ret7dPct", -1),
      highestFunding: by("fundingPct", 1),
      lowestFunding: by("fundingPct", -1),
    },
  };
}

/** The accountant's books: per bunny and for the warren, all time and the last day and week, and the budgets. */
export function pigData(raw: DatabaseSync, snap: CrewSnapshot, names: Record<string, string>, now: number, extra: Record<string, unknown> = {}): unknown {
  const window = (slot: string, since: number) => {
    const f = raw.prepare(`SELECT COALESCE(SUM(fee_usd),0) AS fees, COALESCE(SUM(realised_usd),0) AS realised, COALESCE(SUM(CASE WHEN realised_usd != 0 THEN 1 ELSE 0 END),0) AS closes FROM fills WHERE bee = ? AND ts >= ?`).get(slot, since) as { fees: number; realised: number; closes: number };
    const fu = raw.prepare(`SELECT COALESCE(SUM(amount_usd),0) AS funding FROM funding WHERE bee = ? AND ts >= ?`).get(slot, since) as { funding: number };
    const jev = raw.prepare(`SELECT COALESCE(SUM(jev_cost_usd),0) AS jev, COUNT(*) AS calls FROM decisions WHERE bee = ? AND ts >= ?`).get(slot, since) as { jev: number; calls: number };
    return { realisedUsd: r2(f.realised), feesUsd: r2(f.fees), fundingUsd: r2(fu.funding), modelUsd: r2(jev.jev), decisions: jev.calls, closedTrades: f.closes, netUsd: r2(f.realised - f.fees + fu.funding - jev.jev) };
  };
  const bunnies = snap.bees.map((b) => ({
    slot: b.bee,
    name: names[b.bee] ?? b.bee,
    equityUsd: r2(b.equityUsd),
    startUsd: r2(b.startEquityUsd ?? snap.startEquityUsd),
    pnlUsd: r2(b.pnlUsd),
    pnlPct: r2(b.pnlPct),
    allTime: { realisedUsd: r2(b.totals.realisedUsd), feesUsd: r2(b.totals.feesUsd), fundingUsd: r2(b.totals.fundingUsd), modelUsd: r2(b.totals.jevUsd), decisions: b.totals.decisions, orders: b.totals.orders },
    last24h: window(b.bee, now - DAY),
    last7d: window(b.bee, now - 7 * DAY),
    today: { trades: `${b.tradesToday}/${b.maxTradesPerDay}`, feesUsd: r2(b.feesTodayUsd), feeBudgetUsd: r2(b.feeBudgetUsd), benched: b.cap },
  }));
  const sum = (k: "feesUsd" | "fundingUsd" | "modelUsd" | "realisedUsd") => r2(bunnies.reduce((a, b) => a + (b.allTime[k] ?? 0), 0));
  return {
    bunnies,
    warren: { equityUsd: r2(bunnies.reduce((a, b) => a + (b.equityUsd ?? 0), 0)), startUsd: r2(bunnies.reduce((a, b) => a + (b.startUsd ?? 0), 0)), realisedUsd: sum("realisedUsd"), feesUsd: sum("feesUsd"), fundingUsd: sum("fundingUsd"), modelUsd: sum("modelUsd") },
    budgets: { jevTodayUsd: r2(snap.jev.spentTodayUsd), jevDailyCapUsd: r2(snap.jev.dailyCapUsd), jevCapHit: snap.jev.capTripped, jevDown: snap.jev.down, ...extra },
  };
}
