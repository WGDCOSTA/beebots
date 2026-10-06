# Research, October 2026: what holds up on real OKX data

An independent check of the strategy lab, run on 6 October 2026 with TA-Lib (201 indicators, 61 candlestick
patterns) outside the engine. Scripts: `tools/research/` (`fetch_daily.py` pulls OKX daily candles, `research.py`
runs everything; build the image from `tools/research/Dockerfile`).

Paper simulation on past data. Past results do not predict future ones. Not financial advice.

## Data and costs

- 1H: the lab's own OKX history, 39 USDT perpetuals, one year (Oct 2025 to Oct 2026, a falling market).
- 1D: OKX daily candles from 2020 (or listing) to Oct 2026 for 22 large coins: two bull and two bear markets.
- Costs: 5 bp fee + 2 bp slippage per side, funding 0.01% per 8 h held. Stops and ROI targets fill inside the bar,
  the stop first, as the lab does.
- Out of sample: the last 40% of each series, never used to pick anything. Strategies use their textbook parameters.

## Findings

1. **Candlestick and double top/bottom patterns: no edge.** 171 pattern x direction x timeframe tests (1D, 4H, 1H);
   none passes a Benjamini-Hochberg false-discovery test in sample, so none is used as a signal.
2. **Short horizons: no edge after costs.** On 1H every trend rule lost 7-49% over the year, and the lab's leaders
   lose in a realistic equal-weight portfolio: `ft_bb_rsi` -13%, `ft_willr_stoch` -2.6%, buy and hold -39%. The
   lab's own table shows them positive because it averages per-dataset results and re-picks parameters per fold;
   that scoring deserves an audit. The scalper lab already reports no edge at one minute.
3. **Daily trend following holds up.** Out of sample (Sep 2023 to Oct 2026), equal weight over 22 coins:

| rule (daily) | return | max drawdown |
|---|---|---|
| buy and hold | +2.9% | -76% |
| own a coin while above its close of 90 days ago | **+85%** | -50% |
| Donchian 20/10 (turtle style) | +36% | -49% |
| above the 200-day average, volatility-targeted | +28% | **-28%** |

   It still lost in 2022 and 2025: trend following cuts bear markets short, it does not avoid them.

## What the bunnies use from it

- **Dozy** (`src/bees/dozy.ts`, style `dozy`): the 90-day rule on the large coins, strongest first, one coin per
  position slot, the book sized to a 2% daily volatility target, a catastrophe stop 3 daily ATRs away, and a code
  exit when the coin falls back below its 90-day level. Daily bars mean few trades and few Jev calls.
- Leverage stays modest on purpose: at 1x the daily rule already drew down 50%.
