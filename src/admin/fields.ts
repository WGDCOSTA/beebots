// Every setting the admin panel may change, with what the panel needs to draw and check it. Anything not listed here
// (the trading mode, LIVE_ACK, exchange keys, paths, ports) stays in the environment on purpose: moving real money, or
// giving a web page the power to, is never one click away.
import { BRAINS } from "../brains/llm.js";

export type FieldType = "number" | "bool" | "enum" | "text";

export interface AdminField {
  key: string;
  group: FieldGroup;
  label: string;
  help: string;
  type: FieldType;
  min?: number;
  max?: number;
  step?: number;
  options?: readonly string[];
  /** Text: max length and allowed shape. */
  maxLen?: number;
  pattern?: RegExp;
  /** A secret-ish value: never sent back to the page, only whether it is set. */
  secret?: boolean;
}

export const FIELD_GROUPS = ["brains", "learning", "evolution", "macro", "risk", "breakout", "trend", "momentum", "engine"] as const;
export type FieldGroup = (typeof FIELD_GROUPS)[number];

export const GROUP_INFO: Record<FieldGroup, { title: string; help: string }> = {
  brains: { title: "Brains and models", help: "Which LLM each bee thinks with, and the models used. Jev's model decides every tick." },
  learning: { title: "Learning", help: "What the lab and the coach may do while the engine runs." },
  evolution: {
    title: "Survival & rewards",
    help: "Bees know they can die at the retire line. In danger they trade smaller and their brains meet to save them; profitable bees earn points, levels and prizes.",
  },
  macro: {
    title: "Macro squad (stocks, gold, oil)",
    help: "Extra bees whose market is commodities, stocks or macro. They open only in trading hours the engine has verified from the market, and only with the master switch on.",
  },
  risk: { title: "Risk (every bee)", help: "Hard limits the risk layer enforces whatever Jev or a brain says." },
  breakout: { title: "Breakout style (Bizzy's)", help: "Knobs for every bee on the Breakout style." },
  trend: { title: "Trend style (Breezy's)", help: "Knobs for every bee on the Trend style." },
  momentum: { title: "Momentum style (Boozy's)", help: "Knobs for every bee on the Momentum style." },
  engine: { title: "Engine", help: "Cadence, alerts and housekeeping." },
};

const num = (key: string, group: FieldGroup, label: string, help: string, min: number, max: number, step = 1): AdminField => ({ key, group, label, help, type: "number", min, max, step });

const styleKnobs = (prefix: string, group: FieldGroup): AdminField[] => [
  num(`${prefix}_MAX_TRADES_PER_DAY`, group, "Max trades per day", "Opens per UTC day before the bee is benched until midnight.", 0, 50),
  num(`${prefix}_FEE_BUDGET_USD_DAY`, group, "Fee budget (USD/day)", "Fees per UTC day before the bee is benched.", 0, 100, 0.1),
  num(`${prefix}_SPREAD_GATE_BPS`, group, "Spread gate (bp)", "Coins with a wider bid/ask spread are not traded.", 0.5, 100, 0.5),
  num(`${prefix}_COOLDOWN_MINUTES`, group, "Cooldown (min)", "Minutes between a close and the next open.", 0, 1440),
  num(`${prefix}_STOP_ATR_MULT`, group, "Stop (x ATR)", "Hard stop distance at entry, in ATR multiples.", 0.5, 10, 0.1),
  num(`${prefix}_MAX_FLAT_MINUTES`, group, "Max flat (min)", "Force a trade after this long flat (0 = never forced). Capped by the global max flat.", 0, 1440),
];

