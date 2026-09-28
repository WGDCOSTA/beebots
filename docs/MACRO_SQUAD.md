# The macro squad: bees on gold, oil and stocks

OKX lists X-Perps on commodities (XAU gold, XAG silver, CL WTI oil, BZ Brent) and on about 60 stocks and ETFs (NVDA,
TSLA, MSTR, SPY, QQQ, SOXL, …). The **macro squad** is a group of extra bees that trade those instead of crypto. The
three main bees (and every bee by default) stay crypto-only.

## Forming it

**Admin → Bees → Form the macro squad** adds three bees (then Save and restart):

| Bee | Market | Coins | Idea |
|---|---|---|---|
| Goldie | commodities | XAU, XAG | trend, patience, no chasing spikes around US data |
| Crude | commodities | CL, BZ | breakouts, cut fast when a move fails |
| Stonks | stocks | its brains choose (watchlist) | liquid stocks/ETFs during the session, never hold a weak position into the close |

Any extra bee can also be given a market by hand: crypto, commodities, stocks or macro (both). Its asset picker then
shows only live X-Perps of that market, and the admin API refuses coins of another market. Macro bees race in their
own **Macro squad** card on the live board; the lab, the councils, the coach, survival and rewards treat them like any
other bee (their brains know they are in the macro squad and pick coins only from their market).

## Trading hours, learned from the market

OKX does not say when a stock or commodity X-Perp really trades, and a position held into a closed market can gap
through its stop. So the engine **learns the calendar** (`src/market/sessions.ts`):

- Every minute it samples every live stock and commodity ticker, always, even before a macro bee exists.
- For each hour of the week (UTC) it counts how often the contract was really quoting: the ticker time moved and the
  price or the volume changed. It also records the spread.
- An hour is **open** when it was active in ≥ 70% of at least 20 samples, **closed** when seen enough but idle, and
  **unverified** otherwise. It takes about a week to verify every hour.
- The calendar lives in `<LAB_DIR>/sessions.json`. See it in **Admin → Bees → Trading hours** (click a coin for its
  week grid) or with `pnpm sessions`. `pnpm sessions record --minutes 60` records without the engine.

## When a macro bee may open

All of these must hold:

1. `ALLOW_NON_CRYPTO=true` (Admin → Settings → Macro squad). It is off by default: macro bees then watch and learn
   (the calendar, the lab, their councils) but never open.
2. The coin is a live X-Perp of the bee's market and passes the macro gates: `MACRO_MIN_24H_VOL_USD` (200k) and
   `MACRO_SPREAD_GATE_BPS` (15 bp). Stocks and gold trade far less than crypto on OKX, hence their own gates.
3. The current hour is **verified open**, and the session stays open at least `SESSION_NO_OPEN_MIN` (30) more
   minutes. Unverified counts as closed.

Jev sees `session: { XAU: "open 190m", NVDA: "closed" }` for a macro bee, with one line telling it that these markets
gap when shut and that it should prefer taking profit or tightening risk near a close. Everything else is unchanged:
Jev decides, the risk layer has the last word.

## The macro style

Every macro bee runs the **macro style** (`src/bees/macro.ts`), whatever crypto style its settings name. Two setups,
read from each coin's 15-minute indicators and 1-hour returns:

| Setup | Long | Short |
|---|---|---|
| **TREND** (buy the dip, sell the rally) | 7d and 24h up, MACD histogram up, RSI 35–60, %B ≤ 0.6 | 7d and 24h down, MACD down, RSI 40–65, %B ≥ 0.4 |
| **REVERT** (no weekly trend: \|7d\| < 2.5%) | below the lower band (%B < 0), RSI < 32 | above the upper band (%B > 1), RSI > 68 |

- Jev sees only coins with a setup (`TREND_LONG_XAU`, `REVERT_SHORT_NVDA`, …) plus `WAIT`. Flat with no setup, the bee
  waits: it is **never forced in**.
- Positioned: `HOLD`, `TAKE_PROFIT` (above +0.5R), `TRIM_HALF` (above +1.5R), and `CUT` when the day and the momentum
  have turned against it.
- Size: 50–100% by conviction, at most **`MACRO_MAX_LEVERAGE` (1x) equity**, never above `MAX_LEVERAGE`. An open with
  under 2 h to the close is sized by `MACRO_LATE_SESSION_SIZE` (×0.5).
- Stop: `MACRO_STOP_ATR_MULT` (2.5) × the 15m ATR. A profit lock keeps 40% of the best move from +0.8%, 60% from
  +1.5%, 75% from +3%.
- Knobs: `MACRO_MAX_TRADES_PER_DAY` (4), `MACRO_FEE_BUDGET_USD_DAY` (2), `MACRO_SPREAD_GATE_BPS` (15),
  `MACRO_COOLDOWN_MINUTES` (30). Survival, rewards and watchlists apply as for any bee.

## Flatten before the close

The risk layer closes a macro position **`SESSION_FLATTEN_MIN` (10) minutes before its session ends**, whatever Jev
says, so no gap can reach it. `SESSION_FLATTEN`:

- `all` (default): before every close;
- `weekend`: only before a closure of a day or more (overnight breaks are held through);
- `off`: hold through closes (the stop still applies once the market reopens).

The flatten fires only in a verified open session; the decision shows `forced by: session_close`.

## Not done yet (next phases)

- A **lab pack** of session-aware skills (opening-range breakout, gap fade, RSI(2) on SPY) and long history from
  CSV/CCXT imports.
- A macro news calendar (CPI, FOMC, payrolls) blackout.
- Outside paper trading each macro bee needs its own OKX keys (`BEE4_OKX_DEMO_API_KEY`, …) like any extra bee.
