// The output contract (section 55): every research run returns the same thirteen things, and the report leads with the
// drawdown and lists the losing periods (section 63). Sanity checks are run on the result itself, and any validation
// that was not run counts as not passed.
import { StrategySchema, type GoldRun } from "../types.js";
import type { AblationRow } from "./ablation.js";
import { qualityBreakdown, runMetrics, type Metrics, type RunMetrics } from "./metrics.js";
import type { McResult } from "./montecarlo.js";
import type { StabilityReport } from "./stability.js";
import type { WfResult } from "./walkforward.js";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/** Invariants that must hold for any run; a failure here means the engine (or the data) is wrong, not the strategy. */
export function sanityChecks(run: GoldRun): Check[] {
  const c = run.cfg;
  const t = run.trades;
  const out: Check[] = [];
  const noStop = t.filter((x) => !(x.side === "BUY" ? x.sl0 < x.entryPx : x.sl0 > x.entryPx));
  out.push({ name: "every trade opened with a hard stop on the losing side", ok: noStop.length === 0, detail: noStop.length ? `${noStop.length} trades` : `${t.length} trades checked` });
  out.push({ name: "open + reserved risk stayed under the ceiling", ok: !c.risk.reserve_pending_risk || run.peakOpenRiskPct <= c.risk.max_open_risk_pct + 1e-6, detail: `peak ${run.peakOpenRiskPct.toFixed(3)}% of ${c.risk.max_open_risk_pct}%` });
  const badLots = t.filter((x) => x.lots < c.contract.volume_min - 1e-9 || x.lots > c.contract.volume_max + 1e-9);
  out.push({ name: "lot sizes are legal", ok: badLots.length === 0, detail: badLots.length ? `${badLots.length} illegal` : "all within min/max" });
  const early = t.filter((x) => x.entryTs < x.signalTs);
  out.push({ name: "no trade entered before its order was armed", ok: early.length === 0, detail: early.length ? `${early.length} trades` : "ok" });
  const backwards = t.filter((x) => x.exitTs < x.entryTs);
  out.push({ name: "exits come after entries", ok: backwards.length === 0, detail: backwards.length ? `${backwards.length} trades` : "ok" });
  const ev = t.flatMap((x) => [[x.entryTs, 1, x.side], [x.exitTs, -1, x.side]] as Array<[number, number, string]>).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let open = 0;
  let maxOpen = 0;
  const dir: Record<string, number> = { BUY: 0, SELL: 0 };
  let maxDir = 0;
  for (const [, k, s] of ev) {
    open += k;
    dir[s]! += k;
    maxOpen = Math.max(maxOpen, open);
    maxDir = Math.max(maxDir, dir[s]!);
  }
  out.push({ name: "concurrent and same-direction positions within limits", ok: maxOpen <= c.risk.max_concurrent_positions && maxDir <= c.risk.max_correlated_positions, detail: `max ${maxOpen}/${c.risk.max_concurrent_positions} open, ${maxDir}/${c.risk.max_correlated_positions} same direction` });
  out.push({ name: "live trading disabled", ok: c.live_trading === false, detail: `mode ${c.mode}` });
  out.push({ name: "no martingale or averaging: one position per strategy at a time", ok: true, detail: "by construction" });
  return out;
}

export interface Gate {
  name: string;
  status: "pass" | "fail" | "not run";
  detail: string;
}

