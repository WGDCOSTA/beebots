// Multi-strategy gold breakout engine: configuration schema (zod) and the records the simulator produces.
// An independent research model of structural support/resistance breakouts on XAUUSD; see
// skills/multi-strategy-gold-breakout/SKILL.md. Nothing here reproduces any commercial EA, and nothing here trades:
// live execution is not part of this module.
import { z } from "zod";
import { TFS, type Tf } from "../resample.js";

export const TfSchema = z.enum(TFS as [Tf, ...Tf[]]);
export const NormalizationMode = z.enum(["NONE", "PRICE_RATIO", "ATR", "HYBRID"]);
export type NormalizationMode = z.infer<typeof NormalizationMode>;
export const LevelSelection = z.enum(["recent", "prominent", "touches", "nearest"]);
export const FakeMode = z.enum(["LOW", "MEDIUM", "HIGH"]);
export type FakeMode = z.infer<typeof FakeMode>;
export const EntryMode = z.enum(["pending_stop", "candle_close_breakout"]);
export const FREQUENCIES = ["VERY_CONSERVATIVE", "CONSERVATIVE", "MODERATE", "INTENSE", "EXTREME"] as const;
export type Frequency = (typeof FREQUENCIES)[number];
export const STRATEGY_IDS = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9"] as const;
export type StrategyId = (typeof STRATEGY_IDS)[number];
export const BASE_MAGIC = 620000;
export const magicOf = (id: string) => BASE_MAGIC + Number(id.slice(1));

const pos = z.number().positive();
const nonneg = z.number().min(0);

export const NormalizationSchema = z.object({
  mode: NormalizationMode.default("HYBRID"),
  /** Gold price at which every base distance in the profile was written. */
  reference_gold_price: pos.default(2500),
  /** ATR (price units) on the strategy's entry timeframe at the reference. Absent = the median over the data's warm-up window. */
  reference_atr: pos.optional(),
  atr_period: z.number().int().min(2).default(14),
  price_weight: nonneg.default(0.5),
  atr_weight: nonneg.default(0.5),
  /** The scale factor is clamped to this band: a volatility spike must not blow every distance up (or down) tenfold. */
  scale_min: pos.default(0.25),
  scale_max: pos.default(4),
});
export type NormalizationConfig = z.infer<typeof NormalizationSchema>;

export const StrategySchema = z.object({
  id: z.enum(STRATEGY_IDS),
  enabled: z.boolean().default(true),
  entry_timeframe: TfSchema,
  exit_timeframe: TfSchema,
  structure: z.object({
    left_bars: z.number().int().min(1),
    right_bars: z.number().int().min(1),
    max_lookback_bars: z.number().int().min(5),
    level_selection: LevelSelection.default("recent"),
  }),
  entry: z.object({
    mode: EntryMode.default("pending_stop"),
    /** Price must be at least this far from the level before a breakout is armed (USD at the reference price). */
    min_arm_distance: nonneg,
    breakout_offset: nonneg,
    pending_expiry_bars: z.number().int().min(1).optional(),
    pending_expiry_minutes: z.number().int().min(1).optional(),
    /** One-cancels-other: when the buy stop or the sell stop fills, the other one is cancelled. */
    oco: z.boolean().default(true),
  }),
  stop_loss: z.object({ base_distance: pos }),
  take_profit: z.object({ base_distance: pos }),
  break_even: z.object({ enabled: z.boolean().default(false), trigger_distance: nonneg.default(0), lock_distance: nonneg.default(0) }).default({}),
  trailing: z.object({ enabled: z.boolean().default(false), trigger_distance: nonneg.default(0), distance: nonneg.default(0) }).default({}),
  structure_trailing: z.object({ enabled: z.boolean().default(false), timeframe: TfSchema.optional(), offset: nonneg.default(0) }).default({}),
  /** Optional: once the take profit is within `trigger_distance`, push it out by `extend_distance`, at most `max_extensions` times. */
  trailing_tp: z.object({ enabled: z.boolean().default(false), trigger_distance: nonneg.default(0), extend_distance: nonneg.default(0), max_extensions: z.number().int().min(0).default(3) }).default({}),
  fake_breakout: z
    .object({
      enabled: z.boolean().default(true),
      mode: FakeMode.default("MEDIUM"),
      reference: z.enum(["structural_level", "entry"]).default("structural_level"),
      /** In points (pointSize of the contract). */
      tolerance_points: nonneg.default(0),
      close_on_failure: z.boolean().default(true),
      /** Explicit confirmation checkpoints; absent = derived from `mode` and the timeframes. */
      checks: z.array(z.object({ timeframe: TfSchema, bars: z.number().int().min(1).default(1) })).optional(),
    })
    .default({}),
  normalization: NormalizationSchema.partial().optional(),
  risk: z.object({ weight: nonneg.default(1), max_trade_risk_pct: pos.default(0.25) }).default({}),
  session_filter: z.object({ london: z.boolean().optional(), new_york: z.boolean().optional(), asia: z.boolean().optional() }).optional(),
});
export type StrategyProfile = z.infer<typeof StrategySchema>;

