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
gap when shut and that it should prefer taking profit or tightening risk near a close. A position it already holds
is still managed (stops, exits) when its market closes. Everything else is unchanged: Jev decides, the risk layer has
the last word, leverage is capped at `MAX_LEVERAGE`.

## Not done yet (next phases)

- A dedicated **macro style** (trend and mean reversion tuned for metals and indices). Macro bees run on the
  Momentum style for now (the strongest 7-day mover of their market).
- **Flatten before a close or weekend** as a hard rule, and a gap-risk size factor.
- A **lab pack** of session-aware skills (opening-range breakout, gap fade, RSI(2) on SPY) and long history from
  CSV/CCXT imports.
- A macro news calendar (CPI, FOMC, payrolls) blackout.
- Outside paper trading each macro bee needs its own OKX keys (`BEE4_OKX_DEMO_API_KEY`, …) like any extra bee.
