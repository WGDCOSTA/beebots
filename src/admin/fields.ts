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
  brains: { title: "Brains and models", help: "Which LLM each bunny thinks with, and the models used. Jev's model decides every tick." },
  learning: { title: "Learning", help: "What the lab and the coach may do while the engine runs." },
  evolution: {
    title: "Survival & rewards",
    help: "Bunnies know they can die at the retire line. In danger they trade smaller and their brains meet to save them; profitable bunnies earn points, levels and prizes.",
  },
  macro: {
    title: "Macro squad (stocks, gold, oil)",
    help: "Extra bunnies whose market is commodities, stocks or macro. They open only in trading hours the engine has verified from the market, and only with the master switch on.",
  },
  risk: { title: "Risk (every bunny)", help: "Hard limits the risk layer enforces whatever Jev or a brain says." },
  breakout: { title: "Breakout style (Bizzy's)", help: "Knobs for every bunny on the Breakout style." },
  trend: { title: "Trend style (Breezy's)", help: "Knobs for every bunny on the Trend style." },
  momentum: { title: "Momentum style (Boozy's)", help: "Knobs for every bunny on the Momentum style." },
  engine: { title: "Engine", help: "Cadence, alerts and housekeeping." },
};

const num = (key: string, group: FieldGroup, label: string, help: string, min: number, max: number, step = 1): AdminField => ({ key, group, label, help, type: "number", min, max, step });

const styleKnobs = (prefix: string, group: FieldGroup): AdminField[] => [
  num(`${prefix}_MAX_TRADES_PER_DAY`, group, "Max trades per day", "Opens per UTC day before the bunny is benched until midnight.", 0, 50),
  num(`${prefix}_FEE_BUDGET_USD_DAY`, group, "Fee budget (USD/day)", "Fees per UTC day before the bunny is benched.", 0, 100, 0.1),
  num(`${prefix}_SPREAD_GATE_BPS`, group, "Spread gate (bp)", "Coins with a wider bid/ask spread are not traded.", 0.5, 100, 0.5),
  num(`${prefix}_COOLDOWN_MINUTES`, group, "Cooldown (min)", "Minutes between a close and the next open.", 0, 1440),
  num(`${prefix}_STOP_ATR_MULT`, group, "Stop (x ATR)", "Hard stop distance at entry, in ATR multiples.", 0.5, 10, 0.1),
  num(`${prefix}_MAX_FLAT_MINUTES`, group, "Max flat (min)", "Force a trade after this long flat (0 = never forced). Capped by the global max flat.", 0, 1440),
];