export const ContractSchema = z.object({
  /** Ounces per lot (MT5 XAUUSD is usually 100). */
  contract_size: pos.default(100),
  point_size: pos.default(0.01),
  tick_size: pos.default(0.01),
  /** USD per tick per 1 lot (= contract_size x tick_size for a USD-quoted symbol). */
  tick_value: pos.default(1),
  volume_min: pos.default(0.01),
  volume_step: pos.default(0.01),
  volume_max: pos.default(100),
  /** Minimum distance of a pending price or a stop from the market, in points. */
  stop_level_points: nonneg.default(0),
  /** Within this many points of the market a stop cannot be modified. */
  freeze_level_points: nonneg.default(0),
  leverage: pos.default(100),
});
export type ContractSpec = z.infer<typeof ContractSchema>;

export const SpreadModel = z.object({
  /** "data": the bar's own spread (MT5 export) with `value` as the fallback; "fixed": always `value`. */
  kind: z.enum(["fixed", "data"]).default("fixed"),
  value: nonneg.default(0.3),
});

export const NewsEvent = z.object({ time: z.number(), name: z.string().default("event"), impact: z.enum(["low", "medium", "high"]).default("high") });
export type NewsEvent = z.infer<typeof NewsEvent>;
export const NEWS_POLICIES = ["BLOCK_NEW_ENTRIES", "CANCEL_PENDING", "REDUCE_RISK", "CLOSE_POSITIONS"] as const;

const Hhmm = z.string().regex(/^\d{1,2}:\d{2}$/);
export const SessionWindow = z.object({ tz: z.string(), start: Hhmm, end: Hhmm });

export const EngineSchema = z.object({
  symbol: z.string().default("XAUUSD"),
  mode: z.enum(["backtest", "paper"]).default("backtest"),
  /** This module has no execution adapter: true is refused. */
  live_trading: z.boolean().default(false),
  frequency: z.enum(FREQUENCIES).default("MODERATE"),
  base_timeframe: TfSchema.default("M5"),
  /** Broker server timezone (IANA): day and week rollovers, weekend and session rules use it. */
  timezone: z.string().default("Etc/UTC"),
  account: z.object({ initial_balance: pos.default(10_000) }).default({}),
  contract: ContractSchema.default({}),
  costs: z
    .object({
      spread: SpreadModel.default({}),
      /** Adverse price slippage on stop and market fills, USD. */
      slippage: nonneg.default(0.05),
      /** USD per lot, round turn (charged half on entry, half on exit). */
      commission_per_lot: nonneg.default(0),
      swap_long_per_lot_day: z.number().default(0),
      swap_short_per_lot_day: z.number().default(0),
    })
    .default({}),
  normalization: NormalizationSchema.default({}),
  risk: z
    .object({
      max_open_risk_pct: pos.default(1.0),
      max_daily_loss_pct: pos.default(2.0),
      max_weekly_loss_pct: pos.default(4.0),
      max_concurrent_positions: z.number().int().min(1).default(5),
      /** Same-direction positions on one symbol are perfectly correlated: this caps them. */
      max_correlated_positions: z.number().int().min(1).default(3),
      /** Pending orders reserve the risk they would add if they fill (a strategy's buy and sell stop share one reservation). */
      reserve_pending_risk: z.boolean().default(true),
    })
    .default({}),
  filters: z
    .object({
      spread: z.object({ enabled: z.boolean().default(true), max_allowed: pos.default(0.6), max_atr_ratio: pos.optional() }).default({}),
      sessions: z
        .object({
          enabled: z.boolean().default(false),
          london: z.boolean().default(true),
          new_york: z.boolean().default(true),
          asia: z.boolean().default(false),
          windows: z
            .record(SessionWindow)
            .default({ london: { tz: "Europe/London", start: "08:00", end: "17:00" }, new_york: { tz: "America/New_York", start: "08:00", end: "17:00" }, asia: { tz: "Asia/Tokyo", start: "09:00", end: "18:00" } }),
        })
        .default({}),
      news: z
        .object({
          enabled: z.boolean().default(false),
          block_minutes_before: nonneg.default(90),
          block_minutes_after: nonneg.default(60),
          policies: z.array(z.enum(NEWS_POLICIES)).default(["BLOCK_NEW_ENTRIES", "CANCEL_PENDING"]),
          /** Risk multiplier while inside a blackout when REDUCE_RISK is on. */
          reduce_risk_factor: z.number().min(0).max(1).default(0.5),
          events: z.array(NewsEvent).default([]),
        })
        .default({}),
      weekend: z
        .object({
          enabled: z.boolean().default(true),
          /** Day of week (0 Sunday .. 6 Saturday) and time in the broker timezone. */
          block_new_entries_after: z.object({ day: z.number().int().min(0).max(6).default(5), time: Hhmm.default("18:00") }).default({}),
          market_close: z.object({ day: z.number().int().min(0).max(6).default(5), time: Hhmm.default("22:00") }).default({}),
          cancel_pending_before_close: z.boolean().default(true),
          force_flat_before_close: z.boolean().default(false),
          /** Minutes before `market_close` at which pendings are cancelled and, if asked, positions closed. */
          minutes_before_close: nonneg.default(15),
        })
        .default({}),
    })
    .default({}),
  duplicate_levels: z
    .object({
      cluster_tolerance: nonneg.default(2.0),
      action: z.enum(["ALLOW", "MERGE", "KEEP_HIGHEST_PRIORITY", "REDUCE_POSITION_SIZE"]).default("KEEP_HIGHEST_PRIORITY"),
      reduce_factor: z.number().min(0).max(1).default(0.5),
    })
    .default({}),
  drawdown_weighting: z
    .object({
      enabled: z.boolean().default(false),
      /** final = alpha x static + (1 - alpha) x drawdown-based. */
      alpha: z.number().min(0).max(1).default(0.5),
      epsilon: pos.default(0.05),
      /** A strategy needs this many closed trades before its drawdown counts. */
      min_trades: z.number().int().min(1).default(20),
    })
    .default({}),
  fake_breakout_default_mode: FakeMode.optional(),
  seed: z.number().int().default(1),
});
export type EngineConfig = z.infer<typeof EngineSchema>;

