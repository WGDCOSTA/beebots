# The lab brain and the coin book

The strategy lab runs on its own. Each coin's 1-minute scalp rules evolve from four sources:

| Source | Who | How |
|---|---|---|
| `lab-brain` | The lab's brain: GPT by default (`LAB_BRAIN`) | A study of everything the brains know, every `LAB_BRAIN_INTERVAL_MIN` (6 h). |
| `bunny:<slot>` | A bunny's own brain | One bunny per study round proposes up to 2 rules for its own coins. |
| `manual` | You | Admin → Coin rulebook: add a rule, or pin, block, retire or requeue one. |
| `autonomous` | The book itself | It reads what the lab measured and what live trades did. |

Code: `src/lab/coinBook.ts` (the book), `src/lab/scalpDsl.ts` (rules written as data), `src/brains/labBrain.ts` (the
study), `src/autolab.ts` (the lab runs). Tests: `test/lab-brain.test.ts`.

## The loop

1. **Study.** The lab brain reads one dossier:
   - the coin book (each coin's rules, lab tests, live results, the log);
   - the latest scalp lab report (net, gross, gross before costs, fees, fill rate, folds, plateau, per coin and rule);
   - the 1-hour skill ranking;
   - every bunny's memory (lessons, consolidated memories, research, trade record, adopted skills, approved background);
   - why each bunny isn't trading;
   - approved research notes;
   - the crew (the Rat's brief, the Owl's and the Pig's notes);
   - live P&L per coin, the market mood;
   - its own last studies.

   It writes a study and does up to four things:
   - files up to 6 rules (existing ones per coin, or new ones in the DSL);
   - retires up to 6 dead ones;
   - names up to 8 focus coins;
   - asks the lab to run sooner.
2. **A bunny proposes.** In rotation, one bunny's brain sees its own coins, memory and the lab's tests of them, and
   proposes up to 2 rules.
3. **The lab tests.** The autonomous scalp lab (`AUTO_SCALP_LAB_INTERVAL_HOURS`, now daily, sooner on request at most
   every 6 h) tests each coin with the rules its book entry plans:
   - the built-ins;
   - up to 4 written rules per coin (pinned first, then queued, then validated);
   - rules proposed for every coin (`*`).

   Coins with a passing rule, coins with rules waiting, and the brain's focus coins join every batch. The rest rotate.
4. **The book moves:**
   - an edge after costs (walk-forward, real data, enough out-of-sample trades, profitable folds, a parameter plateau)
     makes the rule **validated** for that coin;
   - no edge makes it **failing**;
   - three misses in a row **retire** it for 14 days, then it is queued again.
5. **The gate.** The live scalper trades only:
   - what the latest report passed, minus what the book blocked or retired;
   - plus what the book validated on real data within `SCALP_LAB_MAX_AGE_DAYS`.

   Jev still sets each mandate, and the risk layer, fee budget, spread gate and circuit breaker all still apply.
6. **Live feedback.** Every closed scalp is booked against its coin and rule. After 12 live trades, a rule losing after
   costs is **demoted** for 7 days, whatever the lab said.

A brain can never retire a rule you pinned or filed. A blocked rule is never tested or traded, and brains cannot
re-propose it.

## Writing a rule (the scalp DSL)

```json
{
  "id": "rsi_snap",
  "name": "RSI snap",
  "description": "Fade RSI(7) extremes above the 100 EMA",
  "params": { "lo": { "default": 20, "grid": [15, 25] } },
  "trade": { "targetAtr": { "default": 1, "grid": [0.8, 1.4] }, "stopAtr": { "default": 1.6 }, "holdBars": { "default": 12 } },
  "long": { "entry": [ { "left": "rsi(7)", "op": "<", "right": "$lo" }, { "left": "close", "op": ">", "right": "ema(100)" } ] }
}
```

**Entries**
- Same conditions as the skill DSL (`src/lab/skills/dsl.ts`): `< <= > >= crosses_above crosses_below`, `{ "any": [...] }`.
- Indicators: sma, ema, rsi, atr, atr_pct, roc, zscore, stoch, highest, lowest, Bollinger, macd_hist, supertrend, adx,
  plus_di, minus_di, cci, mfi, willr, stoch_d, volume_sma. Fields: close, open, high, low, volume. Values: `$params`
  and numbers.
- A rule fires on the bar its conditions **become** true.

**The exit (`trade`)** is the scalper's own. Its bounds:

| Knob | Range | Meaning |
|---|---|---|
| `targetAtr`, `stopAtr` | 0.3–5 | Target and stop, in ATR(14) multiples on 1-minute bars |
| `holdBars` | 2–240 | Time stop, in minutes |
| `waitBars` | 1–10 | How long a resting entry waits for its fill |
| `makerEntry`, `makerTarget` | 0/1 | 1 = resting maker limit, 0 = taker |
| `entryOffsetBps` | 0–20 | Entry offset from the close |
| `costGateMult` | 2–10 | A target must be at least this many times its round-trip cost; it never drops below 2 |
| `minAtrBps`, `maxAtrBps` | 0–500, 1–5000 | The ATR band the rule trades in |
| `cooldownBars` | 0–120 | Bars to wait after a trade |

A grid holds at most 512 combinations; the lab samples down to 96.

## Switches

| Variable | Default | |
|---|---|---|
| `LAB_BRAIN` | `openai` | Any brain id with a key; `0` turns the study off (the book still evolves from lab and live results). |
| `LAB_BRAIN_MODEL` | the ChatGPT model | Its own GPT for the study (e.g. `gpt-6-astra`), apart from the bunnies'. |
| `LAB_BRAIN_EFFORT` | `OPENAI_REASONING_EFFORT` | Its own `reasoning.effort`: low, medium, high, xhigh or max. |
| `LAB_BRAIN_INTERVAL_MIN` | 360 | Minutes between studies. |
| `LAB_BRAIN_MAX_CALLS_DAY` | 8 | Brain calls per day, studies and bunny proposals together; counted durably. |
| `LAB_BRAIN_START_DELAY_MIN` | 10 | The first study after a start, if none is due sooner. |
| `AUTO_SCALP_LAB_INTERVAL_HOURS` | 24 | The scalp lab cycle. Was 168: set 24 in your `.env` if you copied the old example. |
| `SCALP`, `SCALP_COINS`, `SCALP_UNIVERSE_SIZE` | | As before. |

## Where to see it

- `#/lab` → **Coin rulebook**: the latest study, every coin's rules with lab and live numbers, and the book's log.
  It is public, so no rule specs are shown there.
- Admin → **Coin rulebook & lab brain**: the same view with the rule specs, plus:
  - **Run a full study now**;
  - add a rule;
  - per rule: pin, block, test again or retire.
- `GET /lab/book` holds the same data as JSON.

Paper research, not financial advice. A rule that passed the lab on past data can still lose; live feedback is there
for that.