/** Thresholds a candidate configuration should clear before anyone considers paper trading it. */
export function validationGates(m: Metrics, x: { walkForward?: WfResult; monteCarlo?: McResult; stability?: StabilityReport }): Gate[] {
  const g: Gate[] = [];
  const wf = x.walkForward;
  g.push(wf ? { name: "walk-forward: at least 60% of validation windows profitable", status: wf.totalWindows > 0 && wf.positiveWindows / wf.totalWindows >= 0.6 ? "pass" : "fail", detail: `${wf.positiveWindows}/${wf.totalWindows} windows` } : { name: "walk-forward", status: "not run", detail: "no walk-forward was run" });
  g.push(wf ? { name: "walk-forward: out-of-sample expectancy above zero", status: wf.oos.expectancyR > 0 ? "pass" : "fail", detail: `${wf.oos.expectancyR.toFixed(3)} R per trade over ${wf.oos.trades} trades` } : { name: "out-of-sample expectancy", status: "not run", detail: "needs a walk-forward" });
  const mc = x.monteCarlo;
  g.push(mc ? { name: "Monte Carlo: probability of ruin at most 5%", status: mc.probabilityOfRuinPct <= 5 ? "pass" : "fail", detail: `${mc.probabilityOfRuinPct.toFixed(1)}%` } : { name: "Monte Carlo", status: "not run", detail: "no Monte Carlo was run" });
  g.push(mc ? { name: "Monte Carlo: probability of loss at most 30%", status: mc.probabilityOfLossPct <= 30 ? "pass" : "fail", detail: `${mc.probabilityOfLossPct.toFixed(1)}%` } : { name: "Monte Carlo loss probability", status: "not run", detail: "needs a Monte Carlo" });
  g.push(mc ? { name: "Monte Carlo: 95th percentile drawdown at most 30%", status: mc.p95MaxDrawdownPct <= 30 ? "pass" : "fail", detail: `${mc.p95MaxDrawdownPct.toFixed(1)}%` } : { name: "Monte Carlo drawdown", status: "not run", detail: "needs a Monte Carlo" });
  const st = x.stability;
  g.push(st ? { name: "parameter stability: a plateau, not isolated peaks", status: st.bestStable && st.plateauSharePct >= 30 ? "pass" : "fail", detail: `${st.plateauSharePct.toFixed(0)}% of positive points sit on a plateau; ${st.isolatedSharePct.toFixed(0)}% are isolated peaks` } : { name: "parameter stability", status: "not run", detail: "no parameter scan was run" });
  g.push({ name: "in-sample sanity: profit factor above 1", status: m.profitFactor > 1 ? "pass" : "fail", detail: `${Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : "inf"} (in-sample: never evidence by itself)` });
  return g;
}

export const LIMITATIONS = [
  "Bars are OHLC: the order of events inside a bar is unknowable, so the engine takes the pessimistic side (stop before target; nothing new fills and takes profit inside its own bar). Tick data would narrow this.",
  "Spread is fixed or read per bar from the data; real spreads widen sharply around news and rollover, and this model only sees what the data says.",
  "Slippage is a fixed amount on stop and market fills. Gold can gap far beyond it, especially at the weekly open.",
  "Swap is charged per lot per night at the broker-day rollover with no triple-swap day.",
  "News blackouts use the calendar you load; none is bundled, and without one the news filter cannot do anything.",
  "Higher timeframes are built from the base bars and aligned to UTC; a broker's own D1/H4 bucket edges differ, which moves swings and levels.",
  "One symbol, one account currency (USD), no margin call or stop-out model beyond a free-margin check at fill.",
  "Nothing here is a claim about any commercial EA. The nine profiles are starting hypotheses, not anyone's settings.",
  "Past and simulated results do not guarantee future results. Trading leveraged products such as XAUUSD can lose more than the account.",
];

export interface ReportExtras {
  dataSource: string;
  brokerAssumptions?: string[];
  stability?: StabilityReport;
  walkForward?: WfResult;
  monteCarlo?: McResult;
  ablation?: AblationRow[];
  notes?: string[];
}

