// Black-box calibration (section 48): behavioural model fitting, NOT source-code recovery.
//
// Given the public trade records of some strategy with similar behaviour (entry time and price, direction, exit) and
// XAUUSD candles, search this engine's own parameter space for the settings whose simulated trades look most like the
// observed ones. The result is an ESTIMATE of plausible parameters. It says nothing about what any commercial system
// actually runs, and it must never be described as if it did.
import { rng } from "../../history.js";
import { TF_MS, TFS, type Tf } from "../../resample.js";
import { defaultProfile } from "../profiles.js";
import { runGold, type GoldData } from "../sim.js";
import { StrategySchema, type StrategyProfile } from "../types.js";

export interface PublicTrade {
  entryTs: number;
  entryPx: number;
  direction: "BUY" | "SELL";
  exitTs?: number;
  exitPx?: number;
}

export interface FitParams {
  entryTf: Tf;
  left: number;
  right: number;
  lookback: number;
  arm: number;
  offset: number;
  expiryBars: number;
  fake: "OFF" | "LOW" | "MEDIUM" | "HIGH";
  sl: number;
  tp: number;
  trail: boolean;
}

export const FIT_SPACE = {
  entryTf: ["D1", "H4", "H1", "M30", "M15"] as Tf[],
  left: [2, 3, 4, 5],
  right: [2, 3, 4, 5, 6],
  lookback: [50, 100, 150, 200],
  arm: [3, 6, 10, 15, 25, 40],
  offset: [0.5, 1, 1.5, 2, 3],
  expiryBars: [12, 24, 40],
  fake: ["OFF", "LOW", "MEDIUM", "HIGH"] as FitParams["fake"][],
  sl: [8, 15, 25, 40, 55],
  tp: [9, 15, 25, 40, 80],
  trail: [false, true],
};

/** One tick finer than `tf`, never finer than the data's base. */
const finer = (tf: Tf, base: Tf): Tf => {
  const i = TFS.indexOf(tf);
  const j = Math.max(TFS.indexOf(base), i - 1);
  return TFS[Math.max(0, j)]!;
};

export function profileFor(fp: FitParams, base: Tf): StrategyProfile {
  const t = defaultProfile("S4");
  return StrategySchema.parse({
    ...t,
    entry_timeframe: fp.entryTf,
    exit_timeframe: finer(fp.entryTf, base),
    structure: { left_bars: fp.left, right_bars: fp.right, max_lookback_bars: fp.lookback, level_selection: "recent" },
    entry: { min_arm_distance: fp.arm, breakout_offset: fp.offset, pending_expiry_bars: fp.expiryBars },
    stop_loss: { base_distance: fp.sl },
    take_profit: { base_distance: fp.tp },
    break_even: { enabled: fp.trail, trigger_distance: fp.sl * 0.5, lock_distance: 1 },
    trailing: { enabled: fp.trail, trigger_distance: fp.sl * 0.6, distance: fp.sl * 0.35 },
    structure_trailing: { enabled: false },
    fake_breakout: fp.fake === "OFF" ? { enabled: false } : { enabled: true, mode: fp.fake },
    normalization: { mode: "NONE" },
    risk: { weight: 1, max_trade_risk_pct: 0.25 },
  });
}

/**
 * The engine config used to fit: the account is huge, the risk ceilings and the volume cap are open, and the weekend
 * and spread filters are off. The fit is about WHEN and WHERE the model enters, not about sizing or risk limits.
 */
export function fitConfig(cfg: Record<string, unknown>): Record<string, unknown> {
  const f = (cfg.filters ?? {}) as Record<string, unknown>;
  const con = (cfg.contract ?? {}) as Record<string, unknown>;
  return {
    ...cfg,
    account: { initial_balance: 1e9 },
    contract: { ...con, volume_max: 1e12 },
    risk: { max_open_risk_pct: 100, max_daily_loss_pct: 100, max_weekly_loss_pct: 100, max_concurrent_positions: 50, max_correlated_positions: 50, reserve_pending_risk: false },
    filters: { ...f, weekend: { enabled: false }, spread: { enabled: false } },
  };
}

export interface FitScore {
  /** Sum of the four components, 0..4 (times a small penalty when the model trades far more than the record). */
  score: number;
  entryMatch: number;
  directionMatch: number;
  timingMatch: number;
  levelMatch: number;
  simulatedTrades: number;
  observedTrades: number;
}

