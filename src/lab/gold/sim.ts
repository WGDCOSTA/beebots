// The gold breakout simulator: an event-driven, bar-by-bar engine for the nine strategy profiles.
//
// Time model (no look-ahead):
//   - The base bars are the finest data. Every coarser timeframe is built from them and only counts once CLOSED.
//   - Inside bar i the engine handles fills and exits using the bar's range (pessimistic order: stop before target,
//     and nothing new can both fill and take profit inside its own bar). At bar i's CLOSE it updates trailing stops,
//     fake-breakout checks, filters and arms new orders; those act from bar i+1.
//   - A swing is known only after its `right` confirming bars have closed (swings.ts).
//   - Bars are BID prices (as in MT5); the ask is bid + spread. Long entries pay the ask and exit at the bid.
//
// Everything here is simulation. There is no execution adapter and live_trading is refused.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { Candle } from "../../market/types.js";
import type { Mt5Bar } from "../history.js";
import { configHash, dataHash } from "../hash.js";
import { resample, TF_MS, type Tf } from "../resample.js";
import * as S from "../series.js";
import { NewsCalendar, sessionOk, spreadOk, weekendState } from "./filters.js";
import { selectLevel, type Level } from "./levels.js";
import { referenceAtr, scaleFactor } from "./normalization.js";
import { blendedWeights, marginFor, sizeLots, stopLevelOk, type Reserved } from "./portfolio.js";
import { activeProfiles, defaultProfiles, fakeChecks } from "./profiles.js";
import { SwingIndex } from "./swings.js";
import { dayKey, weekKey } from "./time.js";
import {
  assertResearchOnly,
  EngineSchema,
  magicOf,
  StrategySchema,
  type EngineConfig,
  type ExitReason,
  type GoldRun,
  type GoldTrade,
  type Rejection,
  type SetupState,
  type SignalLog,
  type StrategyId,
  type StrategyProfile,
} from "./types.js";

export const STRATEGY_VERSION = "1.0.0";

export interface GoldData {
  /** The finest bars, oldest first, in price units (bid). `spread` (price units) is used when the cost model says "data". */
  base: Mt5Bar[];
  baseTf: Tf;
}

export interface RunOpts {
  profiles?: StrategyProfile[];
  /** Run exactly these strategies (each independently), whatever the frequency profile says. */
  strategies?: StrategyId[];
  /** Trade only inside [from, to) (ms). Earlier bars warm up indicators; nothing is armed before `from`. */
  from?: number;
  to?: number;
  /** Closed trades from BEFORE `from` (e.g. the previous walk-forward window), for drawdown-aware weights. Never future data. */
  priorTrades?: GoldTrade[];
  maxLogs?: number;
  maxRejections?: number;
  /** Fixed value for code_commit (tests); otherwise `git rev-parse`. */
  commit?: string;
  /** Diagnostics: called on every accepted stop change. Used by tests to prove a stop only ever tightens. */
  trace?: (e: { position: number; strategy: StrategyId; side: "BUY" | "SELL"; from: number; to: number; source: string; ts: number }) => void;
}

const gitCommit = (): string => {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "unknown";
  } catch {
    return "unknown";
  }
};

interface TfData {
  tf: Tf;
  ms: number;
  bars: Candle[];
  atr: Map<number, Float64Array>;
  swings: Map<string, SwingIndex>;
  /** Index of the last bar closed so far, and the bars that closed at the current base close. */
  ptr: number;
  fresh: number[];
}

interface Setup {
  id: StrategyId;
  side: "BUY" | "SELL";
  state: SetupState;
  level: Level | null;
  orderPx: number;
  sl: number;
  tp: number;
  lots: number;
  riskCash: number;
  riskPct: number;
  armedTs: number;
  expiresTs: number;
  scale: number;
  armDistance: number;
  spread: number;
  atr: number;
  /** candle_close_breakout: fill at the next base bar's open. */
  marketNext: boolean;
  entryBarRange: number;
  levelKey: string;
}

interface Position {
  id: number;
  strategy: StrategyId;
  side: "BUY" | "SELL";
  lots: number;
  entryPx: number;
  entryTs: number;
  entryClose: number;
  sl: number;
  tp: number;
  sl0: number;
  tp0: number;
  slSource: "initial" | "be" | "trail" | "structure";
  level: Level;
  riskCash0: number;
  riskPct: number;
  peak: number;
  mfe: number;
  mae: number;
  mfeTs: number;
  maeTs: number;
  tpExt: number;
  commission: number;
  swap: number;
  fake: { enabled: boolean; state: "off" | "pending" | "passed" | "failed"; checks: Array<{ tf: Tf; left: number }> };
  quality: { armDistance: number; atr: number; spread: number; barRange: number; norm: number; tf: Tf; signalTs: number };
  entryBase: number;
  fillBarSeen: boolean;
}