export interface Report {
  /** 1 */ configuration: { engine: GoldRun["cfg"]; strategies: GoldRun["profiles"] };
  /** 2 */ dataPeriod: { start: string; end: string; baseTimeframe: string };
  /** 3 */ dataSource: string;
  /** 4 */ brokerAssumptions: string[];
  /** 5 */ tradeCount: number;
  /** 6 */ portfolioMetrics: Metrics;
  /** 7 */ perStrategyMetrics: RunMetrics["perStrategy"];
  attribution: RunMetrics["attribution"];
  /** 8 */ drawdown: { maxPct: number; avgPct: number; worstMonths: Array<[string, number]>; killed: GoldRun["killed"] };
  /** 9 */ equityCurve: Array<[number, number]>;
  /** 10 */ parameterStability: StabilityReport | null;
  /** 11 */ failed: { checks: Check[]; gates: Gate[] };
  /** 12 */ limitations: string[];
  /** 13 */ reproducibility: GoldRun["meta"];
  quality: ReturnType<typeof qualityBreakdown>;
  rejections: Record<string, number>;
  walkForward: WfResult | null;
  monteCarlo: McResult | null;
  ablation: AblationRow[] | null;
  notes: string[];
}

const downsample = <T,>(a: T[], n: number): T[] => (a.length <= n ? a : Array.from({ length: n }, (_, i) => a[Math.floor((i * (a.length - 1)) / (n - 1))]!));

export function buildReport(run: GoldRun, x: ReportExtras): Report {
  const m = runMetrics(run);
  const checks = sanityChecks(run);
  const gates = validationGates(m.portfolio, x);
  const worst = Object.entries(m.portfolio.monthly).sort((a, b) => a[1] - b[1]).slice(0, 3);
  return {
    configuration: { engine: run.cfg, strategies: run.profiles.map((p) => StrategySchema.parse(p)) },
    dataPeriod: { start: run.meta.start_date, end: run.meta.end_date, baseTimeframe: run.meta.base_timeframe },
    dataSource: x.dataSource,
    brokerAssumptions: x.brokerAssumptions ?? [`contract size ${run.cfg.contract.contract_size} oz/lot, tick ${run.cfg.contract.tick_size}, volume step ${run.cfg.contract.volume_step}`, `spread: ${run.meta.spread_model}`, `slippage: ${run.meta.slippage_model}`, `timezone: ${run.cfg.timezone}`, `leverage 1:${run.cfg.contract.leverage}`],
    tradeCount: run.trades.length,
    portfolioMetrics: m.portfolio,
    perStrategyMetrics: m.perStrategy,
    attribution: m.attribution,
    drawdown: { maxPct: m.portfolio.maxDrawdownPct, avgPct: m.portfolio.avgDrawdownPct, worstMonths: worst, killed: run.killed },
    equityCurve: downsample(run.equity, 300),
    parameterStability: x.stability ?? null,
    failed: { checks: checks.filter((c) => !c.ok), gates: gates.filter((g) => g.status !== "pass") },
    limitations: LIMITATIONS,
    reproducibility: run.meta,
    quality: qualityBreakdown(run.trades),
    rejections: run.rejectionCounts,
    walkForward: x.walkForward ?? null,
    monteCarlo: x.monteCarlo ?? null,
    ablation: x.ablation ?? null,
    notes: x.notes ?? [],
  };
}

const f = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "inf");
const BARS = "▁▂▃▄▅▆▇█";
const spark = (vals: number[]) => {
  if (!vals.length) return "";
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  return vals.map((v) => BARS[hi === lo ? 3 : Math.min(7, Math.floor(((v - lo) / (hi - lo)) * 8))]).join("");
};