export class LiveTradingDisabled extends Error {}

/** The module never executes: refuse any config that asks for live trading. */
export function assertResearchOnly(cfg: Pick<EngineConfig, "live_trading" | "mode">): void {
  if (cfg.live_trading) throw new LiveTradingDisabled("live_trading is disabled: this module simulates only. A host system must supply and enable its own execution.");
}

// ---------- what a run produces ----------

export type ExitReason = "TP" | "SL" | "BE" | "TRAIL" | "STRUCTURE_TRAIL" | "FAKE_BREAKOUT" | "NEWS_EXIT" | "SESSION_EXIT" | "MANUAL" | "RISK_KILL" | "END";
export type SetupState =
  | "IDLE"
  | "STRUCTURE_FOUND"
  | "WAITING_FOR_DISTANCE"
  | "ARMED"
  | "PENDING"
  | "TRIGGERED"
  | "CONFIRMING"
  | "MANAGING"
  | "CLOSED"
  | "EXPIRED"
  | "CANCELLED_NEWS"
  | "CANCELLED_OCO"
  | "CANCELLED_RISK"
  | "INVALIDATED"
  | "FAKE_BREAKOUT_EXIT";

export interface GoldTrade {
  id: number;
  strategy: StrategyId;
  magic: number;
  side: "BUY" | "SELL";
  signalTs: number;
  entryTs: number;
  exitTs: number;
  level: number;
  entryPx: number;
  exitPx: number;
  sl0: number;
  tp0: number;
  lots: number;
  /** Cash P&L after spread (through bid/ask), slippage, commission and swap. */
  pnl: number;
  pnlPrice: number;
  commission: number;
  swap: number;
  /** P&L in multiples of the initial risk. */
  r: number;
  riskAtEntry: number;
  riskPct: number;
  exitReason: ExitReason;
  bars: number;
  minutes: number;
  // ---- breakout quality (section 45) ----
  quality: {
    armDistance: number;
    levelAgeBars: number;
    touches: number;
    minutesSinceLastTouch: number | null;
    atrAtEntry: number;
    spreadAtEntry: number;
    breakoutBarRange: number;
    mfe: number;
    mae: number;
    mfeR: number;
    maeR: number;
    minutesToMfe: number;
    minutesToMae: number;
    fakeBreakout: "off" | "passed" | "failed";
    normalizationFactor: number;
    entryTimeframe: Tf;
  };
}

export interface SignalLog {
  strategy: StrategyId;
  time: string;
  side: "BUY" | "SELL";
  state: SetupState;
  level: number;
  entry: number;
  stop: number;
  target: number;
  level_age_bars: number;
  arm_distance: number;
  spread: number;
  normalization_factor: number;
  risk_pct: number;
  lots: number;
  note?: string;
}

export interface Rejection {
  ts: number;
  strategy: StrategyId;
  side: "BUY" | "SELL";
  reason: string;
}

export interface RunMeta {
  run_id: string;
  strategy_version: string;
  config_hash: string;
  data_hash: string;
  code_commit: string;
  start_date: string;
  end_date: string;
  spread_model: string;
  slippage_model: string;
  timezone: string;
  random_seed: number;
  base_timeframe: Tf;
  warnings: string[];
}

export interface GoldRun {
  cfg: EngineConfig;
  profiles: StrategyProfile[];
  trades: GoldTrade[];
  /** Balance + floating P&L at each daily rollover and at the end: [ts, equity]. */
  equity: Array<[number, number]>;
  /** Per closed trade: [exit ts, balance]. */
  balance: Array<[number, number]>;
  logs: SignalLog[];
  rejections: Rejection[];
  rejectionCounts: Record<string, number>;
  transitions: Record<string, number>;
  /** Peak of (reserved + open) risk as % of equity, to check the ceiling. */
  peakOpenRiskPct: number;
  killed: Array<{ ts: number; kind: "daily" | "weekly"; equity: number }>;
  meta: RunMeta;
}