export function runGold(cfgIn: unknown, data: GoldData, opts: RunOpts = {}): GoldRun {
  const cfg: EngineConfig = EngineSchema.parse(cfgIn ?? {});
  assertResearchOnly(cfg);
  const warnings: string[] = [];
  const profiles = (opts.profiles ?? defaultProfiles()).map((p) => StrategySchema.parse(p));
  const active = opts.strategies ? profiles.filter((p) => opts.strategies!.includes(p.id) && p.enabled) : activeProfiles(profiles, cfg.frequency);
  const order = [...active].sort((a, b) => a.id.localeCompare(b.id));
  const base = data.base;
  const baseTf = data.baseTf;
  const baseMs = TF_MS[baseTf];
  if (cfg.base_timeframe !== baseTf) warnings.push(`config base_timeframe ${cfg.base_timeframe} differs from the data's ${baseTf}: the data's is used`);
  const con = cfg.contract;
  const slip = cfg.costs.slippage;
  const from = opts.from ?? -Infinity;
  const to = opts.to ?? Infinity;
  const maxLogs = opts.maxLogs ?? 20_000;
  const maxRej = opts.maxRejections ?? 5_000;

  // ---------- timeframes ----------
  const clampTf = (tf: Tf, why: string): Tf => {
    if (TF_MS[tf] < baseMs) {
      warnings.push(`${why} ${tf} is finer than the base ${baseTf}: ${baseTf} is used`);
      return baseTf;
    }
    return tf;
  };
  const tfs = new Map<Tf, TfData>();
  const tfData = (tf: Tf): TfData => {
    let d = tfs.get(tf);
    if (!d) {
      const ms = TF_MS[tf];
      d = { tf, ms, bars: tf === baseTf ? base : resample(base, baseMs, ms), atr: new Map(), swings: new Map(), ptr: -1, fresh: [] };
      tfs.set(tf, d);
    }
    return d;
  };
  const atrOf = (d: TfData, period: number) => {
    let a = d.atr.get(period);
    if (!a) d.atr.set(period, (a = S.atr(d.bars, period)));
    return a;
  };
  const swingsOf = (d: TfData, left: number, right: number) => {
    const k = `${left}:${right}`;
    let s = d.swings.get(k);
    if (!s) d.swings.set(k, (s = new SwingIndex(d.bars, left, right)));
    return s;
  };

  interface Rt {
    p: StrategyProfile;
    entry: TfData;
    exit: TfData;
    structTf: TfData;
    norm: NonNullable<EngineConfig["normalization"]>;
    refAtr: number | null;
    swEntry: SwingIndex;
    swStruct: SwingIndex;
    checks: Array<{ tf: Tf; bars: number }>;
    buy: Setup;
    sell: Setup;
    expiryMs: number;
  }
  const blank = (id: StrategyId, side: "BUY" | "SELL"): Setup => ({ id, side, state: "IDLE", level: null, orderPx: 0, sl: 0, tp: 0, lots: 0, riskCash: 0, riskPct: 0, armedTs: 0, expiresTs: 0, scale: 1, armDistance: 0, spread: 0, atr: 0, marketNext: false, entryBarRange: 0, levelKey: "" });
  const rts: Rt[] = order.map((p0) => {
    const p = p0;
    const entry = tfData(clampTf(p.entry_timeframe, `${p.id} entry timeframe`));
    const exit = tfData(clampTf(p.exit_timeframe, `${p.id} exit timeframe`));
    const structTf = tfData(clampTf(p.structure_trailing.timeframe ?? p.exit_timeframe, `${p.id} structure-trailing timeframe`));
    const norm = { ...cfg.normalization, ...(p.normalization ?? {}) };
    const refAtr = norm.mode === "ATR" || norm.mode === "HYBRID" ? (norm.reference_atr ?? referenceAtr(entry.bars, norm.atr_period)) : null;
    if ((norm.mode === "ATR" || norm.mode === "HYBRID") && refAtr === null) warnings.push(`${p.id}: no reference ATR available (too little data): volatility scaling is off`);
    const checks = fakeChecks(p).map((c) => ({ tf: clampTf(c.timeframe, `${p.id} fake-breakout check`), bars: c.bars }));
    for (const c of checks) tfData(c.tf);
    const expiryMs = p.entry.pending_expiry_minutes !== undefined ? p.entry.pending_expiry_minutes * 60_000 : (p.entry.pending_expiry_bars ?? 24) * entry.ms;
    return { p, entry, exit, structTf, norm, refAtr, swEntry: swingsOf(entry, p.structure.left_bars, p.structure.right_bars), swStruct: swingsOf(structTf, p.structure.left_bars, p.structure.right_bars), checks, buy: blank(p.id, "BUY"), sell: blank(p.id, "SELL"), expiryMs };
  });
  const allTfs = [...tfs.values()];
  const news = new NewsCalendar(cfg.filters.news.events, cfg.filters.news.block_minutes_before * 60_000, cfg.filters.news.block_minutes_after * 60_000);
  const tz = cfg.timezone;

  // ---------- state ----------
  let balance = cfg.account.initial_balance;
  let equity = balance;
  let nextId = 1;
  const positions: Position[] = [];
  const trades: GoldTrade[] = [];
  const logs: SignalLog[] = [];
  const rejections: Rejection[] = [];
  const rejectionCounts: Record<string, number> = {};
  const transitions: Record<string, number> = {};
  const equityCurve: Array<[number, number]> = [];
  const balanceCurve: Array<[number, number]> = [];
  const killed: GoldRun["killed"] = [];
  let peakOpenRiskPct = 0;
  let curDay = NaN;
  let curWeek = NaN;
  let dayStartEquity = equity;
  let weekStartEquity = equity;
  let blockedDay = NaN;
  let blockedWeek = NaN;
  const prior = opts.priorTrades ?? [];
  const strategyPnl = new Map<StrategyId, number[]>();
  for (const t of prior) strategyPnl.set(t.strategy, [...(strategyPnl.get(t.strategy) ?? []), t.pnl]);
  let weights: Record<string, number> = Object.fromEntries(order.map((p) => [p.id, p.risk.weight]));

  const reject = (ts: number, strategy: StrategyId, side: "BUY" | "SELL", reason: string) => {
    const key = reason.replace(/[\d.]+/g, "#");
    rejectionCounts[key] = (rejectionCounts[key] ?? 0) + 1;
    if (rejections.length < maxRej) rejections.push({ ts, strategy, side, reason });
  };
  const move = (st: Setup, to: SetupState, ts: number, note?: string, force = false) => {
    if (st.state === to && !force) return;
    st.state = to;
    transitions[`${st.id}.${to}`] = (transitions[`${st.id}.${to}`] ?? 0) + 1;
    const noisy = to === "PENDING" || to === "TRIGGERED" || to === "EXPIRED" || to === "INVALIDATED" || to.startsWith("CANCELLED") || to === "FAKE_BREAKOUT_EXIT" || to === "CLOSED";
    if (noisy && logs.length < maxLogs && st.level) {
      logs.push({ strategy: st.id, time: new Date(ts).toISOString(), side: st.side, state: to, level: st.level.price, entry: st.orderPx, stop: st.sl, target: st.tp, level_age_bars: st.level.ageBars, arm_distance: st.armDistance, spread: st.spread, normalization_factor: st.scale, risk_pct: st.riskPct, lots: st.lots, ...(note ? { note } : {}) });
    }
  };
  const clearSetup = (st: Setup) => {
    st.level = null;
    st.orderPx = st.sl = st.tp = st.lots = st.riskCash = st.riskPct = 0;
    st.marketNext = false;
    st.levelKey = "";
  };

  const spreadAt = (b: Mt5Bar) => (cfg.costs.spread.kind === "data" && b.spread !== undefined && Number.isFinite(b.spread) ? b.spread : cfg.costs.spread.value);
  const dirOf = (side: "BUY" | "SELL") => (side === "BUY" ? 1 : -1);
  /** Cash P&L for a price move `d` (already signed for the position) on `lots`. */
  const cash = (lots: number, d: number) => lots * (d / con.tick_size) * con.tick_value;
  const riskNow = (p: Position) => Math.max(0, lots_risk(p));
  const lots_risk = (p: Position) => cash(p.lots, dirOf(p.side) * (p.entryPx - p.sl));

  const reservedNow = (): Reserved => {
    const pending = new Map<StrategyId, number>();
    for (const r of rts) {
      const a = r.buy.state === "PENDING" || (r.buy.state === "ARMED" && r.buy.marketNext) ? r.buy.riskCash : 0;
      const b = r.sell.state === "PENDING" || (r.sell.state === "ARMED" && r.sell.marketNext) ? r.sell.riskCash : 0;
      // A straddle with OCO can only ever add one side's risk; without OCO both sides can fill.
      const m = r.p.entry.oco ? Math.max(a, b) : a + b;
      if (m > 0) pending.set(r.p.id, m);
    }
    return { open: positions.reduce((a, p) => a + riskNow(p), 0), pending };
  };
  const trackPeak = () => {
    const r = reservedNow();
    const tot = r.open + (cfg.risk.reserve_pending_risk ? [...r.pending.values()].reduce((a, b) => a + b, 0) : 0);
    if (equity > 0) peakOpenRiskPct = Math.max(peakOpenRiskPct, (tot / equity) * 100);
  };

  // ---------- opening and closing ----------
  const openPosition = (r: Rt, st: Setup, fillPx: number, ts: number, closeTs: number, baseIdx: number, bar: Mt5Bar) => {
    const commission = (cfg.costs.commission_per_lot / 2) * st.lots;
    balance -= commission;
    const pos: Position = {
      id: nextId++,
      strategy: st.id,
      side: st.side,
      lots: st.lots,
      entryPx: fillPx,
      entryTs: ts,
      entryClose: closeTs,
      sl: st.sl,
      tp: st.tp,
      sl0: st.sl,
      tp0: st.tp,
      slSource: "initial",
      level: st.level!,
      riskCash0: st.riskCash,
      riskPct: st.riskPct,
      peak: fillPx,
      mfe: 0,
      mae: 0,
      mfeTs: ts,
      maeTs: ts,
      tpExt: 0,
      commission,
      swap: 0,
      fake: { enabled: r.checks.length > 0, state: r.checks.length ? "pending" : "off", checks: r.checks.map((c) => ({ tf: c.tf, left: c.bars })) },
      quality: { armDistance: st.armDistance, atr: st.atr, spread: spreadAt(bar), barRange: st.entryBarRange, norm: st.scale, tf: r.entry.tf, signalTs: st.armedTs },
      entryBase: baseIdx,
      fillBarSeen: false,
    };
    positions.push(pos);
    move(st, "TRIGGERED", ts);
    move(st, pos.fake.enabled ? "CONFIRMING" : "MANAGING", ts);
    return pos;
  };

  const closePosition = (pos: Position, px: number, ts: number, reason: ExitReason, baseIdx: number) => {
    const d = dirOf(pos.side);
    const gross = cash(pos.lots, d * (px - pos.entryPx));
    const commission = (cfg.costs.commission_per_lot / 2) * pos.lots;
    balance += gross - commission;
    const totalCommission = pos.commission + commission;
    const pnl = gross - totalCommission - pos.swap;
    const risk0 = pos.riskCash0 || 1;
    trades.push({
      id: pos.id,
      strategy: pos.strategy,
      magic: magicOf(pos.strategy),
      side: pos.side,
      signalTs: pos.quality.signalTs,
      entryTs: pos.entryTs,
      exitTs: ts,
      level: pos.level.price,
      entryPx: pos.entryPx,
      exitPx: px,
      sl0: pos.sl0,
      tp0: pos.tp0,
      lots: pos.lots,
      pnl,
      pnlPrice: d * (px - pos.entryPx),
      commission: totalCommission,
      swap: pos.swap,
      r: pnl / risk0,
      riskAtEntry: pos.riskCash0,
      riskPct: pos.riskPct,
      exitReason: reason,
      bars: baseIdx - pos.entryBase,
      minutes: (ts - pos.entryTs) / 60_000,
      quality: {
        armDistance: pos.quality.armDistance,
        levelAgeBars: pos.level.ageBars,
        touches: pos.level.touches,
        minutesSinceLastTouch: pos.level.minutesSinceLastTouch,
        atrAtEntry: pos.quality.atr,
        spreadAtEntry: pos.quality.spread,
        breakoutBarRange: pos.quality.barRange,
        mfe: pos.mfe,
        mae: pos.mae,
        mfeR: pos.mfe / Math.max(1e-9, Math.abs(pos.entryPx - pos.sl0)),
        maeR: pos.mae / Math.max(1e-9, Math.abs(pos.entryPx - pos.sl0)),
        minutesToMfe: (pos.mfeTs - pos.entryTs) / 60_000,
        minutesToMae: (pos.maeTs - pos.entryTs) / 60_000,
        fakeBreakout: pos.fake.state === "off" ? "off" : pos.fake.state === "failed" ? "failed" : "passed",
        normalizationFactor: pos.quality.norm,
        entryTimeframe: pos.quality.tf,
      },
    });
    const strat = strategyPnl.get(pos.strategy) ?? [];
    strat.push(pnl);
    strategyPnl.set(pos.strategy, strat);
    balanceCurve.push([ts, balance]);
    positions.splice(positions.indexOf(pos), 1);
    const r = rts.find((x) => x.p.id === pos.strategy);
    const st = r ? (pos.side === "BUY" ? r.buy : r.sell) : null;
    if (st && (st.state === "MANAGING" || st.state === "CONFIRMING")) {
      move(st, reason === "FAKE_BREAKOUT" ? "FAKE_BREAKOUT_EXIT" : "CLOSED", ts, reason, true);
      clearSetup(st);
      st.state = "IDLE";
    }
  };

  /** Exit price at the close of a bar for a market-style exit (news, session, kill, fake breakout, end). */
  const marketExit = (pos: Position, bar: Mt5Bar, spr: number) => (pos.side === "BUY" ? bar.c - slip : bar.c + spr + slip);

  const cancelPending = (st: Setup, to: SetupState, ts: number, note?: string) => {
    if (st.state !== "PENDING" && st.state !== "ARMED") return;
    move(st, to, ts, note, true);
    clearSetup(st);
    st.state = "IDLE";
  };

  // ---------- fills inside the bar ----------
  const freeMargin = () => equity - positions.reduce((a, p) => a + marginFor(con, p.lots, p.entryPx), 0);

  const tryFill = (r: Rt, st: Setup, fillPx: number, i: number, bar: Mt5Bar, spr: number, opp: Setup) => {
    const ts = Math.max(bar.ts, bar.ts);
    const closeTs = bar.ts + baseMs;
    const d = dirOf(st.side);
    const sameDir = positions.filter((p) => p.side === st.side).length;
    // The fill price can differ from the order price (a gap, slippage): re-check the ceiling with the risk it really carries.
    const actualRisk = cash(st.lots, d * (fillPx - st.sl));
    const resv = reservedNow();
    const othersPending = [...resv.pending].filter(([id]) => id !== st.id).reduce((a, [, v]) => a + v, 0);
    const overCeiling = cfg.risk.reserve_pending_risk && resv.open + othersPending + actualRisk > (cfg.risk.max_open_risk_pct / 100) * equity + 1e-9;
    const why =
      overCeiling ? "open risk ceiling"
      : positions.length >= cfg.risk.max_concurrent_positions ? "max concurrent positions"
      : sameDir >= cfg.risk.max_correlated_positions ? "max correlated positions"
      : marginFor(con, st.lots, fillPx) > freeMargin() ? "insufficient margin"
      : null;
    if (why) {
      reject(ts, st.id, st.side, `fill refused: ${why}`);
      cancelPending(st, "CANCELLED_RISK", ts, why);
      return null;
    }
    const pos = openPosition(r, st, fillPx, ts, closeTs, i, bar);
    if (r.p.entry.oco && (opp.state === "PENDING" || opp.state === "ARMED")) cancelPending(opp, "CANCELLED_OCO", ts);
    trackPeak();
    // Same-bar stop: the stop is checked, the target is not (the order of events inside the bar is unknowable).
    const stopHit = d === 1 ? bar.l <= pos.sl : bar.h + spr >= pos.sl;
    if (stopHit) {
      const px = d === 1 ? pos.sl - slip : pos.sl + slip;
      closePosition(pos, px, closeTs, "SL", i);
      return null;
    }
    return pos;
  };

  // ---------- management at the bar close ----------
  const manage = (pos: Position, r: Rt, i: number, bar: Mt5Bar, spr: number, T: number): boolean => {
    const d = dirOf(pos.side);
    const scale = pos.quality.norm;
    const p = r.p;
    const bidNow = bar.c;
    const askNow = bar.c + spr;
    const mkt = d === 1 ? bidNow : askNow;
    const stopDist = con.stop_level_points * con.point_size;
    const freeze = con.freeze_level_points * con.point_size;
    const canModify = () => freeze <= 0 || Math.abs(mkt - pos.sl) > freeze;
    const legal = (cand: number) => (d === 1 ? cand < bidNow - stopDist : cand > askNow + stopDist);
    const better = (cand: number) => (d === 1 ? cand > pos.sl : cand < pos.sl);
    const setSl = (cand: number, src: Position["slSource"]) => {
      if (!better(cand)) return;
      if (!canModify()) return void reject(T, pos.strategy, pos.side, "stop modification refused: inside freeze level");
      if (!legal(cand)) return void reject(T, pos.strategy, pos.side, "stop modification refused: inside stop level");
      opts.trace?.({ position: pos.id, strategy: pos.strategy, side: pos.side, from: pos.sl, to: cand, source: src, ts: T });
      pos.sl = cand;
      pos.slSource = src;
    };

    // 1. fake-breakout checkpoints: the first bar of each timeframe that closes after the fill
    if (pos.fake.state === "pending") {
      const ref = (p.fake_breakout.reference === "entry" ? pos.entryPx : pos.level.price) + (d === 1 ? -1 : 1) * p.fake_breakout.tolerance_points * con.point_size;
      for (const chk of pos.fake.checks) {
        if (chk.left <= 0) continue;
        const td = tfs.get(chk.tf)!;
        for (const bi of td.fresh) {
          const tb = td.bars[bi]!;
          if (tb.ts + td.ms < pos.entryClose) continue; // closed before the fill bar did
          if (chk.left <= 0) break;
          const fail = d === 1 ? tb.c < ref : tb.c > ref;
          if (fail && p.fake_breakout.close_on_failure) {
            pos.fake.state = "failed";
            closePosition(pos, marketExit(pos, bar, spr), T, "FAKE_BREAKOUT", i);
            return true;
          }
          if (fail) pos.fake.state = "failed";
          chk.left--;
        }
      }
      if (pos.fake.state === "pending" && pos.fake.checks.every((c) => c.left <= 0)) {
        pos.fake.state = "passed";
        const st = pos.side === "BUY" ? r.buy : r.sell;
        if (st.state === "CONFIRMING") move(st, "MANAGING", T);
      }
    }

    // 2. track the excursion and the peak (bid highs for a long, ask lows for a short); the fill bar counts by its close only
    const fav = d === 1 ? (pos.fillBarSeen ? bar.h : bar.c) - pos.entryPx : pos.entryPx - (pos.fillBarSeen ? bar.l + spr : bar.c + spr);
    const adv = d === 1 ? pos.entryPx - (pos.fillBarSeen ? bar.l : bar.c) : (pos.fillBarSeen ? bar.h + spr : bar.c + spr) - pos.entryPx;
    if (fav > pos.mfe) {
      pos.mfe = fav;
      pos.mfeTs = T;
    }
    if (adv > pos.mae) {
      pos.mae = adv;
      pos.maeTs = T;
    }
    pos.peak = d === 1 ? Math.max(pos.peak, pos.entryPx + pos.mfe) : Math.min(pos.peak, pos.entryPx - pos.mfe);
    pos.fillBarSeen = true;

    // 3. break-even
    if (p.break_even.enabled && pos.mfe >= p.break_even.trigger_distance * scale) setSl(pos.entryPx + d * p.break_even.lock_distance * scale, "be");
    // 4. classic trailing
    if (p.trailing.enabled && pos.mfe >= p.trailing.trigger_distance * scale) setSl(pos.peak - d * p.trailing.distance * scale, "trail");
    // 5. structure trailing: the latest swing on the exit timeframe formed AFTER the entry and already confirmed
    if (p.structure_trailing.enabled) {
      const td = r.structTf;
      const k = td.ptr;
      if (k >= 0) {
        const sw = r.swStruct.known(d === 1 ? "low" : "high", k, 400);
        const last = [...sw].reverse().find((s) => td.bars[s.index]!.ts >= pos.entryTs);
        if (last) setSl(last.price - d * p.structure_trailing.offset * scale, "structure");
      }
    }
    // 6. trailing take profit
    if (p.trailing_tp.enabled && pos.tpExt < p.trailing_tp.max_extensions) {
      const toTp = d === 1 ? pos.tp - (pos.entryPx + pos.mfe) : pos.entryPx - pos.mfe - pos.tp;
      if (toTp <= p.trailing_tp.trigger_distance * scale) {
        pos.tp += d * p.trailing_tp.extend_distance * scale;
        pos.tpExt++;
      }
    }
    return false;
  };

  // ---------- arming ----------
  const priceWeights = () => weights;

  const armStrategy = (r: Rt, T: number, bar: Mt5Bar, spr: number) => {
    const k = r.entry.ptr;
    if (k < 0) return;
    const p = r.p;
    const bidNow = bar.c;
    const askNow = bar.c + spr;
    const atrArr = atrOf(r.entry, r.norm.atr_period);
    const atr = Number.isFinite(atrArr[k]!) ? atrArr[k]! : null;
    const scale = scaleFactor(r.norm, { price: bidNow, atr, refAtr: r.refAtr });
    const tol = atr !== null ? 0.25 * atr : 0.1;
    const hasPos = positions.some((x) => x.strategy === p.id);
    for (const st of [r.buy, r.sell]) {
      if (st.state === "MANAGING" || st.state === "CONFIRMING" || hasPos) continue;
      const kind = st.side === "BUY" ? "high" : "low";
      const lvl = selectLevel(r.entry.bars, r.swEntry, k, kind, p.structure.level_selection, p.structure.max_lookback_bars, st.side === "BUY" ? askNow : bidNow, tol, r.entry.ms);
      // A pending order lives until it fills, expires, or the structure it stood on changes.
      if (st.state === "PENDING" || (st.state === "ARMED" && st.marketNext === false && p.entry.mode === "candle_close_breakout")) {
        if (T >= st.expiresTs) {
          cancelPending(st, "EXPIRED", T);
        } else if (!lvl || lvl.price !== st.level!.price) {
          cancelPending(st, "INVALIDATED", T, "structure changed");
        } else if (p.entry.mode === "candle_close_breakout" && st.state === "ARMED") {
          const cb = r.entry.bars[k]!;
          const trig = st.side === "BUY" ? st.level!.price + p.entry.breakout_offset * st.scale : st.level!.price - p.entry.breakout_offset * st.scale;
          if (st.side === "BUY" ? cb.c >= trig : cb.c <= trig) {
            st.marketNext = true;
            st.entryBarRange = cb.h - cb.l;
          }
          continue;
        } else continue;
      }
      if (st.state === "ARMED" && st.marketNext) continue;
      if (!lvl) {
        if (st.state !== "IDLE") move(st, "IDLE", T);
        continue;
      }
      move(st, "STRUCTURE_FOUND", T);
      const armDist = p.entry.min_arm_distance * scale;
      const distance = st.side === "BUY" ? lvl.price - askNow : bidNow - lvl.price;
      if (distance < armDist) {
        move(st, "WAITING_FOR_DISTANCE", T);
        continue;
      }
      move(st, "ARMED", T);
      // ---- eligibility ----
      const blockedNow = (Number.isFinite(blockedDay) && dayKey(T, tz) === blockedDay) || (Number.isFinite(blockedWeek) && weekKey(T, tz) === blockedWeek);
      const sp = spreadOk(cfg.filters.spread, spr, atr);
      const wk = weekendState(cfg.filters.weekend, tz, T);
      const ne = cfg.filters.news.enabled ? news.at(T) : null;
      const blockNews = ne !== null && cfg.filters.news.policies.includes("BLOCK_NEW_ENTRIES");
      const why = blockedNow ? "risk kill active" : !sp.ok ? `spread filter: ${sp.reason}` : !sessionOk(cfg.filters.sessions, p, T) ? "outside sessions" : blockNews ? `news blackout (${ne!.name})` : wk.blockEntries || wk.nearClose ? "weekend" : null;
      if (why) {
        reject(T, p.id, st.side, why);
        continue;
      }
      // ---- the order ----
      const off = p.entry.breakout_offset * scale;
      const entryPx = st.side === "BUY" ? lvl.price + off : lvl.price - off;
      const d = dirOf(st.side);
      const sl = entryPx - d * p.stop_loss.base_distance * scale;
      const tp = entryPx + d * p.take_profit.base_distance * scale;
      const distMkt = Math.abs(entryPx - (st.side === "BUY" ? askNow : bidNow));
      if (!stopLevelOk(con, distMkt) || !stopLevelOk(con, Math.abs(entryPx - sl))) {
        reject(T, p.id, st.side, "stop level: order too close to the market");
        continue;
      }
      // duplicate-level protection across strategies
      let dupFactor = 1;
      const dup = cfg.duplicate_levels;
      if (dup.action !== "ALLOW") {
        const clash = [...rts.filter((x) => x !== r).map((x) => (st.side === "BUY" ? x.buy : x.sell)).filter((x) => x.state === "PENDING" && Math.abs(x.orderPx - entryPx) <= dup.cluster_tolerance), ...[]];
        const clashPos = positions.find((x) => x.side === st.side && x.strategy !== p.id && Math.abs(x.level.price - lvl.price) <= dup.cluster_tolerance);
        if (clash.length || clashPos) {
          if (dup.action === "MERGE") {
            reject(T, p.id, st.side, "duplicate level: merged into an existing order");
            continue;
          }
          if (dup.action === "KEEP_HIGHEST_PRIORITY") {
            const mine = priceWeights()[p.id] ?? 0;
            const beaten = !clashPos && clash.every((x) => (priceWeights()[x.id] ?? 0) < mine);
            if (!beaten) {
              reject(T, p.id, st.side, "duplicate level: a higher-priority order holds it");
              continue;
            }
            for (const x of clash) cancelPending(x, "INVALIDATED", T, `replaced by ${p.id}`);
          }
          if (dup.action === "REDUCE_POSITION_SIZE") dupFactor = dup.reduce_factor;
        }
      }
      const newsFactor = ne !== null && cfg.filters.news.policies.includes("REDUCE_RISK") ? cfg.filters.news.reduce_risk_factor : 1;
      const w = Math.min(1, priceWeights()[p.id] ?? p.risk.weight);
      const riskFrac = (p.risk.max_trade_risk_pct / 100) * w * dupFactor * newsFactor;
      const sized = sizeLots(con, equity, riskFrac, entryPx, sl);
      if (!sized.ok) {
        reject(T, p.id, st.side, `sizing: ${sized.reason}`);
        continue;
      }
      // portfolio: what is open plus what pendings could add must stay under the ceiling
      if (cfg.risk.reserve_pending_risk) {
        const res = reservedNow();
        const others = [...res.pending].filter(([id]) => id !== p.id).reduce((a, [, v]) => a + v, 0);
        const mine = Math.max(sized.riskCash, (st.side === "BUY" ? r.sell : r.buy).state === "PENDING" ? (st.side === "BUY" ? r.sell : r.buy).riskCash : 0);
        if (res.open + others + mine > (cfg.risk.max_open_risk_pct / 100) * equity + 1e-9) {
          reject(T, p.id, st.side, "portfolio: open risk ceiling");
          continue;
        }
      }
      st.level = lvl;
      st.orderPx = entryPx;
      st.sl = sl;
      st.tp = tp;
      st.lots = sized.lots;
      st.riskCash = sized.riskCash;
      st.riskPct = (sized.riskCash / equity) * 100;
      st.armedTs = T;
      st.expiresTs = T + r.expiryMs;
      st.scale = scale;
      st.armDistance = distance;
      st.spread = spr;
      st.atr = atr ?? 0;
      st.levelKey = `${kind}:${lvl.price}`;
      st.entryBarRange = r.entry.bars[k]!.h - r.entry.bars[k]!.l;
      if (p.entry.mode === "candle_close_breakout") {
        st.marketNext = false; // stays ARMED; fires when an entry-timeframe bar closes beyond level + offset
        transitions[`${p.id}.ARMED_WATCH`] = (transitions[`${p.id}.ARMED_WATCH`] ?? 0) + 1;
      } else move(st, "PENDING", T);
      trackPeak();
    }
  };

  // ---------- the main loop ----------
  const startIdx = 0;
  let lastBar: Mt5Bar | null = null;
  for (let i = startIdx; i < base.length; i++) {
    const b = base[i]!;
    if (b.ts >= to) break;
    const spr = spreadAt(b);
    const T = b.ts + baseMs;
    const trading = b.ts >= from;

    // -- rollovers (broker timezone) --
    const dk = dayKey(b.ts, tz);
    if (dk !== curDay) {
      if (Number.isFinite(curDay) && trading) {
        equityCurve.push([b.ts, equity]);
        // swaps for the night just ended
        for (const pos of positions) {
          const s = pos.side === "BUY" ? cfg.costs.swap_long_per_lot_day : cfg.costs.swap_short_per_lot_day;
          const charge = -s * pos.lots;
          pos.swap += charge;
          balance -= charge;
        }
        // drawdown-aware weights from what has already closed
        if (cfg.drawdown_weighting.enabled) {
          const dd: Record<string, number> = {};
          const n: Record<string, number> = {};
          for (const [id, arr] of strategyPnl) {
            let c = 0;
            let pk = 0;
            let m = 0;
            for (const x of arr) {
              c += (x / cfg.account.initial_balance) * 100;
              pk = Math.max(pk, c);
              m = Math.max(m, pk - c);
            }
            dd[id] = m;
            n[id] = arr.length;
          }
          weights = blendedWeights(order, dd, n, cfg.drawdown_weighting);
        }
      }
      curDay = dk;
      dayStartEquity = equity;
      if (Number.isFinite(blockedDay) && blockedDay !== dk) blockedDay = NaN;
    }
    const wk = weekKey(b.ts, tz);
    if (wk !== curWeek) {
      curWeek = wk;
      weekStartEquity = equity;
      if (Number.isFinite(blockedWeek) && blockedWeek !== wk) blockedWeek = NaN;
    }

    // -- A. inside the bar --
    for (const r of rts) {
      for (const [st, opp] of [[r.buy, r.sell], [r.sell, r.buy]] as const) {
        if (!trading) break;
        if (st.state === "PENDING") {
          const d = dirOf(st.side);
          const trig = d === 1 ? b.h + spr >= st.orderPx : b.l <= st.orderPx;
          if (!trig) continue;
          const fillPx = d === 1 ? Math.max(st.orderPx, b.o + spr) + slip : Math.min(st.orderPx, b.o) - slip;
          tryFill(r, st, fillPx, i, b, spr, opp);
        } else if (st.state === "ARMED" && st.marketNext) {
          const d = dirOf(st.side);
          const fillPx = d === 1 ? b.o + spr + slip : b.o - slip;
          st.marketNext = false;
          tryFill(r, st, fillPx, i, b, spr, opp);
        }
      }
    }
    // positions that were open before this bar: stop first, then target
    for (const pos of [...positions]) {
      if (pos.entryBase === i) continue;
      const d = dirOf(pos.side);
      const stopHit = d === 1 ? b.l <= pos.sl : b.h + spr >= pos.sl;
      const reason = pos.slSource === "be" ? "BE" : pos.slSource === "trail" ? "TRAIL" : pos.slSource === "structure" ? "STRUCTURE_TRAIL" : "SL";
      if (stopHit) {
        const px = d === 1 ? Math.min(b.o, pos.sl) - slip : Math.max(b.o + spr, pos.sl) + slip;
        closePosition(pos, px, T, reason, i);
        continue;
      }
      const tpHit = d === 1 ? b.h >= pos.tp : b.l + spr <= pos.tp;
      if (tpHit) {
        const px = d === 1 ? Math.max(b.o, pos.tp) : Math.min(b.o + spr, pos.tp);
        closePosition(pos, px, T, "TP", i);
      }
    }

    // -- B. at the close --
    for (const td of allTfs) {
      td.fresh.length = 0;
      while (td.ptr + 1 < td.bars.length && td.bars[td.ptr + 1]!.ts + td.ms <= T) {
        td.ptr++;
        td.fresh.push(td.ptr);
      }
    }
    // mark to market at the close (longs at the bid, shorts at the ask)
    let floating = 0;
    for (const pos of positions) floating += cash(pos.lots, dirOf(pos.side) * ((pos.side === "BUY" ? b.c : b.c + spr) - pos.entryPx));
    equity = balance + floating;
    lastBar = b;
    if (!trading) continue;

    // risk kill: daily and weekly loss limits
    const dLoss = dayStartEquity > 0 ? ((dayStartEquity - equity) / dayStartEquity) * 100 : 0;
    const wLoss = weekStartEquity > 0 ? ((weekStartEquity - equity) / weekStartEquity) * 100 : 0;
    const dailyBreach = dLoss >= cfg.risk.max_daily_loss_pct;
    const weeklyBreach = wLoss >= cfg.risk.max_weekly_loss_pct;
    if ((dailyBreach && !(Number.isFinite(blockedDay) && blockedDay === dk)) || (weeklyBreach && !(Number.isFinite(blockedWeek) && blockedWeek === wk))) {
      if (weeklyBreach) blockedWeek = wk;
      if (dailyBreach) blockedDay = dk;
      killed.push({ ts: T, kind: weeklyBreach ? "weekly" : "daily", equity });
      for (const pos of [...positions]) closePosition(pos, marketExit(pos, b, spr), T, "RISK_KILL", i);
      for (const r of rts) for (const st of [r.buy, r.sell]) cancelPending(st, "CANCELLED_RISK", T, "risk kill");
      equity = balance;
      continue;
    }

    // news and the weekend
    if (cfg.filters.news.enabled) {
      const ev = news.at(T);
      if (ev) {
        const pol = cfg.filters.news.policies;
        if (pol.includes("CANCEL_PENDING")) for (const r of rts) for (const st of [r.buy, r.sell]) cancelPending(st, "CANCELLED_NEWS", T, ev.name);
        if (pol.includes("CLOSE_POSITIONS")) for (const pos of [...positions]) closePosition(pos, marketExit(pos, b, spr), T, "NEWS_EXIT", i);
      }
    }
    const wkd = weekendState(cfg.filters.weekend, tz, T);
    if (wkd.nearClose) {
      if (cfg.filters.weekend.cancel_pending_before_close) for (const r of rts) for (const st of [r.buy, r.sell]) cancelPending(st, "CANCELLED_NEWS", T, "weekend");
      if (cfg.filters.weekend.force_flat_before_close) for (const pos of [...positions]) closePosition(pos, marketExit(pos, b, spr), T, "SESSION_EXIT", i);
    }

    // manage what is open
    for (const pos of [...positions]) {
      const r = rts.find((x) => x.p.id === pos.strategy)!;
      manage(pos, r, i, b, spr, T);
    }
    // arm and re-arm: only when the strategy's entry timeframe has just closed a bar
    for (const r of rts) if (r.entry.fresh.length) armStrategy(r, T, b, spr);
    // a candle-close breakout that just fired is filled at the next bar's open; nothing else to do here
  }

  // ---------- the end ----------
  const last = lastBar ?? base[base.length - 1];
  if (last) {
    const spr = spreadAt(last);
    for (const pos of [...positions]) closePosition(pos, marketExit(pos, last, spr), last.ts + baseMs, "END", base.length - 1);
    for (const r of rts) for (const st of [r.buy, r.sell]) cancelPending(st, "CANCELLED_NEWS", last.ts, "end of data");
    equity = balance;
    equityCurve.push([last.ts + baseMs, equity]);
  }

  const cHash = configHash({ cfg, profiles: order, from: opts.from ?? null, to: opts.to ?? null });
  const dHash = dataHash(base);
  return {
    cfg,
    profiles: order,
    trades,
    equity: equityCurve,
    balance: balanceCurve,
    logs,
    rejections,
    rejectionCounts,
    transitions,
    peakOpenRiskPct,
    killed,
    meta: {
      run_id: createHash("sha256").update(`${cHash}:${dHash}:${cfg.seed}:${STRATEGY_VERSION}`).digest("hex").slice(0, 12),
      strategy_version: STRATEGY_VERSION,
      config_hash: cHash,
      data_hash: dHash,
      code_commit: opts.commit ?? gitCommit(),
      start_date: base[0] ? new Date(base[Math.max(0, base.findIndex((x) => x.ts >= from))]!.ts).toISOString() : "",
      end_date: last ? new Date(last.ts + baseMs).toISOString() : "",
      spread_model: cfg.costs.spread.kind === "data" ? `bar data (fallback ${cfg.costs.spread.value})` : `fixed ${cfg.costs.spread.value}`,
      slippage_model: `fixed ${cfg.costs.slippage} on stop and market fills; commission ${cfg.costs.commission_per_lot}/lot round turn`,
      timezone: cfg.timezone,
      random_seed: cfg.seed,
      base_timeframe: baseTf,
      warnings,
    },
  };
}
