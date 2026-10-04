# Glitchbunny 🐰

(The code and the repository keep the name beebots.)

[![Watch the video: I built AI trading bunnies with Jev](docs/video.jpg)](https://www.youtube.com/watch?v=8ijN8LGljKg)

Four main AI trading agents race each other on OKX perpetual futures: three owner-designed bunnies and **Degen**, an
evidence-gated autonomous scalper. Jev sets decisions or short-lived scalp mandates, and every order goes through a
risk layer written in plain code. A live dashboard shows each
decision, order, fee and funding payment as it happens.

**It runs on paper by default.** The bunnies use real market prices and simulated money. Nothing touches an exchange
account unless you change the settings yourself, on purpose.

![The beebots dashboard trading on paper](docs/screenshots/dashboard.jpg)

> **Not financial advice.** beebots is an experiment and a piece of open-source software. It is not a trading product,
> and nothing it does is a recommendation to buy or sell anything. Leveraged crypto trading can lose everything you
> put in. The software comes with no warranty (see [LICENSE](LICENSE)). If you ever switch it to real money, that
> is your decision and your risk.

## Run your own in one click

[![Deploy on Hostinger](https://assets.hostinger.com/vps/deploy.svg)](https://www.hostg.xyz/aff_c?offer_id=815&aff_id=202403&url=https%3A%2F%2Fwww.hostinger.com%2Fdocker-hosting%3Fcompose_url%3Dhttps%3A%2F%2Fraw.githubusercontent.com%2Fimikerussell%2Fbeebots%2Fmain%2Fdocker-compose.yml%26utm_medium%3Daffiliate%26utm_source%3Daff%7Baffiliate_id%7D%26utm_campaign%3D%7Boffer_id%7D%26session%3D%7Btransaction_id%7D)

Use code **MAGIC10** at checkout for 10% off.

1. Click the button, pick a VPS plan (a **KVM 2** is plenty) and check out. Hostinger sets up Docker and starts
   beebots for you.
2. Open your server's IP address in a browser. You'll see the **Setup** page. Do this soon: Setup stays open for
   2 hours after the server starts (see [Setup safety](#setup-safety)).
3. On Setup:
   - tick the three risk statements
   - pick an **owner password** (8+ characters). Your dashboard is public; the password is what lets *you* change
     things from it later, like joining or leaving the Warren. Write it down.
   - paste your **Jev key** (from [console.typesafe.ai/keys](https://console.typesafe.ai/keys))
   - paste an **OpenAI key** (required: it designs your bunnies and paints them; a few cents in total)
   - design your three bunnies. For each one, answer **How do you want this bunny to trade?** in a sentence ("a Trump bunny
     that only ever trades TRUMP", "a sleepy bunny that only buys bitcoin dips"), press **Create my bunny**, and OpenAI
     invents its name, tagline, trading rules and the coins it may trade. Rename it if you like, then press
     **Generate your bunny's portrait**. You can carry on once all three bunnies have their portraits. The fixed fourth
     agent, Degen, joins automatically with its own portrait and scalping rules.
   - choose whether to join **the Warren** (see below). "Not now" is fine; you can join later.
4. Press **Start paper trading**. The engine restarts, and the dashboard goes live.

| Agree to the rules | Pick an owner password | Design your bunnies |
|---|---|---|
| ![Risk statements](docs/screenshots/setup-rules.jpg) | ![Owner password](docs/screenshots/setup-password.jpg) | ![Design your bunnies](docs/screenshots/setup-bees.jpg) |

### Setup safety

Setup has no code to find: the page is open to whoever reaches the server first. So:

- **First come, first served.** Once you press Start, Setup closes for good. Nobody else can change your keys or bunnies.
- **A setup window.** If nobody finishes Setup within 2 hours of the engine starting (`SETUP_WINDOW_MIN`, default
  120), it locks, and the page says so. Restart the engine to open it again: Hostinger **Docker Manager** → the
  `beebots` project → **Restart** on the `engine` container, or `docker compose restart engine`.
- **Caps** on the calls that cost money (designs and portraits), in total and per visitor.

Set up right after deploying, and use a domain with HTTPS if you can (`PUBLIC_DOMAIN`, below) so your keys don't
travel over plain HTTP.

Each bunny gets its own portrait, painted in the same style as the originals:

<img src="docs/screenshots/generated-bee.jpg" alt="A generated bee portrait" width="256">

**Copy a winning bunny.** Every bunny on [beebots.tech](https://beebots.tech) shows its rules with a **Copy** button. Copy
a winner's rules and paste them into **How do you want this bunny to trade?** to start from its playbook.

Each bunny starts with $333 of paper money. Jev spending is capped at $2 a day by default.

### Already have a server?

Any machine with Docker works:

```sh
curl -fsSLO https://raw.githubusercontent.com/imikerussell/beebots/main/docker-compose.yml
docker compose up -d
```

Then open `http://<your-server-ip>/`.

### Updating

New versions are published as [releases](https://github.com/imikerussell/beebots/releases). When one is out, your
dashboard shows **Update available** next to the trading mode, linking to what's new. Nothing updates by itself.

To update, pull the new images and restart. Your bunnies, settings and history live in Docker volumes and are kept:

```sh
docker compose pull
docker compose up -d
```

Run it over SSH (or hPanel's browser terminal on Hostinger) in the folder that holds your `docker-compose.yml`
(`docker compose ls` shows where it is). To turn the check off, set `UPDATE_CHECK=false`.

## The Warren

The Warren is a public leaderboard at [beebots.tech](https://beebots.tech) where everyone's bunnies race each other. It is
**opt-in**: nothing is sent unless you join. What you agree to when you join:

> You're about to share your bunnies' names, styles and paper-trading results on the public leaderboard at beebots.tech. The board shows % gain/loss only. No keys, no exchange account details, no IP address. Paper trading only. Not financial advice. You can leave any time.

- **What is shared:** your bunnies' names, taglines and styles, their trade counts, their paper equity and funding, and
  each paper fill (coin, side, size, price, time, fee). The board shows the % gain or loss, not dollars; the equity and fills are
  there so it can replay every trade against OKX's public prices and mark the bunny **verified**. Also a random warren id
  and key made when you join, so later reports can be matched to your install.
- **Never shared:** your Jev, OpenAI or OKX keys, any exchange account data, your server's address, or anything else.
- **Paper only.** The engine refuses to report in `MODE=live`, and the board rejects live reports.
- **Join or leave:** tick it on Setup, or use **Join the Warren** in the dashboard header. Joining and leaving from the
  dashboard need your **owner password** (the one you picked on Setup; 8 wrong tries lock it for 15 minutes). Leaving
  removes your bunnies and their history from the board. Running Setup
  again and answering **Not now** also leaves the Warren, on the next engine start.

The Warren is a game, not a signal service. **Not financial advice.**

## How your bunnies trade

Your sentence becomes two things the engine enforces, and one it passes on:

- **Coins.** If your bunny names coins, it only ever trades those. They must be crypto perpetuals listed on OKX EEA right
  now (Setup checks the live list and asks you to rephrase if none match).
- **The engine it runs on.** An owner-designed bunny runs on one of the first three built-in styles below. A bunny limited to BTC and/or
  ETH can run on Trend; one limited to BTC, ETH, SOL or HYPE can run on Breakout; everything else runs on Momentum,
  which works on any coin.
- **Rules.** Its rules go to Jev with every decision, and Jev follows them when picking among the moves the style
  offers. They steer the choice; they can't invent moves the style doesn't have, and the risk layer below still applies.

A coin still has to pass the same gates as any other (at least $1M of 24h volume, a tight spread). If your bunny's coin
doesn't, the bunny just waits until it does.

## The four trading styles

| style | the original bunny | what it does |
|---|---|---|
| **Breakout** | Bizzy, the grinder | One volatility breakout a day on BTC, ETH, SOL or HYPE, ridden to the daily close. |
| **Trend** | Breezy, the calculated one | Trend following on BTC and ETH only. Few trades, rides winners, sized by volatility. |
| **Momentum** | Boozy, the degen | Chases the strongest 7-day mover across every liquid coin, and adds to winners. |
| **Scalper** | Degen, the autonomous one | Longs or shorts one-minute setups across the liquid universe, but only after the real-data lab finds an edge after costs. |

Bizzy, Breezy, Boozy and Degen are the official agents (they run on [beebots.tech](https://beebots.tech)), so their names and art
are theirs; your bunnies get their own. Two of your bunnies can share a style. The full rules are in [`strategies/`](strategies/), and the rules every bunny
shares (caps, stops, "never flat for long") are in [`strategies/DRAMA_RULES.md`](strategies/DRAMA_RULES.md).

## How a decision is made

Every normal decision tick, for every bunny:

1. **Look.** Live OKX market data: tickers, candles, RSI, MACD, ATR, Bollinger, Donchian, funding, open interest.
2. **Summarise.** A small numeric snapshot of the market and the bunny's own position.
3. **Ask Jev.** Jev picks one move from a menu of moves that are actually valid right now, with probabilities.
4. **Check.** Plain code can veto, shrink or force the move: max 2x leverage, per-bee stops, a daily loss stop,
   trade caps, a fee budget, cooldowns, and a hard daily cap on Jev spending.
5. **Record, then act.** The decision is written to SQLite before anything happens.
6. **Broadcast.** The dashboard streams it live.

Jev is stateless and never sees an order endpoint. If Jev is down or slow, the bunnies hold and open nothing.
Degen uses Jev only to approve a bounded coin/direction mandate; deterministic one-minute rules may execute several
maker trades inside it without another model call. No mandate, current real-data lab evidence, or cost coverage means no entry.

## Brains, the strategy lab and the warren memory

On top of Jev, each main bunny can have its own **LLM brain**: ChatGPT (bunny 1), Claude (bunny 2) and Kimi (bunny 3), each
on its own API key. The brains are slow and strategic; they never place an order.

- **Skills.** Trading rules (trend, breakout, momentum, mean reversion, hybrids), 17 built in and more importable as
  JSON from [`skills/`](skills/).
- **The lab.** `pnpm lab fetch` downloads OKX history; `pnpm lab run` simulates every skill and parameter set with fees,
  slippage, funding and stops, using walk-forward so only out-of-sample results count, and ranks them.
- **The council.** `pnpm lab council`: each brain reads the ranking and the warren memory, picks the skills its bunny should
  lean on and the coins it should trade (its watchlist, from lab evidence, its record and liquidity, within the
  owner's coins and its style), writes lessons and messages the other bunnies.
- **The warren memory.** A knowledge graph (bunnies, brains, skills, coins, lessons, messages, real trade results) that every
  round starts from, exported as graphify-style `graph.json`.
- **Live.** With `LAB_SIGNALS=true` Jev sees each bunny's skill vote per coin as a tiebreaker; with `COACH_INTERVAL_MIN`
  set the brains re-weight their skills from the bunny's real results while it trades.

**Survival and rewards.** Every bunny knows it can die at the retire line: in danger it trades smaller and several
brains combine to rescue it, writing and backtesting new skills if they must. Profitable bunnies earn points and levels
that unlock prizes (more skills, skill writing, extra brains, bigger limits, never more leverage). The owner can add
up to six more bunnies and edit what every bunny trades, including a **macro squad** on gold, oil and stocks that trades
only in trading hours the engine verifies from the market ([docs/MACRO_SQUAD.md](docs/MACRO_SQUAD.md)).

On the dashboard, **Lab & warren memory** (`#/lab`) shows the ranking, each bunny's playbook and the graph, and **Admin**
(`#/admin`, owner password) configures keys, bunnies, brains, risk limits and style knobs, runs the lab and restarts
the engine. Trading mode and exchange keys stay in `.env`.

**The Farmer.** Every two hours an overseer with a voice looks at all the bunnies, says one line on the main page and,
when a bunny keeps losing under its rules, may rewrite those rules (never its coins, style or money), at most once per
bunny per day. With real money he only suggests unless you set `FARMER_MODE=apply`. Every round, with each rewrite's
old and new rules, is on `#/farmer`. `FARMER=0` turns him off; `FARMER_BRAIN` picks his brain (default Claude, then
ChatGPT); `FARMER_INTERVAL_MIN` (120) sets how often he looks. His portrait is painted once with your OpenAI image key, in
the bunnies' style (`FARMER_PAINT=0` keeps the drawn one).

**Ask a bunny.** Each bunny's page has an *Ask me* tab: visitors ask it for a view on a market or about itself and it
answers with a report drawn from real candles (charts, figures, its own record). Read-only, questions are not stored,
5 per visitor per hour and 300 a day (`PUBLIC_CHAT_PER_HOUR`, `PUBLIC_CHAT_DAILY_LIMIT`; `PUBLIC_CHAT=0` turns it off).

**Visitors' map.** Click *Visitors* in the header: a world map of where visitors come from, placed by the time zone
their own browser reports (no address is looked up or kept).

Details, commands and settings: [docs/INTELLIGENCE.md](docs/INTELLIGENCE.md).

## Settings

Most people need none: Setup covers the keys. To change anything else, create a `.env` next to
`docker-compose.yml` (or set the variables in Hostinger Docker Manager) and restart. Every setting is documented
in [`.env.example`](.env.example). The common ones:

| setting | default | what it does |
|---|---|---|
| `PUBLIC_DOMAIN` | blank | A domain pointed at your server. Caddy then gets an HTTPS certificate on its own. **Recommended**: without it, the Setup page and your keys travel over plain HTTP. |
| `TICK_MS` | `10000` | How often each bunny asks Jev. Faster is more exciting and costs more (see [docs/COSTS.md](docs/COSTS.md)). |
| `JEV_DAILY_USD_CAP` | `2` | Hard daily cap on Jev spend. When it's hit, every bunny holds until 00:00 UTC. |
| `BEE_START_EQUITY_USD` | `333` | Paper money per bunny. |

**Run Setup again** (new names, new keys, or a forgotten owner password):

```sh
docker compose exec engine rm /data/settings.json
docker compose restart engine
```

Run these on the server (on Hostinger, over SSH from hPanel), then open the site and go through Setup again. The
setup window starts over with the restart.

**Owner password:** it's stored only as a salted hash in `/data/settings.json`, so nobody (including you) can read it
back. If you forget it, run Setup again as above. Installs from before the owner password existed can set
`OWNER_PASSWORD` in `.env` (8+ characters) instead.

**Something wrong?** The engine's log says what it's doing: `docker compose logs engine`, or Hostinger Docker
Manager → the `engine` container's logs.

**Backups:** a sidecar writes a nightly copy of each database to `/data/backups` inside the `bees-data` volume and
keeps the newest 3 (`BACKUP_KEEP_DAYS` in `.env`). That copy lives on the same server, so take an off-server copy yourself if you care about the history.

## Real money (read this twice)

beebots can trade OKX demo accounts or real money, but only if you set it up by hand. It is **not** part of Setup, and
there is no button for it.

- Real money needs **all** of: `DRY_RUN=false`, `MODE=live`, four OKX **EEA** sub-account API keys
  (`BEE1_OKX_API_KEY` etc., Read + Trade only, **never Withdraw or Transfer**, IP-bound to your server), and
  `LIVE_ACK=I-ACCEPT-REAL-MONEY-RISK`. With any one of them missing, the engine refuses to start.
- The first hours of live trading run at reduced size (`LIVE_SIZE_MULTIPLIER`, `LIVE_RAMP_HOURS`).
- The bot can never withdraw. Moving money off the exchange is always done by you, by hand.
- Try `MODE=demo` first, with OKX **demo** keys (`BEE1_OKX_DEMO_API_KEY` etc.).
- The engine talks to OKX's EEA site (`eea.okx.com`). Check that OKX's derivatives are available where you live
  before you go anywhere near real money.

**Ending a live run:** `docker compose exec engine touch /data/close-live`. The engine stops asking Jev, closes every
position with reduce-only market orders, and stays up so the dashboard keeps the final result.

Again: this is not financial advice, and you can lose everything.

## Develop

```sh
pnpm install
pnpm test            # risk layer (every cap, gate and forced move, both directions), setup, redaction, indicators, ledger
pnpm universe        # the tradable coin list from live public data (no keys)
pnpm snapshot        # each style's menu and snapshot from live data (no Jev call)
pnpm e2e:fake-jev    # the whole engine on paper with a random fake Jev (no spend)
pnpm lab cycle       # strategy lab: fetch history, rank every skill walk-forward, let the brains pick (docs/INTELLIGENCE.md)
pnpm dev             # the real engine on paper, with real Jev calls (Setup runs if there is no key)

cd dashboard && pnpm install && pnpm dev    # http://127.0.0.1:5173, proxied to the engine
```

Build the images yourself instead of pulling them:

```sh
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

Everything on OKX is built on OKX's own open-source [Agent Trade Kit](https://github.com/okx/agent-trade-kit) (MIT).
Public market data (instruments, tickers, candles, open interest, funding) runs in-process on the kit's own public REST
client and rate limiter, vendored in `src/okx/kit/` with its licence, so there is no child process per call; `pnpm parity`
checks it returns the same data as the CLI. Signed calls (orders, positions, fills, leverage, news) go through the kit's
CLI. Keys never touch disk inside the container except in the Setup file (`/data/settings.json`, owner-only). The
logger and the event stream redact anything that looks like a key, an IP address or an email.

## Credits

Built by Mike on the Creator Magic YouTube channel, in the video "I gave three AI bunnies $1,000".
Hosted on [Hostinger](https://www.hostg.xyz/aff_c?offer_id=815&aff_id=202403&url=https%3A%2F%2Fwww.hostinger.com%2Fdocker-hosting%3Fcompose_url%3Dhttps%3A%2F%2Fraw.githubusercontent.com%2Fimikerussell%2Fbeebots%2Fmain%2Fdocker-compose.yml%26utm_medium%3Daffiliate%26utm_source%3Daff%7Baffiliate_id%7D%26utm_campaign%3D%7Boffer_id%7D%26session%3D%7Btransaction_id%7D). Decisions by [Jev](https://typesafe.ai).

MIT licence. No warranty. Not financial advice.
