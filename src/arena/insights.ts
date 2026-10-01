// What the agent page shows about one agent's paper run, read straight from that run's own SQLite file (read-only).
// Facts only: what the agent saw, the odds it gave each move, what it did, and which risk rule changed the outcome.
// The decision model answers with a choice and odds, not prose, so nothing here is a story the platform made up.
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export interface DecisionFact {
  ts: number;
  /** What the agent picked (a menu label such as LONG_BTC), or null when it held because the model could not answer. */
  choice: string | null;
  confidence: number | null;
  /** The odds it gave each option on the menu, highest first. */
  odds: Array<{ label: string; p: number }>;
  /** What was done: open, close, add, trim, switch, hold... and on which coin and side. */
  did: { kind: string; coin?: string; side?: string; sizeUsd?: number; reason?: string };
  /** A risk rule overruled the agent (vetoedBy) or acted on its own (forcedBy), e.g. a stop. */
  vetoedBy: string | null;
  forcedBy: string | null;
  status: string;
  /** What it was looking at: its own position and one row of numbers per coin. */
  saw: { me: Record<string, unknown>; cols: string[]; coins: Record<string, Array<number | null>> };
}

export interface TradeFact {
  ts: number;
  coin: string;
  side: "buy" | "sell";
  sizeUsd: number;
  feeUsd: number;
  /** Profit or loss booked by this fill (zero when it opened or added). */
  realisedUsd: number;
}

export interface Insights {
  /** Equity curve, at most ~120 points, oldest first. */
  equity: Array<[number, number]>;
  maxDrawdownPct: number;
  decisions: DecisionFact[];
  trades: TradeFact[];
  closedTrades: number;
  winningTrades: number;
}

const coinOf = (inst: string | undefined): string | undefined => inst?.split("-")[0];

function parse(json: string | null): Record<string, unknown> {
  try {
    const v = json ? JSON.parse(json) : {};
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function did(actionJson: string): DecisionFact["did"] {
  const a = parse(actionJson);
  const kind = typeof a.kind === "string" ? a.kind : "none";
  return {
    kind,
    coin: coinOf(typeof a.instId === "string" ? a.instId : undefined),
    side: typeof a.side === "string" ? a.side : undefined,
    sizeUsd: typeof a.notionalUsd === "number" ? Math.round(a.notionalUsd) : undefined,
    reason: typeof a.reason === "string" ? a.reason : undefined,
  };
}

function sees(stateJson: string | null): DecisionFact["saw"] {
  const s = parse(stateJson);
  const coins = (s.coins ?? {}) as { cols?: unknown; rows?: unknown };
  return {
    me: s.me && typeof s.me === "object" ? (s.me as Record<string, unknown>) : {},
    cols: Array.isArray(coins.cols) ? (coins.cols as string[]) : [],
    coins: coins.rows && typeof coins.rows === "object" ? (coins.rows as Record<string, Array<number | null>>) : {},
  };
}

/** Reads a run's file. Returns null when the file is not there (nothing has run yet). */
export function readInsights(file: string, opts: { decisions?: number; trades?: number; points?: number } = {}): Insights | null {
  if (!existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=2000");
    const all = (db.prepare("SELECT ts, equity_usd AS eq FROM equity_snapshots ORDER BY ts").all() as Array<{ ts: number; eq: number }>).filter((r) => Number.isFinite(r.eq));
    let peak = 0;
    let maxDd = 0;
    for (const r of all) {
      peak = Math.max(peak, r.eq);
      if (peak > 0) maxDd = Math.max(maxDd, ((peak - r.eq) / peak) * 100);
    }
    const n = opts.points ?? 120;
    const step = Math.max(1, Math.ceil(all.length / n));
    const equity = all.filter((_, i) => i % step === 0 || i === all.length - 1).map((r): [number, number] => [r.ts, Number(r.eq.toFixed(2))]);

    const decisions = (
      db
        .prepare("SELECT ts, choice, confidence, probabilities_json AS p, action_json AS a, vetoed_by, forced_by, status, state_json AS s FROM decisions ORDER BY id DESC LIMIT ?")
        .all(opts.decisions ?? 40) as Array<{ ts: number; choice: string | null; confidence: number | null; p: string | null; a: string; vetoed_by: string | null; forced_by: string | null; status: string | null; s: string | null }>
    ).map((r): DecisionFact => {
      const probs = parse(r.p);
      return {
        ts: r.ts,
        choice: r.choice,
        confidence: r.confidence,
        odds: Object.entries(probs)
          .filter((e): e is [string, number] => typeof e[1] === "number")
          .sort((x, y) => y[1] - x[1])
          .map(([label, p]) => ({ label, p })),
        did: did(r.a),
        vetoedBy: r.vetoed_by,
        forcedBy: r.forced_by,
        status: r.status ?? "",
        saw: sees(r.s),
      };
    });

    const trades = (
      db.prepare("SELECT ts, inst_id, side, notional_usd, fee_usd, realised_usd FROM fills ORDER BY id DESC LIMIT ?").all(opts.trades ?? 40) as Array<{ ts: number; inst_id: string; side: string; notional_usd: number; fee_usd: number; realised_usd: number }>
    ).map((r): TradeFact => ({ ts: r.ts, coin: coinOf(r.inst_id) ?? r.inst_id, side: r.side === "sell" ? "sell" : "buy", sizeUsd: Math.round(r.notional_usd), feeUsd: Number(r.fee_usd.toFixed(2)), realisedUsd: Number(r.realised_usd.toFixed(2)) }));
    const closed = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN realised_usd - fee_usd > 0 THEN 1 ELSE 0 END), 0) AS w FROM fills WHERE realised_usd != 0").get() as { n: number; w: number };
    return { equity, maxDrawdownPct: Number(maxDd.toFixed(2)), decisions, trades, closedTrades: Number(closed.n), winningTrades: Number(closed.w) };
  } finally {
    db.close();
  }
}
