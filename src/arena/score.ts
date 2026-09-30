// The maths of the ranking, with no storage and no clock of its own, so the rules can be read, argued with and tested.
// A season is a UTC week. A bot is ranked on the equity samples its paper account recorded inside the season:
//   score = return % - half of its worst peak-to-trough drop %
// which rewards return and punishes a deep drawdown in the same unit. Sharpe is shown, not ranked on: a bot that sits flat
// with one lucky tick has a wonderful Sharpe. To be ranked at all a bot needs enough days, samples and trades.

export const DAY_MS = 86_400_000;
export const MIN_DAYS = 3;
export const MIN_SAMPLES = 50;
export const MIN_TRADES = 3;
/** How much a drawdown counts against the return. */
export const DRAWDOWN_WEIGHT = 0.5;

export interface Season {
  id: string;
  start: number;
  end: number;
}

/** The UTC week (Monday 00:00 to the next Monday 00:00) that holds `ts`, named like 2026-W40 (ISO week). */
export function seasonOf(ts: number): Season {
  const d = new Date(ts);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  const start = midnight - dow * DAY_MS;
  // ISO week number: the week belongs to the year of its Thursday.
  const thursday = new Date(start + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.floor((Date.UTC(year, thursday.getUTCMonth(), thursday.getUTCDate()) - jan1) / (7 * DAY_MS)) + 1;
  return { id: `${year}-W${String(week).padStart(2, "0")}`, start, end: start + 7 * DAY_MS };
}

export interface Point {
  ts: number;
  equity: number;
  /** Orders the paper account had sent by then (cumulative). */
  orders: number;
}

export interface Metrics {
  samples: number;
  days: number;
  returnPct: number;
  maxDrawdownPct: number;
  sharpe: number | null;
  trades: number;
  score: number;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};

/** Metrics from a bot's samples in one season (oldest first), or null when there is nothing to measure. */
export function metricsOf(points: Point[]): Metrics | null {
  if (points.length < 2) return null;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (first.equity <= 0) return null;
  let peak = first.equity;
  let worst = 0;
  const rets: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const e = points[i]!.equity;
    if (e > peak) peak = e;
    worst = Math.max(worst, peak > 0 ? (peak - e) / peak : 0);
    if (i > 0 && points[i - 1]!.equity > 0) rets.push(e / points[i - 1]!.equity - 1);
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1));
  const step = median(points.slice(1).map((p, i) => p.ts - points[i]!.ts));
  const sharpe = sd > 1e-12 && step > 0 ? (mean / sd) * Math.sqrt((365 * DAY_MS) / step) : null;
  const returnPct = (last.equity / first.equity - 1) * 100;
  const maxDrawdownPct = worst * 100;
  return {
    samples: points.length,
    days: (last.ts - first.ts) / DAY_MS,
    returnPct,
    maxDrawdownPct,
    sharpe,
    trades: Math.max(0, last.orders - first.orders),
    score: returnPct - DRAWDOWN_WEIGHT * maxDrawdownPct,
  };
}

/** What a bot still needs before it is ranked, in words, or null when it is eligible. */
export function whyNotRanked(m: Metrics | null): string | null {
  if (!m) return "Just started. Rankings begin once it has a little history.";
  const need: string[] = [];
  if (m.days < MIN_DAYS) need.push(`${Math.max(0.1, MIN_DAYS - m.days).toFixed(1)} more days`);
  if (m.trades < MIN_TRADES) need.push(`${MIN_TRADES - m.trades} more ${MIN_TRADES - m.trades === 1 ? "trade" : "trades"}`);
  if (m.samples < MIN_SAMPLES) need.push("more history");
  return need.length ? `Needs ${need.join(", ")} to be ranked.` : null;
}

export interface Ranked<T> {
  rank: number;
  entry: T;
}

/** Best score first; ties share the rank of the first of them. Bots that are not eligible are not passed in. */
export function rankBy<T extends { metrics: Metrics }>(entries: T[]): Array<Ranked<T>> {
  const sorted = [...entries].sort((a, b) => b.metrics.score - a.metrics.score);
  const out: Array<Ranked<T>> = [];
  sorted.forEach((e, i) => {
    const same = i > 0 && Math.abs(sorted[i - 1]!.metrics.score - e.metrics.score) < 1e-9;
    out.push({ rank: same ? out[i - 1]!.rank : i + 1, entry: e });
  });
  return out;
}

/** The league a bot races in: its plan and its style, because Free and Pro never compete together. */
export const leagueOf = (tier: string, style: string): string => `${tier}:${style}`;