/** Score a simulated trade list against the observed one. Entries match within `tolMs` and `tolPx`. */
export function matchScore(sim: Array<{ entryTs: number; entryPx: number; side: "BUY" | "SELL"; level: number }>, obs: PublicTrade[], tolMs: number, tolPx: number, offset: number): FitScore {
  let entryHit = 0;
  let dirHit = 0;
  let timing = 0;
  let levelHit = 0;
  for (const o of obs) {
    let best: (typeof sim)[number] | null = null;
    let bestDt = Infinity;
    for (const s of sim) {
      const dt = Math.abs(s.entryTs - o.entryTs);
      if (dt <= tolMs && Math.abs(s.entryPx - o.entryPx) <= tolPx && dt < bestDt) {
        best = s;
        bestDt = dt;
      }
    }
    if (best) {
      entryHit++;
      if (best.side === o.direction) dirHit++;
      timing += 1 - bestDt / tolMs;
      // the observed entry sits one offset beyond a structural level of this model
      const lvl = o.direction === "BUY" ? best.level + offset : best.level - offset;
      if (Math.abs(o.entryPx - lvl) <= tolPx) levelHit++;
    }
  }
  const n = Math.max(1, obs.length);
  const entryMatch = entryHit / n;
  const directionMatch = entryHit ? dirHit / entryHit : 0;
  const timingMatch = entryHit ? timing / entryHit : 0;
  const levelMatch = entryHit ? levelHit / entryHit : 0;
  const overTrading = sim.length > 0 ? Math.min(1, obs.length / sim.length) ** 0.5 : 0;
  return { score: (entryMatch + directionMatch + timingMatch + levelMatch) * overTrading, entryMatch, directionMatch, timingMatch, levelMatch, simulatedTrades: sim.length, observedTrades: obs.length };
}

export interface FitCandidate {
  params: FitParams;
  fit: FitScore;
  /** Always "estimated": a behavioural fit, never a fact about anyone's system. */
  label: "estimated";
}

export interface FitOpts {
  evaluations: number;
  refine: number;
  seed: number;
  top: number;
  /** Bars of history to keep before the first observed trade. */
  paddingDays: number;
}
export const DEFAULT_FIT: FitOpts = { evaluations: 120, refine: 60, seed: 1, top: 5, paddingDays: 120 };

export function fitObserved(cfg: Record<string, unknown>, data: GoldData, observed: PublicTrade[], o: Partial<FitOpts> = {}): { candidates: FitCandidate[]; evaluated: number; disclaimer: string } {
  const opts = { ...DEFAULT_FIT, ...o };
  const r = rng(opts.seed);
  const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)]!;
  const first = Math.min(...observed.map((t) => t.entryTs));
  const last = Math.max(...observed.map((t) => t.exitTs ?? t.entryTs)) + 86_400_000;
  const from = first - opts.paddingDays * 86_400_000;
  const base = data.base.filter((b) => b.ts >= from && b.ts < last);
  const slice: GoldData = { base, baseTf: data.baseTf };
  const c = fitConfig(cfg);
  const evalOne = (fp: FitParams): FitCandidate => {
    const run = runGold(c, slice, { profiles: [profileFor(fp, data.baseTf)], strategies: ["S4"], commit: "fit" });
    const tolMs = Math.max(2 * TF_MS[fp.entryTf], 30 * 60_000);
    const tolPx = Math.max(1.5, fp.offset * 1.5);
    const fit = matchScore(run.trades.map((t) => ({ entryTs: t.entryTs, entryPx: t.entryPx, side: t.side, level: t.level })), observed, tolMs, tolPx, fp.offset);
    return { params: fp, fit, label: "estimated" };
  };
  const rand = (): FitParams => ({
    entryTf: pick(FIT_SPACE.entryTf),
    left: pick(FIT_SPACE.left),
    right: pick(FIT_SPACE.right),
    lookback: pick(FIT_SPACE.lookback),
    arm: pick(FIT_SPACE.arm),
    offset: pick(FIT_SPACE.offset),
    expiryBars: pick(FIT_SPACE.expiryBars),
    fake: pick(FIT_SPACE.fake),
    sl: pick(FIT_SPACE.sl),
    tp: pick(FIT_SPACE.tp),
    trail: pick(FIT_SPACE.trail),
  });
  const pool: FitCandidate[] = [];
  // Only timeframes the data can resolve.
  const okTf = FIT_SPACE.entryTf.filter((t) => TF_MS[t] >= TF_MS[data.baseTf]);
  if (!okTf.length) throw new Error("the data's timeframe is coarser than every candidate entry timeframe");
  for (let i = 0; i < opts.evaluations; i++) {
    const fp = rand();
    if (!okTf.includes(fp.entryTf)) fp.entryTf = pick(okTf);
    pool.push(evalOne(fp));
  }
  // Refine: perturb one dimension of each of the best few, keep what improves.
  pool.sort((a, b) => b.fit.score - a.fit.score);
  let evaluated = pool.length;
  for (let i = 0; i < opts.refine; i++) {
    const seed = pool[Math.floor(r() * Math.min(5, pool.length))]!;
    const k = pick(Object.keys(FIT_SPACE)) as keyof FitParams;
    const vals = FIT_SPACE[k] as unknown[];
    const fp = { ...seed.params, [k]: pick(vals as never[]) } as FitParams;
    if (!okTf.includes(fp.entryTf)) continue;
    pool.push(evalOne(fp));
    evaluated++;
  }
  pool.sort((a, b) => b.fit.score - a.fit.score);
  const seen = new Set<string>();
  const candidates = pool.filter((c2) => {
    const key = JSON.stringify(c2.params);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, opts.top);
  return {
    candidates,
    evaluated,
    disclaimer: "Behavioural model fitting on public trade records. These parameters are ESTIMATES of settings that make this independent engine trade similarly; they are not, and must not be presented as, facts about any commercial system.",
  };
}
