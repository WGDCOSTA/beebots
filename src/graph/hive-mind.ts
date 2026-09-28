// What goes into the knowledge graph, and what comes back out as context for a bee's LLM brain.
import type { DatabaseSync } from "node:sqlite";
import type { Ranking } from "../lab/tournament.js";
import { nodeId, type KnowledgeGraph } from "./graph.js";

export interface BeeProfile {
  slot: string;
  name: string;
  style: string;
  rules: string;
  coins: string[];
  brain: string;
  model: string;
  /** What it trades (default crypto); macro bees race in the macro squad. */
  market?: string;
}

export const beeNode = (slot: string) => nodeId("bee", slot);
export const skillNode = (id: string) => nodeId("skill", id);
export const coinNode = (coin: string) => nodeId("coin", coin.toUpperCase());
export const brainNode = (brain: string) => nodeId("brain", brain);

/** "BTC-USDT-SWAP 1H" -> "BTC"; a CCXT dataset "binance-BTC-USDT 1H" -> "BTC" (the lowercase exchange id is skipped). */
export function coinOfDataset(id: string): string {
  const parts = id.split(/[-\s_]/).filter(Boolean);
  const first = parts[0] ?? id;
  return (/^[a-z0-9]+$/.test(first) && parts.length > 1 ? parts[1]! : first).toUpperCase();
}

export function registerBees(g: KnowledgeGraph, bees: BeeProfile[]): void {
  for (const b of bees) {
    const market = b.market ?? "crypto";
    const bee = g.upsert("bee", b.slot, b.name, { style: b.style, rules: b.rules, coins: b.coins, market, squad: market === "crypto" ? "crypto" : "macro" });
    const brain = g.upsert("brain", b.brain, b.brain, { model: b.model });
    g.unlink(bee, "thinks_with");
    g.link(bee, "thinks_with", brain, 1, { model: b.model });
    for (const c of b.coins) g.link(bee, "restricted_to", g.upsert("coin", c.toUpperCase(), c.toUpperCase()));
  }
}

/** A tournament run becomes: a run node, skill and family nodes, ranked-by and performs-on edges. */
export function ingestRanking(g: KnowledgeGraph, r: Ranking): string {
  const run = g.upsert("run", String(r.createdAt), `lab run ${new Date(r.createdAt).toISOString().slice(0, 16)}`, {
    datasets: r.datasets.map((d) => d.id),
    skills: r.results.length,
    folds: r.opts.folds,
  });
  for (const s of r.results) {
    const sk = g.upsert("skill", s.skillId, s.name, {
      family: s.family,
      description: s.description,
      source: s.source,
      params: s.params,
      score: round(s.score),
      rank: s.rank,
      oosReturnPct: round(s.oos.returnPct),
      sharpe: round(s.oos.sharpe),
      maxDrawdownPct: round(s.oos.maxDrawdownPct),
      stabilityPct: round(s.stabilityPct),
      overfitGap: round(s.overfitGap),
    });
    g.link(sk, "in_family", g.upsert("family", s.family, s.family));
    g.link(run, "ranked", sk, round(s.score), { rank: s.rank });
    const byDs = new Map<string, number[]>();
    for (const f of s.folds) byDs.set(f.dataset, [...(byDs.get(f.dataset) ?? []), f.oosScore]);
    for (const [ds, scores] of byDs) {
      const coin = coinOfDataset(ds);
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      g.link(sk, "performs_on", g.upsert("coin", coin, coin), round(avg), { dataset: ds, runAt: r.createdAt });
    }
  }
  return run;
}

/**
 * Closed trades since `sinceTs` from the engine's books: each bee's realised P&L per coin accumulates on a
 * bee -traded-> coin edge (weight = total realised USD). Returns the newest fill time seen (the next cursor).
 */
export function ingestFills(g: KnowledgeGraph, db: DatabaseSync, sinceTs: number): number {
  const rows = db
    .prepare("SELECT bee, ts, inst_id, realised_usd, fee_usd FROM fills WHERE ts > ? AND realised_usd != 0 ORDER BY ts LIMIT 5000")
    .all(sinceTs) as Array<{ bee: string; ts: number; inst_id: string; realised_usd: number; fee_usd: number }>;
  let last = sinceTs;
  for (const r of rows) {
    const coin = r.inst_id.split("-")[0]!.toUpperCase();
    const bee = beeNode(r.bee);
    if (!g.node(bee)) g.upsert("bee", r.bee, r.bee);
    const c = g.upsert("coin", coin, coin);
    const net = r.realised_usd - r.fee_usd;
    const old = g.edge(bee, "traded", c);
    const trades = Number(old?.props.trades ?? 0) + 1;
    const wins = Number(old?.props.wins ?? 0) + (net > 0 ? 1 : 0);
    g.link(bee, "traded", c, round(net), { trades, wins, lastTs: r.ts }, "add");
    last = Math.max(last, r.ts);
  }
  return last;
}

/** Everything the graph knows that matters to one bee, as a compact object for an LLM prompt. */
export function contextFor(g: KnowledgeGraph, slot: string) {
  const bee = beeNode(slot);
  const adopted = g.out(bee, "adopts", 8).map((e) => ({ skill: e.dst.slice(6), weight: round(e.weight) }));
  const record = g.out(bee, "traded", 12).map((e) => ({
    coin: e.dst.slice(5),
    netUsd: round(e.weight),
    trades: Number(e.props.trades ?? 0),
    winRatePct: e.props.trades ? Math.round((100 * Number(e.props.wins ?? 0)) / Number(e.props.trades)) : null,
  }));
  const peers = g
    .nodes("bee", 10)
    .filter((n) => n.id !== bee)
    .map((n) => ({
      bee: n.label,
      style: n.props.style ?? null,
      squad: n.props.squad ?? "crypto",
      adopts: g.out(n.id, "adopts", 4).map((e) => e.dst.slice(6)),
    }));
  return {
    myLessons: g.lessons(bee, 6).map((l) => l.text),
    labLessons: g.lessons(nodeId("run", "lab"), 3).map((l) => l.text),
    adopted,
    tradeRecord: record,
    inbox: g.inbox(bee, 6).map((m) => ({ from: g.node(m.from)?.label ?? m.from, text: m.text })),
    peers,
  };
}

const round = (x: number) => Math.round(x * 1000) / 1000;