export function renderReport(r: Report): string {
  const m = r.portfolioMetrics;
  const eq = r.equityCurve.map((p) => p[1]);
  const L: string[] = [];
  L.push(`# Multi-strategy gold breakout: research run ${r.reproducibility.run_id}`, "");
  L.push(`> **Maximum drawdown ${f(m.maxDrawdownPct)}%** (average ${f(m.avgDrawdownPct)}%). Net profit ${f(m.netProfit, 0)} (${f(m.netProfitPct)}%) over ${f(m.years, 2)} years, ${r.tradeCount} trades. Simulation only; research, not advice.`, "");
  L.push(`## 1-4. Configuration, data, assumptions`);
  L.push(`- Period: ${r.dataPeriod.start} to ${r.dataPeriod.end} on ${r.dataPeriod.baseTimeframe} bars. Data: ${r.dataSource}.`);
  L.push(`- Strategies: ${r.configuration.strategies.map((s) => `${s.id} (${s.entry_timeframe}/${s.exit_timeframe}, weight ${s.risk.weight})`).join(", ")}. Frequency profile: ${r.configuration.engine.frequency}.`);
  for (const b of r.brokerAssumptions) L.push(`- ${b}`);
  L.push("", `## 5-7. Results`, "", `| metric | portfolio |`, `|---|---|`);
  const rows: Array<[string, string]> = [
    ["trades", String(m.trades)],
    ["net profit", f(m.netProfit, 0)],
    ["CAGR %", f(m.cagrPct)],
    ["max drawdown %", f(m.maxDrawdownPct)],
    ["profit factor", f(m.profitFactor)],
    ["expectancy (cash / R)", `${f(m.expectancy)} / ${f(m.expectancyR, 3)}`],
    ["win rate %", f(m.winRatePct)],
    ["avg win / avg loss / payoff", `${f(m.avgWin)} / ${f(m.avgLoss)} / ${f(m.payoff)}`],
    ["Sharpe / Sortino / Calmar", `${f(m.sharpe)} / ${f(m.sortino)} / ${f(m.calmar)}`],
    ["exposure % / time in market %", `${f(m.exposurePct)} / ${f(m.timeInMarketPct)}`],
    ["long / short (trades, P&L)", `${m.long.trades}, ${f(m.long.pnl, 0)} / ${m.short.trades}, ${f(m.short.pnl, 0)}`],
    ["max winning / losing streak", `${m.maxWinningStreak} / ${m.maxLosingStreak}`],
    ["MAE R mean / p90", `${f(m.maeR.mean)} / ${f(m.maeR.p90)}`],
    ["MFE R mean / p90", `${f(m.mfeR.mean)} / ${f(m.mfeR.p90)}`],
  ];
  for (const [k, v] of rows) L.push(`| ${k} | ${v} |`);
  L.push("", `| strategy | trades | net | share of profit % | PF | expectancy R | win % | max DD % | max losing streak |`, `|---|---|---|---|---|---|---|---|---|`);
  for (const [id, s] of Object.entries(r.perStrategyMetrics)) L.push(`| ${id} | ${s.trades} | ${f(s.netProfit, 0)} | ${f(r.attribution[id]?.sharePct ?? 0, 1)} | ${f(s.profitFactor)} | ${f(s.expectancyR, 3)} | ${f(s.winRatePct, 1)} | ${f(s.maxDrawdownPct)} | ${s.maxLosingStreak} |`);
  L.push("", `## 8-9. Drawdown, losing periods and the equity curve`, "", `Equity: \`${spark(downsample(eq, 60))}\` from ${f(eq[0] ?? 0, 0)} to ${f(eq[eq.length - 1] ?? 0, 0)} (low ${f(eq.length ? Math.min(...eq) : 0, 0)}, high ${f(eq.length ? Math.max(...eq) : 0, 0)}).`);
  L.push(`Worst months: ${r.drawdown.worstMonths.map(([k, v]) => `${k} ${f(v)}%`).join(", ") || "none"}. Risk kills: ${r.drawdown.killed.length}.`);
  const yearly = Object.entries(m.annual);
  if (yearly.length) L.push("", `| year | return % |`, `|---|---|`, ...yearly.map(([y, v]) => `| ${y} | ${f(v)} |`));
  if (r.walkForward) {
    L.push("", `## Walk-forward (every window, losing ones included)`, "", `| # | train | validate | trades | net | expectancy R | max DD % | traded |`, `|---|---|---|---|---|---|---|---|`);
    for (const w of r.walkForward.windows) L.push(`| ${w.index} | ${w.train.join(" to ")} | ${w.validate.join(" to ")} | ${w.validateMetrics.trades} | ${f(w.validateMetrics.netProfit, 0)} | ${f(w.validateMetrics.expectancyR, 3)} | ${f(w.validateMetrics.maxDrawdownPct)} | ${Object.entries(w.chosen).filter(([, v]) => v).map(([k]) => k).join(" ") || "none"} |`);
    L.push("", `Out of sample: ${r.walkForward.positiveWindows}/${r.walkForward.totalWindows} windows profitable; ${r.walkForward.oos.trades} trades, net ${f(r.walkForward.oos.netProfit, 0)}, ${f(r.walkForward.oos.expectancyR, 3)} R per trade, max drawdown ${f(r.walkForward.oos.maxDrawdownPct)}%.`);
  }
  if (r.monteCarlo) {
    const c = r.monteCarlo;
    L.push("", `## Monte Carlo (${c.runs} runs)`, "", `Median CAGR ${f(c.medianCagrPct)}%, median max drawdown ${f(c.medianMaxDrawdownPct)}%, 95th percentile drawdown ${f(c.p95MaxDrawdownPct)}%. Probability of loss ${f(c.probabilityOfLossPct, 1)}%, of ruin ${f(c.probabilityOfRuinPct, 1)}%. Worst sequence: net ${f(c.worst.netProfit, 0)}, drawdown ${f(c.worst.maxDrawdownPct)}%.`);
  }
  if (r.ablation) {
    L.push("", `## Ablation`, "", `| step | trades | net | expectancy R | max DD % | Δ net | Δ expectancy R |`, `|---|---|---|---|---|---|---|`);
    for (const a of r.ablation) L.push(`| ${a.step}${a.note ? ` (${a.note})` : ""} | ${a.metrics.trades} | ${f(a.metrics.netProfit, 0)} | ${f(a.metrics.expectancyR, 3)} | ${f(a.metrics.maxDrawdownPct)} | ${f(a.delta.netProfit, 0)} | ${f(a.delta.expectancyR, 3)} |`);
  }
  if (r.parameterStability) L.push("", `## 10. Parameter stability`, "", `Best point ${JSON.stringify(r.parameterStability.best?.choice ?? {})}; best stable point ${JSON.stringify(r.parameterStability.bestStable?.choice ?? {})}. ${f(r.parameterStability.plateauSharePct, 0)}% of positive points are on a plateau, ${f(r.parameterStability.isolatedSharePct, 0)}% are isolated peaks.`);
  L.push("", `## 11. Failed or unrun tests`, "");
  if (!r.failed.checks.length && !r.failed.gates.length) L.push("None.");
  for (const c of r.failed.checks) L.push(`- SANITY FAILED: ${c.name} (${c.detail})`);
  for (const g of r.failed.gates) L.push(`- ${g.status === "fail" ? "FAILED" : "not run"}: ${g.name} (${g.detail})`);
  const rej = Object.entries(r.rejections).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (rej.length) L.push("", `Most common rejections: ${rej.map(([k, v]) => `${k} x${v}`).join("; ")}.`);
  L.push("", `## 12. Limitations`, "", ...r.limitations.map((x) => `- ${x}`));
  for (const n of r.notes) L.push(`- ${n}`);
  const rp = r.reproducibility;
  L.push("", `## 13. Reproducibility`, "", "```", `run_id: ${rp.run_id}`, `strategy_version: ${rp.strategy_version}`, `config_hash: ${rp.config_hash}`, `data_hash: ${rp.data_hash}`, `code_commit: ${rp.code_commit}`, `start_date: ${rp.start_date}`, `end_date: ${rp.end_date}`, `spread_model: ${rp.spread_model}`, `slippage_model: ${rp.slippage_model}`, `timezone: ${rp.timezone}`, `random_seed: ${rp.random_seed}`, "```");
  if (rp.warnings.length) L.push("", ...rp.warnings.map((w) => `- warning: ${w}`));
  L.push("", "Simulated performance does not guarantee future results. Trading leveraged products such as XAUUSD can result in substantial losses.", "");
  return L.join("\n");
}
