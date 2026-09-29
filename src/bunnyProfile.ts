// One bunny's public profile (GET /bunny/<slot>): its equity curve, trades and per-coin record, recent decisions,
// what it learned, what it said to the Warren and what the others said back, the skills its council chose and why.
// Read-only and public like /snapshot: no keys, no account data, no prompts. The live numbers (equity now, the open
// position, level and health) come from the snapshot and the event stream the dashboard already has.
import type { Db } from "./db.js";
import type { KnowledgeGraph } from "./graph/graph.js";
import { beeNode } from "./graph/hive-mind.js";
import type { Playbook } from "./brains/playbook.js";

export interface BunnyProfileDeps {
  db: Db;
  graph: KnowledgeGraph;
  playbook: () => Playbook | null;
  /** Slots the engine runs; anything else is a 404. */
  slots: () => readonly string[];
  now?: () => number;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const coinOf = (instId: string) => instId.split("-")[0] ?? instId;

type FillRow = { ts: number; instId: string; side: "buy" | "sell"; px: number; notional: number; fee: number; realised: number; ro: number; purpose: string | null };
type DecisionRow = {
  ts: number;
  choice: string | null;
  confidence: number | null;
  conviction: number | null;
  latency: number | null;
  cost: number;
  status: string | null;
  vetoed: string | null;
  forced: string | null;
  error: string | null;
};

export function bunnyProfile(d: BunnyProfileDeps, slot: string, days = 30): unknown | null {
  if (!d.slots().includes(slot)) return null;
  const now = (d.now ?? Date.now)();
  const since = now - Math.max(1, Math.min(60, days)) * 86_400_000;
  const raw = d.db.raw;

  // Equity, bucketed to at most ~400 points (last value per bucket).
  const first = (raw.prepare(`SELECT MIN(ts) AS t FROM equity_snapshots WHERE bee = ? AND ts >= ?`).get(slot, since) as { t: number | null }).t ?? since;
  const bucket = Math.max(10_000, Math.ceil((now - first) / 400));
  const equity = (
    raw
      .prepare(`SELECT MAX(ts) AS ts, equity_usd AS eq, upl_usd AS upl FROM equity_snapshots WHERE bee = ? AND ts >= ? GROUP BY CAST(ts / ? AS INTEGER) ORDER BY ts`)
      .all(slot, since, bucket) as Array<{ ts: number; eq: number; upl: number | null }>
  ).map((x) => [x.ts, r2(x.eq)] as [number, number]);

  const fills = raw
    .prepare(
      `SELECT f.ts, f.inst_id AS instId, f.side, f.px, f.notional_usd AS notional, f.fee_usd AS fee, f.realised_usd AS realised,
              COALESCE(o.reduce_only, 0) AS ro, o.purpose AS purpose
       FROM fills f LEFT JOIN orders o ON o.id = f.order_id WHERE f.bee = ? ORDER BY f.ts DESC, f.id DESC LIMIT 2000`,
    )
    .all(slot) as FillRow[];

  // A closed trade is a fill that realised P&L (a reduce-only exit, a stop, a flip's close).
  const closes = fills.filter((f) => f.ro === 1 || Math.abs(f.realised) > 1e-9);
  const wins = closes.filter((f) => f.realised > 0);
  const losses = closes.filter((f) => f.realised < 0);
  const sum = (xs: FillRow[], k: "realised" | "fee") => xs.reduce((a, f) => a + f[k], 0);
  const grossWin = sum(wins, "realised");
  const grossLoss = -sum(losses, "realised");

  const byCoin = new Map<string, { coin: string; trades: number; wins: number; realisedUsd: number; feesUsd: number; volumeUsd: number; lastTs: number }>();
  for (const f of fills) {
    const c = coinOf(f.instId);
    const row = byCoin.get(c) ?? { coin: c, trades: 0, wins: 0, realisedUsd: 0, feesUsd: 0, volumeUsd: 0, lastTs: 0 };
    row.feesUsd += f.fee;
    row.volumeUsd += Math.abs(f.notional);
    row.lastTs = Math.max(row.lastTs, f.ts);
    if (f.ro === 1 || Math.abs(f.realised) > 1e-9) {
      row.trades++;
      row.realisedUsd += f.realised;
      if (f.realised > 0) row.wins++;
    }
    byCoin.set(c, row);
  }

  const decisions = raw
    .prepare(
      `SELECT ts, choice, confidence, conviction, latency_ms AS latency, jev_cost_usd AS cost, status, vetoed_by AS vetoed, forced_by AS forced, jev_error AS error
       FROM decisions WHERE bee = ? ORDER BY ts DESC LIMIT 300`,
    )
    .all(slot) as DecisionRow[];
  const counts = raw.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(jev_cost_usd), 0) AS cost, AVG(confidence) AS conf, AVG(latency_ms) AS lat FROM decisions WHERE bee = ?`).get(slot) as {
    n: number;
    cost: number;
    conf: number | null;
    lat: number | null;
  };
  const choices = new Map<string, number>();
  for (const x of decisions) {
    const k = (x.choice ?? x.status ?? "none").replace(/_[A-Z0-9]+$/, "");
    choices.set(k, (choices.get(k) ?? 0) + 1);
  }

  // Daily realised P&L and trade count (UTC days), for the activity chart.
  const daily = new Map<string, { day: string; realisedUsd: number; feesUsd: number; trades: number }>();
  for (const f of fills) {
    if (f.ts < since) continue;
    const day = new Date(f.ts).toISOString().slice(0, 10);
    const row = daily.get(day) ?? { day, realisedUsd: 0, feesUsd: 0, trades: 0 };
    row.feesUsd += f.fee;
    if (f.ro === 1 || Math.abs(f.realised) > 1e-9) {
      row.trades++;
      row.realisedUsd += f.realised;
    }
    daily.set(day, row);
  }

  // The Warren's conversation: every message from the bunnies (council, coach, survival, rewards), newest first;
  // the dashboard highlights this bunny's own and the ones addressed to it.
  const me = beeNode(slot);
  const label = (id: string) => d.graph.node(id)?.label ?? id.replace(/^bee:/, "");
  const messages = d.graph
    .nodes("message", 120)
    .map((n) => ({
      ts: n.updatedAt,
      from: String(n.props.from ?? ""),
      to: String(n.props.to ?? "hive"),
      text: String(n.props.text ?? n.label),
      source: n.props.source ? String(n.props.source) : null,
      brain: n.props.brain ? String(n.props.brain) : n.props.brains ? String(n.props.brains) : null,
    }))
    .map((m) => ({ ...m, fromSlot: m.from.replace(/^bee:/, ""), fromName: label(m.from), toName: m.to === "hive" ? "the Warren" : label(m.to), mine: m.from === me, toMe: m.to === me }));

  const lessons = d.graph
    .out(me, "learned", 200)
    .map((e) => d.graph.node(e.dst))
    .filter((n): n is NonNullable<typeof n> => !!n)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 40)
    .map((n) => ({ ts: n.updatedAt, text: String(n.props.text ?? n.label), source: n.props.source ? String(n.props.source) : null, consolidated: !!n.props.consolidated }));

  const adopted = d.graph.out(me, "adopts", 12).map((e) => ({ skill: e.dst.replace(/^skill:/, ""), weight: r2(e.weight), since: e.updatedAt }));
  const spec = d.graph.out(me, "specialises_in", 1)[0];
  const plan = d.playbook()?.bees[slot] ?? null;

  return {
    slot,
    generatedAt: now,
    equity,
    stats: {
      trades: closes.length,
      wins: wins.length,
      losses: losses.length,
      winRatePct: closes.length ? r2((100 * wins.length) / closes.length) : null,
      realisedUsd: r2(sum(closes, "realised")),
      feesUsd: r2(sum(fills, "fee")),
      volumeUsd: r2(fills.reduce((a, f) => a + Math.abs(f.notional), 0)),
      avgWinUsd: wins.length ? r2(grossWin / wins.length) : null,
      avgLossUsd: losses.length ? r2(-grossLoss / losses.length) : null,
      profitFactor: grossLoss > 0 ? r2(grossWin / grossLoss) : null,
      bestUsd: closes.length ? r2(Math.max(...closes.map((f) => f.realised))) : null,
      worstUsd: closes.length ? r2(Math.min(...closes.map((f) => f.realised))) : null,
      decisions: counts.n,
      jevUsd: r2(counts.cost),
      avgConfidence: counts.conf === null ? null : r2(counts.conf),
      avgLatencyMs: counts.lat === null ? null : Math.round(counts.lat),
    },
    coins: [...byCoin.values()]
      .map((c) => ({ ...c, realisedUsd: r2(c.realisedUsd), feesUsd: r2(c.feesUsd), volumeUsd: r2(c.volumeUsd), winRatePct: c.trades ? Math.round((100 * c.wins) / c.trades) : null }))
      .sort((a, b) => b.realisedUsd - a.realisedUsd),
    daily: [...daily.values()].map((x) => ({ ...x, realisedUsd: r2(x.realisedUsd), feesUsd: r2(x.feesUsd) })).sort((a, b) => a.day.localeCompare(b.day)),
    fills: fills.slice(0, 150).map((f) => ({
      ts: f.ts,
      coin: coinOf(f.instId),
      side: f.side,
      px: f.px,
      notionalUsd: r2(Math.abs(f.notional)),
      feeUsd: r2(f.fee),
      realisedUsd: r2(f.realised),
      close: f.ro === 1 || Math.abs(f.realised) > 1e-9,
      purpose: f.purpose,
    })),
    decisions: decisions.slice(0, 120).map((x) => ({
      ts: x.ts,
      choice: x.choice,
      confidence: x.confidence === null ? null : r2(x.confidence),
      conviction: x.conviction === null ? null : r2(x.conviction),
      latencyMs: x.latency,
      status: x.status,
      vetoedBy: x.vetoed,
      forcedBy: x.forced,
      error: x.error ? x.error.slice(0, 160) : null,
    })),
    choiceMix: [...choices.entries()].map(([choice, n]) => ({ choice, n })).sort((a, b) => b.n - a.n).slice(0, 8),
    learning: {
      lessons,
      adopted,
      specialization: spec ? { method: d.graph.node(spec.dst)?.label ?? spec.dst, reason: spec.props.reason ? String(spec.props.reason) : null, since: spec.updatedAt } : null,
      plan: plan
        ? {
            brain: plan.brain,
            model: plan.model,
            decidedAt: plan.decidedAt,
            message: plan.message,
            lessons: plan.lessons,
            skills: plan.skills.map((s) => ({ id: s.id, weight: r2(s.weight), reason: s.reason, score: r2(s.score) })),
          }
        : null,
    },
    messages,
  };
}