export const ADMIN_FIELDS: AdminField[] = [
  // brains
  { key: "BEE1_BRAIN", group: "brains", label: "Bunny 1 thinks with", help: "LLM brain of the first bunny (a built-in one, or a custom brain you added).", type: "enum", options: BRAINS },
  { key: "BEE2_BRAIN", group: "brains", label: "Bunny 2 thinks with", help: "LLM brain of the second bunny.", type: "enum", options: BRAINS },
  { key: "BEE3_BRAIN", group: "brains", label: "Bunny 3 thinks with", help: "LLM brain of the third bunny.", type: "enum", options: BRAINS },
  { key: "BEE4_BRAIN", group: "brains", label: "Degen thinks with", help: "LLM brain used by the fourth main agent for research, councils and autonomous skill creation.", type: "enum", options: BRAINS },
  { key: "OPENAI_BRAIN_MODEL", group: "brains", label: "ChatGPT model", help: "Any text-capable GPT available to this OpenAI API key. Load the account's current list below; an unknown id is never saved.", type: "text", maxLen: 80, pattern: /^[A-Za-z0-9._:-]+$/ },
  { key: "OPENAI_REASONING_EFFORT", group: "brains", label: "ChatGPT reasoning effort", help: "How hard a GPT reasoning model (e.g. gpt-6-astra) thinks. auto: each task's own (routine low, studies high). xhigh and max think longest and cost the most tokens. off: never sent.", type: "enum", options: ["auto", "off", "low", "medium", "high", "xhigh", "max"] },
  { key: "CLAUDE_MODEL", group: "brains", label: "Claude model", help: "Any Claude model available to this Anthropic key or Console sign-in. Load the current list below.", type: "text", maxLen: 80, pattern: /^[A-Za-z0-9._:-]+$/ },
  { key: "CLAUDE_EFFORT", group: "brains", label: "Claude effort", help: "How hard Claude thinks (more effort costs more tokens).", type: "enum", options: ["low", "medium", "high"] },
  { key: "ZAI_MODEL", group: "brains", label: "GLM model (Z.ai)", help: "Any text-capable GLM model returned for this Z.ai key and API region.", type: "text", maxLen: 80, pattern: /^[A-Za-z0-9._:-]+$/ },
  { key: "ZAI_BASE_URL", group: "brains", label: "Z.ai API base", help: "Z.ai's OpenAI-compatible API: https://api.z.ai/api/paas/v4 (international) or https://open.bigmodel.cn/api/paas/v4 (China).", type: "text", maxLen: 120, pattern: /^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._/-]*)?$/ },
  { key: "KIMI_MODEL", group: "brains", label: "Kimi model", help: "Any text-capable Kimi/Moonshot model returned for this key and API region.", type: "text", maxLen: 80, pattern: /^[A-Za-z0-9._:-]+$/ },
  { key: "KIMI_BASE_URL", group: "brains", label: "Kimi API base", help: "Moonshot's API (api.moonshot.ai for international, api.moonshot.cn for China).", type: "text", maxLen: 120, pattern: /^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._/-]*)?$/ },
  { key: "LLM_PRICES", group: "brains", label: "Brain prices (USD per 1M tokens)", help: "For the console's cost estimates: model=input:output, comma separated, e.g. gpt-6-astra=5:20,claude-opus-5=15:75. A prefix covers a family (gpt-6=5:20). Unpriced models show tokens only.", type: "text", maxLen: 600, pattern: /^\s*([A-Za-z0-9._:/-]+\s*=\s*[0-9.]+\s*:\s*[0-9.]+\s*)(,\s*[A-Za-z0-9._:/-]+\s*=\s*[0-9.]+\s*:\s*[0-9.]+\s*)*$/ },
  { key: "JEV_MODEL", group: "brains", label: "Jev model", help: "TypeSafe AI decision model.", type: "text", maxLen: 40, pattern: /^[A-Za-z0-9._-]+$/ },
  { key: "JEV_DAILY_USD_CAP", group: "brains", label: "Jev daily cap (USD)", help: "Hard daily Jev spend. When hit, every bunny holds until 00:00 UTC.", type: "number", min: 0, max: 100, step: 0.1 },
  // learning
  { key: "ALPACA_FEED", group: "learning", label: "Alpaca data feed", help: "iex is free (one exchange: fine for daily and hourly bars). sip covers every US exchange and needs a paid Alpaca plan.", type: "enum", options: ["iex", "sip"] },
  { key: "LAB_SIGNALS", group: "learning", label: "Show Jev the lab vote", help: "Adds each bunny's playbook skill vote per coin to Jev's state, as a tiebreaker. The risk layer is unchanged.", type: "bool" },
  { key: "SPECIALIZATION", group: "learning", label: "Free specialisation", help: "The brains choose each bunny's method: any style, or any backtested lab skill (even one a bunny wrote). Switches only when flat.", type: "bool" },
  num("SPECIALIZE_MIN_HOURS", "learning", "Min hours between switches", "A bunny keeps a new method at least this long (it also switches only when flat).", 0, 720),
  { key: "CMC_IN_JEV", group: "learning", label: "CoinMarketCap line for Jev", help: "Crypto bunnies' decisions also see Fear & Greed, BTC dominance and the market cap's 24h move (needs the CoinMarketCap key).", type: "bool" },
  num("CMC_REFRESH_MIN", "learning", "CoinMarketCap refresh (min)", "Minutes between CoinMarketCap refreshes (3 calls each).", 5, 1440),
  num("CMC_TOP", "learning", "CoinMarketCap coins", "How many top coins to fetch (rank, market cap, all-exchange volume).", 10, 5000),
  num("CMC_SLOW_MIN", "learning", "CoinMarketCap slow context, minutes", "How often to fetch altcoin season, the Fear & Greed week and hot sectors (3 calls each time).", 15, 1440),
  num("CMC_MAX_CALLS_DAY", "learning", "CoinMarketCap calls per day", "Hard daily cap. The free Basic plan has 10,000 credits a month (about 330 a day).", 0, 100_000),
  { key: "BRAIN_WATCHLIST", group: "learning", label: "AI-chosen coins", help: "The brains pick each bunny's watchlist from lab evidence, its record and liquidity. Owner coins, style and survival tier still limit it.", type: "bool" },
  num("COACH_INTERVAL_MIN", "learning", "Coach every (min)", "Each brain reviews its bunny's real results and re-weights its skills. 0 = off.", 0, 10_080),
  num("SELF_RESEARCH_INTERVAL_MIN", "learning", "Self-research every (min)", "Each agent proposes and walk-forward tests a skill, then records the result in its brain graph. 0 = off.", 0, 10_080),
  num("SELF_RESEARCH_MAX_CALLS_DAY", "learning", "Self-research calls/day", "Separate hard daily cap for agent-led skill-research brain calls.", 0, 200),
  num("AUTO_LAB_INTERVAL_HOURS", "learning", "Refresh strategy lab (hours)", "Refreshes real public history and the complete skill ranking in an isolated child process. 0 = off.", 0, 8_760),
  num("AUTO_LAB_START_DELAY_MIN", "learning", "Lab startup delay (min)", "How long after engine startup the autonomous lab waits before checking whether a refresh is due.", 0, 1_440),
  num("AUTO_SCALP_LAB_INTERVAL_HOURS", "learning", "Refresh scalp lab (hours)", "When scalp is enabled, refreshes real 1-minute data and its after-cost evidence gate. 0 = off.", 0, 8_760),
  num("COACH_MAX_CALLS_DAY", "learning", "Coach calls per day", "Hard cap on coach LLM calls per UTC day.", 0, 200),
  // survival and rewards
  { key: "SURVIVAL_MODE", group: "evolution", label: "Survival mode", help: "Health tiers, smaller size in danger, survival line in Jev's state, rescue councils.", type: "bool" },
  num("SURVIVAL_DANGER_PCT", "evolution", "Danger below (%)", "Health (equity as % of start) where a bunny is in danger: size x0.6 and a rescue council.", 1, 100),
  num("SURVIVAL_CRITICAL_PCT", "evolution", "Critical below (%)", "Health where a bunny is critical: size x0.35, every brain joins its council.", 1, 100),
  num("SURVIVAL_MAX_CALLS_DAY", "evolution", "Council calls per day", "Hard cap on survival and reward council LLM calls per UTC day.", 0, 200),
  { key: "REWARDS", group: "evolution", label: "Rewards", help: "Daily points for gains, levels, and prizes: more skills, skill writing, extra brains, bigger limits.", type: "bool" },
  num("REWARD_MAX_LIMIT_BOOST", "evolution", "Max limit boost", "Largest share a reward adds to max position size (0.5 = +50%). Leverage is never raised.", 0, 1, 0.05),
  num("MAX_POSITIONS_PER_BEE", "evolution", "Max positions per bunny", "Multi-orders: level 0 starts with 3 and every level adds 3, on different coins inside one shared leverage cap. 1 = off.", 1, 18),
  { key: "REWARDS_IN_LIVE", group: "evolution", label: "Limit boosts with real money", help: "Off: in live mode rewards unlock skills and brains, never bigger limits.", type: "bool" },
  // risk
  num("MAX_LEVERAGE", "risk", "Max leverage", "Never above 2x (hard rule).", 0.1, 2, 0.1),
  num("MAX_NOTIONAL_USD_PER_BEE", "risk", "Max position (USD)", "Ceiling on any bunny's position size.", 1, 1_000_000),
  num("DAILY_LOSS_STOP_PCT", "risk", "Daily loss stop (%)", "Loss vs the day's start that benches a bunny until 00:00 UTC.", 0.5, 100, 0.5),
  num("BEE_RETIRE_AT_PCT", "risk", "Retire below (%)", "A bunny whose equity falls below this % of its start retires for good.", 0, 100),
  num("MAX_FLAT_MINUTES", "risk", "Max flat, global (min)", "Upper bound on every style's max flat.", 0, 1440),
  { key: "ALLOW_NON_CRYPTO", group: "macro", label: "Macro squad may trade", help: "Master switch. Off: macro bunnies watch and learn only. On: they open stocks/commodities in verified open sessions. Crypto bunnies stay crypto either way.", type: "bool" },
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
  { key: "SCALP_COINS", group: "learning", label: "Scalper coins", help: "* lets Degen research the liquid universe; otherwise use comma-separated tickers. Every traded coin still needs passing lab evidence.", type: "text", maxLen: 120, pattern: /^(\*|[A-Za-z0-9]+(,\s*[A-Za-z0-9]+)*)$/ },
  num("SCALP_UNIVERSE_SIZE", "learning", "Scalper research universe", "With Scalper coins = *, number of the most liquid live coins tested in each autonomous lab cycle.", 1, 50),
  num("SCALP_MAKER_FEE", "learning", "Scalper maker fee", "Your OKX maker fee per side (0.0002 = 2 bp). The cost gate and the P&L use it.", 0, 0.01, 0.0001),
  num("SCALP_MANDATE_MIN", "learning", "Mandate question every (min)", "Jev is asked for a new scalping mandate at most this often.", 1, 1440),
  num("SCALP_MANDATE_MINUTES", "learning", "Mandate lifetime (min)", "How long a mandate lasts.", 1, 1440),
  num("SCALP_MANDATE_TRADES", "learning", "Mandate trade budget", "Trades allowed inside one mandate.", 1, 500),
  num("SCALP_MAX_TRADES_PER_DAY", "learning", "Scalper trades per day", "Hard cap per bunny per UTC day.", 1, 1000),
  num("SCALP_FEE_BUDGET_USD_DAY", "learning", "Scalper fee budget (USD/day)", "Hard cap on fees per bunny per UTC day.", 0, 1000, 0.5),
  num("SCALP_SPREAD_GATE_BPS", "learning", "Scalper spread gate (bp)", "No scalp when the spread is wider than this.", 0, 50, 0.1),
  num("SCALP_MAX_LOSS_STREAK", "learning", "Circuit breaker: losses in a row", "This many losing scalps in a row pause the bunny.", 1, 50),
  num("SCALP_PAUSE_MIN", "learning", "Circuit breaker pause (min)", "How long the pause lasts.", 1, 1440),
  { key: "RATCHET", group: "risk", label: "Profit-lock ratchet", help: "Hard profit floor plus an ATR runner hug on top of each style's stops. Stops only tighten.", type: "bool" },
  { key: "RATCHET_LOCK", group: "risk", label: "Ratchet floor rungs", help: "gain%:keep pairs, e.g. 2.5:0.5,5:0.65 (at +2.5% lock half the best move, at +5% lock 65%).", type: "text", maxLen: 80, pattern: /^\d+(\.\d+)?:0?\.\d+(,\s*\d+(\.\d+)?:0?\.\d+)*$/ },
  { key: "RATCHET_HUG", group: "risk", label: "Ratchet runner hug", help: "gain%:ATR pairs, e.g. 2.5:1.2,5:0.8,8:0.6 (the trail tightens behind the peak as the trade runs).", type: "text", maxLen: 80, pattern: /^\d+(\.\d+)?:\d+(\.\d+)?(,\s*\d+(\.\d+)?:\d+(\.\d+)?)*$/ },
  { key: "RATCHET_STYLES", group: "risk", label: "Ratchet styles", help: "Comma-separated methods it applies to: bizzy, breezy, boozy, macro, skill.", type: "text", maxLen: 60, pattern: /^[a-z]+(,\s*[a-z]+)*$/ },
  num("MIN_24H_VOL_USD", "risk", "Min 24h volume (USD)", "Coins trading less are left out of the universe.", 0, 1e12),
  num("TAKER_FEE_RATE", "risk", "Taker fee rate", "Fee per side used on paper and in the lab (0.0005 = 5 bp).", 0, 0.01, 0.0001),
  num("BEE_START_EQUITY_USD", "risk", "Start equity (USD)", "Paper money per bunny. Applies to fresh books only.", 10, 1_000_000),
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
  num("TICK_MS", "engine", "Tick (ms)", "How often each bunny asks Jev. Shorter = more Jev spend.", 1000, 600_000, 500),
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