export const ADMIN_FIELDS: AdminField[] = [
  // brains
  { key: "BEE1_BRAIN", group: "brains", label: "Bee 1 thinks with", help: "LLM brain of the first bee.", type: "enum", options: BRAINS },
  { key: "BEE2_BRAIN", group: "brains", label: "Bee 2 thinks with", help: "LLM brain of the second bee.", type: "enum", options: BRAINS },
  { key: "BEE3_BRAIN", group: "brains", label: "Bee 3 thinks with", help: "LLM brain of the third bee.", type: "enum", options: BRAINS },
  { key: "OPENAI_BRAIN_MODEL", group: "brains", label: "ChatGPT model", help: "OpenAI model for the ChatGPT brain.", type: "text", maxLen: 60, pattern: /^[A-Za-z0-9._:-]+$/ },
  { key: "CLAUDE_MODEL", group: "brains", label: "Claude model", help: "Anthropic model id for the Claude brain.", type: "text", maxLen: 60, pattern: /^[A-Za-z0-9._:-]+$/ },
  { key: "CLAUDE_EFFORT", group: "brains", label: "Claude effort", help: "How hard Claude thinks (more effort costs more tokens).", type: "enum", options: ["low", "medium", "high"] },
  { key: "KIMI_MODEL", group: "brains", label: "Kimi model", help: "Moonshot model id for the Kimi brain.", type: "text", maxLen: 60, pattern: /^[A-Za-z0-9._:-]+$/ },
  { key: "KIMI_BASE_URL", group: "brains", label: "Kimi API base", help: "Moonshot's API (api.moonshot.ai for international, api.moonshot.cn for China).", type: "text", maxLen: 120, pattern: /^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._/-]*)?$/ },
  { key: "JEV_MODEL", group: "brains", label: "Jev model", help: "TypeSafe AI decision model.", type: "text", maxLen: 40, pattern: /^[A-Za-z0-9._-]+$/ },
  { key: "JEV_DAILY_USD_CAP", group: "brains", label: "Jev daily cap (USD)", help: "Hard daily Jev spend. When hit, every bee holds until 00:00 UTC.", type: "number", min: 0, max: 100, step: 0.1 },
  // learning
  { key: "LAB_SIGNALS", group: "learning", label: "Show Jev the lab vote", help: "Adds each bee's playbook skill vote per coin to Jev's state, as a tiebreaker. The risk layer is unchanged.", type: "bool" },
  { key: "SPECIALIZATION", group: "learning", label: "Free specialisation", help: "The brains choose each bee's method: any style, or any backtested lab skill (even one a bee wrote). Switches only when flat.", type: "bool" },
  num("SPECIALIZE_MIN_HOURS", "learning", "Min hours between switches", "A bee keeps a new method at least this long (it also switches only when flat).", 0, 720),
  { key: "CMC_IN_JEV", group: "learning", label: "CoinMarketCap line for Jev", help: "Crypto bees' decisions also see Fear & Greed, BTC dominance and the market cap's 24h move (needs the CoinMarketCap key).", type: "bool" },
  num("CMC_REFRESH_MIN", "learning", "CoinMarketCap refresh (min)", "Minutes between CoinMarketCap refreshes (3 calls each).", 5, 1440),
  num("CMC_TOP", "learning", "CoinMarketCap coins", "How many top coins to fetch (rank, market cap, all-exchange volume).", 10, 5000),
  num("CMC_MAX_CALLS_DAY", "learning", "CoinMarketCap calls per day", "Hard daily cap. The free Basic plan has 10,000 credits a month (about 330 a day).", 0, 100_000),
  { key: "BRAIN_WATCHLIST", group: "learning", label: "AI-chosen coins", help: "The brains pick each bee's watchlist from lab evidence, its record and liquidity. Owner coins, style and survival tier still limit it.", type: "bool" },
  num("COACH_INTERVAL_MIN", "learning", "Coach every (min)", "Each brain reviews its bee's real results and re-weights its skills. 0 = off.", 0, 10_080),
  num("COACH_MAX_CALLS_DAY", "learning", "Coach calls per day", "Hard cap on coach LLM calls per UTC day.", 0, 200),
  // survival and rewards
  { key: "SURVIVAL_MODE", group: "evolution", label: "Survival mode", help: "Health tiers, smaller size in danger, survival line in Jev's state, rescue councils.", type: "bool" },
  num("SURVIVAL_DANGER_PCT", "evolution", "Danger below (%)", "Health (equity as % of start) where a bee is in danger: size x0.6 and a rescue council.", 1, 100),
  num("SURVIVAL_CRITICAL_PCT", "evolution", "Critical below (%)", "Health where a bee is critical: size x0.35, every brain joins its council.", 1, 100),
  num("SURVIVAL_MAX_CALLS_DAY", "evolution", "Council calls per day", "Hard cap on survival and reward council LLM calls per UTC day.", 0, 200),
  { key: "REWARDS", group: "evolution", label: "Rewards", help: "Daily points for gains, levels, and prizes: more skills, skill writing, extra brains, bigger limits.", type: "bool" },
  num("REWARD_MAX_LIMIT_BOOST", "evolution", "Max limit boost", "Largest share a reward adds to max position size (0.5 = +50%). Leverage is never raised.", 0, 1, 0.05),
  num("MAX_POSITIONS_PER_BEE", "evolution", "Max positions per bee", "Multi-orders: level 3 earns 2 positions, level 5 earns 3, on different coins inside one leverage cap. 1 = off.", 1, 5),
  { key: "REWARDS_IN_LIVE", group: "evolution", label: "Limit boosts with real money", help: "Off: in live mode rewards unlock skills and brains, never bigger limits.", type: "bool" },
  // risk
  num("MAX_LEVERAGE", "risk", "Max leverage", "Never above 2x (hard rule).", 0.1, 2, 0.1),
  num("MAX_NOTIONAL_USD_PER_BEE", "risk", "Max position (USD)", "Ceiling on any bee's position size.", 1, 1_000_000),
  num("DAILY_LOSS_STOP_PCT", "risk", "Daily loss stop (%)", "Loss vs the day's start that benches a bee until 00:00 UTC.", 0.5, 100, 0.5),
  num("BEE_RETIRE_AT_PCT", "risk", "Retire below (%)", "A bee whose equity falls below this % of its start retires for good.", 0, 100),
  num("MAX_FLAT_MINUTES", "risk", "Max flat, global (min)", "Upper bound on every style's max flat.", 0, 1440),
  { key: "ALLOW_NON_CRYPTO", group: "macro", label: "Macro squad may trade", help: "Master switch. Off: macro bees watch and learn only. On: they open stocks/commodities in verified open sessions. Crypto bees stay crypto either way.", type: "bool" },
  num("MACRO_MIN_24H_VOL_USD", "macro", "Min 24h volume (USD)", "Stocks and commodities trading less are left out of the macro universe.", 0, 1e12),
  // The macro style's knobs (it is never forced in, so no max-flat).
  ...styleKnobs("MACRO", "macro").filter((f) => f.key !== "MACRO_MAX_FLAT_MINUTES"),
  num("MACRO_MAX_LEVERAGE", "macro", "Max leverage (x equity)", "Macro positions stay at or under this, below MAX_LEVERAGE: gold and stocks gap.", 0.1, 2, 0.1),
  num("MACRO_LATE_SESSION_SIZE", "macro", "Late-session size", "Size factor for an open with under 2 h to the close.", 0, 1, 0.05),
  num("SESSION_NO_OPEN_MIN", "macro", "No opens before close (min)", "No new macro position this close to the end of a verified session.", 0, 600),
  { key: "SESSION_FLATTEN", group: "macro", label: "Flatten before the close", help: "all: close every macro position before its session ends. weekend: only before a closure of a day or more. off: hold through.", type: "enum", options: ["all", "weekend", "off"] },
  num("SESSION_FLATTEN_MIN", "macro", "Flatten this early (min)", "Minutes before the session ends when the flatten fires.", 1, 120),
  { key: "SCALP", group: "learning", label: "Scalper", help: "Lets the brains pick the scalp method (maker orders on 1-minute rules). Even then it trades only while the strategy lab's latest report on real data shows an edge after costs.", type: "bool" },
  { key: "SCALP_REQUIRE_LAB", group: "learning", label: "Scalper needs lab evidence", help: "Off only makes sense in paper trading: with real money the gate is always on.", type: "bool" },
  { key: "SCALP_COINS", group: "learning", label: "Scalper coins", help: "Comma-separated tickers the scalper may trade (it also needs the lab to have passed each one).", type: "text", maxLen: 60, pattern: /^[A-Za-z0-9]+(,\s*[A-Za-z0-9]+)*$/ },
  num("SCALP_MAKER_FEE", "learning", "Scalper maker fee", "Your OKX maker fee per side (0.0002 = 2 bp). The cost gate and the P&L use it.", 0, 0.01, 0.0001),
  num("SCALP_MANDATE_MIN", "learning", "Mandate question every (min)", "Jev is asked for a new scalping mandate at most this often.", 1, 1440),
  num("SCALP_MANDATE_MINUTES", "learning", "Mandate lifetime (min)", "How long a mandate lasts.", 1, 1440),
  num("SCALP_MANDATE_TRADES", "learning", "Mandate trade budget", "Trades allowed inside one mandate.", 1, 500),
  num("SCALP_MAX_TRADES_PER_DAY", "learning", "Scalper trades per day", "Hard cap per bee per UTC day.", 1, 1000),
  num("SCALP_FEE_BUDGET_USD_DAY", "learning", "Scalper fee budget (USD/day)", "Hard cap on fees per bee per UTC day.", 0, 1000, 0.5),
  num("SCALP_SPREAD_GATE_BPS", "learning", "Scalper spread gate (bp)", "No scalp when the spread is wider than this.", 0, 50, 0.1),
  num("SCALP_MAX_LOSS_STREAK", "learning", "Circuit breaker: losses in a row", "This many losing scalps in a row pause the bee.", 1, 50),
  num("SCALP_PAUSE_MIN", "learning", "Circuit breaker pause (min)", "How long the pause lasts.", 1, 1440),
  { key: "RATCHET", group: "risk", label: "Profit-lock ratchet", help: "Hard profit floor plus an ATR runner hug on top of each style's stops. Stops only tighten.", type: "bool" },
  { key: "RATCHET_LOCK", group: "risk", label: "Ratchet floor rungs", help: "gain%:keep pairs, e.g. 2.5:0.5,5:0.65 (at +2.5% lock half the best move, at +5% lock 65%).", type: "text", maxLen: 80, pattern: /^\d+(\.\d+)?:0?\.\d+(,\s*\d+(\.\d+)?:0?\.\d+)*$/ },
  { key: "RATCHET_HUG", group: "risk", label: "Ratchet runner hug", help: "gain%:ATR pairs, e.g. 2.5:1.2,5:0.8,8:0.6 (the trail tightens behind the peak as the trade runs).", type: "text", maxLen: 80, pattern: /^\d+(\.\d+)?:\d+(\.\d+)?(,\s*\d+(\.\d+)?:\d+(\.\d+)?)*$/ },
  { key: "RATCHET_STYLES", group: "risk", label: "Ratchet styles", help: "Comma-separated methods it applies to: bizzy, breezy, boozy, macro, skill.", type: "text", maxLen: 60, pattern: /^[a-z]+(,\s*[a-z]+)*$/ },
  num("MIN_24H_VOL_USD", "risk", "Min 24h volume (USD)", "Coins trading less are left out of the universe.", 0, 1e12),
  num("TAKER_FEE_RATE", "risk", "Taker fee rate", "Fee per side used on paper and in the lab (0.0005 = 5 bp).", 0, 0.01, 0.0001),
  num("BEE_START_EQUITY_USD", "risk", "Start equity (USD)", "Paper money per bee. Applies to fresh books only.", 10, 1_000_000),
  // styles
  ...styleKnobs("BIZZY", "breakout"),
  num("BIZZY_SIZE_FRACTION", "breakout", "Size fraction", "Share of max notional per breakout.", 0.01, 1, 0.01),
  num("BIZZY_TIME_STOP_MINUTES", "breakout", "Time stop (min)", "Close any breakout older than this.", 5, 2880),
  ...styleKnobs("BREEZY", "trend"),
  num("BREEZY_MIN_OPEN_PROB", "trend", "Min open probability", "Jev probability needed for a discretionary open.", 0, 1, 0.01),
  num("BREEZY_MIN_SIZE_USD", "trend", "Min size (USD)", "Smallest trend position worth opening.", 0, 10_000),
  ...styleKnobs("BOOZY", "momentum"),
  num("BOOZY_CANDIDATES", "momentum", "Candidates", "Top movers shown to Jev.", 1, 20),
  // engine
  num("TICK_MS", "engine", "Tick (ms)", "How often each bee asks Jev. Shorter = more Jev spend.", 1000, 600_000, 500),
  num("DATA_REFRESH_MS", "engine", "Market refresh (ms)", "Candles, indicators, funding, open interest.", 15_000, 3_600_000, 1000),
  { key: "UPDATE_CHECK", group: "engine", label: "Check for updates", help: "Show \"Update available\" when a new release is out. Never installs anything.", type: "bool" },
  { key: "LOG_LEVEL", group: "engine", label: "Log level", help: "Engine log verbosity.", type: "enum", options: ["debug", "info", "warn", "error"] },
  { key: "ALERT_WEBHOOK_URL", group: "engine", label: "Alert webhook", help: "Discord/Slack-style webhook for alerts (caps, Jev down). Write-only.", type: "text", maxLen: 400, pattern: /^https:\/\/\S+$/, secret: true },
];

export const FIELD_BY_KEY = new Map(ADMIN_FIELDS.map((f) => [f.key, f]));

/** Check one value from the page. Returns the text to store, or an error message. */
export function checkField(f: AdminField, raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (f.type === "bool") {
    if (typeof raw !== "boolean") return { ok: false, error: `${f.label}: on or off` };
    return { ok: true, value: raw ? "true" : "false" };
  }
  if (f.type === "number") {
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n)) return { ok: false, error: `${f.label}: a number` };
    if ((f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) return { ok: false, error: `${f.label}: between ${f.min} and ${f.max}` };
    return { ok: true, value: String(n) };
  }
  const s = String(raw ?? "").trim();
  if (f.type === "enum") return f.options!.includes(s) ? { ok: true, value: s } : { ok: false, error: `${f.label}: one of ${f.options!.join(", ")}` };
  if (!s || s.length > (f.maxLen ?? 200) || (f.pattern && !f.pattern.test(s))) return { ok: false, error: `${f.label}: not a valid value` };
  return { ok: true, value: s };
}
