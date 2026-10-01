# Arena: three plans, autonomous agents, and connecting a real OKX account

Status: design, 1 Oct 2026. Only the plan table (Free, Pro, Premium) is in code. Everything else here is not built.
Written from the owner's instructions of 1 Oct 2026, updated the same day with the owner's answers (section 10). Where a point needs the owner or counsel to decide, it says so.

## 1. Plans

| | Free | Pro | Premium |
|---|---|---|---|
| Agents | 1 | up to 9 | up to 20 |
| Styles | Trend, Breakout | all three | all three, plus autonomous mode |
| Coins per agent | 3 | 8 | 8 (autonomous agents choose their own, see 3) |
| Theme packs | free packs | all | all |
| Autonomous mode (agent picks and changes its style, trades any token or stock, long, short or scalp) | no | no | yes |
| Model brains per agent | 1 | up to 3 | up to 6 at once |
| Skill slots | 5 | 30 | 30 (not stated; Pro's until the owner says otherwise) |
| Historical market data and simulated training on it | no | yes | yes |
| Connect a real OKX account | yes, at the member's own risk (see 5) | same | same |

In code now: `Tier = "free" | "pro" | "premium"` and `LIMITS` with agents, brains and skill slots. Prices: **Pro 9.99, Premium 15.99** (the owner gave no currency or period; euro and month are assumed, in `plans.ts`). Billing exists (see the plan's build status). Brains, skill slots, historical data and autonomy are not built, so the plans page marks them "coming soon".

## 2. The 7-day paper recommendation

The platform recommends running an agent on paper for 7 days before connecting a real account. It is a recommendation, not a lock: the member may connect at once, on their own responsibility.

- The connect screen shows a readiness list read from real data: days on paper (of 7 recommended), trades, biggest drop, any days with a model outage. Nothing on it blocks.
- Skipping the recommendation needs a typed acknowledgment ("I understand I can lose the money in this account and I am choosing to skip the 7 days"). The server stores the text version, the time and the agent, like the consent record, and nothing else.
- A paper run's numbers and a live run's numbers are never mixed. The public leaderboard stays paper only: live results cannot be verified by the platform.

## 3. Autonomous mode (Premium)

Chosen when the agent is created (a fourth option next to the three styles, locked with the reason for other plans). The agent then:

- picks its own style for each decision and may change it whenever it wants;
- may trade any token the data feed covers, long or short, or scalp (the engine already has a scalp method with a model mandate and a maker-execution path);
- is still bound by the same code-level risk rules that cannot be switched off: stops, time stop, daily loss stop, exposure and leverage limits, the fee budget, the per-agent daily model budget.

What it takes in the engine (not built):

1. A new brain, `autonomous`, whose menu is the union of what every style offers on the coins it may use, with the style named on each option so the choice and the reason are recorded. Today one bee has one style; the owner's engine can already adopt a specialization, so this is mostly a menu and a record, not a new engine.
2. A bigger coin universe, filtered by the feed's volume and spread gates. The universe for stocks is a separate decision (see 6).
3. A model-cost budget by plan, because an agent that looks at more options asks a larger question.
4. Its own league on the board (`premium:autonomous`): it has freedoms the fixed styles do not, so it should not be ranked against them.

The Decisions tab already shows what it saw, the odds and the rule that overruled it, so an autonomous agent's style changes appear there with no new screen.

## 4. Several model brains per agent (Premium)

The owner's admin already has a registry of brains (OpenAI, Z.ai GLM, custom OpenAI-compatible endpoints). For members the open choices are:

- whose keys: the platform's pool (needs a per-member cost budget) or the member's own (needs the key vault: encrypted per member, write-only, never in a response or a log);
- how several brains work together: one decides and another reviews, a vote, or one per role. Voting is the simplest to explain and to cost (N calls per decision).

Decision needed from the owner: bring-your-own keys, platform pool, or both; and the cost ceiling per Premium agent per day.

## 5. Connecting a real OKX account

This is the largest change of the whole plan, because it moves from simulated money to a member's money. Earlier decisions said "paper only at launch; live is a later phase behind legal review and a custody decision". Those two gates stay, and this section lists what the gates have to cover.

Safety design:

- The member creates an OKX API key with **trade permission only and no withdrawal permission**, and ideally an IP allowlist for the runner's address. The page refuses a key that reports withdrawal permission.
- Keys live in the vault: encrypted with a key held outside the database (KMS or an environment secret), write-only from the API, decrypted only inside the runner at order time, never logged (the existing redaction applies).
- Per agent, set by the member and capped by the platform: maximum position size, maximum leverage, daily loss limit that stops the agent for the day, and a total loss limit that retires it.
- A **kill switch** on every agent and a "stop everything" on the account: close positions with reduce-only orders and cancel open orders. It must work even if the model provider is down.
- The live executor is the owner's existing OKX executor, with a reconciliation loop against the exchange; today it has only been used for the owner's own account, so it needs its own test pass on a sub-account before any member uses it.
- Live and paper are separate runs of an agent. Switching to live is a new version with its own record, never a silent change to a paper run.

Needs counsel before any code touches a member's money (Ireland, EU):

- Whether running an autonomous agent that trades a client's account makes the operator a regulated provider (portfolio management, investment advice, or a crypto-asset service under MiCA). The answer may change what the product may promise, say or charge.
- Marketing and risk wording for "autonomous AI trader", including what may be said about the 7-day paper track.
- Custody of keys, liability when an agent loses money or an outage leaves a position open, and records the operator must keep.
- Whether Premium may be sold to consumers in the EU on these terms (consumer law, 14-day withdrawal, the existing VAT questions).

## 6. Stocks

OKX is a crypto exchange. Trading stocks needs a broker connection (Alpaca is already used for the owner's research data; its trading API has paper and live modes). That is a second integration with its own keys, hours, margin and short-selling rules, and its own regulatory questions. Suggested order: crypto on OKX first, stocks through the broker's paper account next, stocks live last and only after counsel.

## 7. Capacity

One Engine per agent, one SQLite file each. 20 agents per Premium member multiplies that. The runner currently allows 25 engines at once; a few Premium members would fill it. Before launch, measure the cost of one engine tick and decide whether to keep one process, shard by member, or run agents on a shared engine.

## 8. Build order

1. Step 3: leaderboard page, Me page, empty and error states, translated (already planned).
2. Billing on the operator's Stripe: Free, Pro, Premium; plan changes; the 10-day quarantine on downgrade (an agent above the new limit, or an autonomous agent on a plan without autonomy, stops, leaves the board, and is restorable by upgrading).
3. Key vault, for model keys (members' own) first.
4. Autonomous mode on paper, with its league and its cost budget.
5. Several model brains, once 3 and 4 exist.
6. The readiness list and the typed acknowledgment (they need no live code and can ship early).
7. Live OKX connection, only after counsel signs off and a sub-account test pass.
8. Stocks via a broker, paper first.

## 9. Open questions

1. What does Pro give beyond more agents and all styles? Price of Pro and Premium?
2. Premium model brains: bring-your-own keys, platform pool, or both? Daily cost ceiling per agent?
3. Does the autonomous agent get one league on the board, or none (private only)?
4. Live trading: does the owner accept that nothing goes live until counsel has answered section 5, even though the member is willing to take the risk? (The member's consent does not by itself settle what the operator may offer.)
5. Which stock broker, if any, and which markets.

## 10. Owner's decisions of 1 Oct 2026

1. **Live trading is the member's own act, not ours.** The member puts in the keys of an OKX **sub-account** and runs the agent on their own account, at their own risk, under their own supervision as the agent's creator. The platform does not custody funds and does not trade for anyone; it provides the software. The 7-day paper track stays a recommendation the member may skip. *Caveat recorded, not decided:* "we do not custody funds" is true, but if the agent runs on our servers with the member's trade-only key, our software still places the orders. Counsel should confirm this exact arrangement before live is switched on. The alternative that keeps keys off our servers is a runner the member runs themselves; it is the safer reading for the operator and costs the member more effort. Until counsel answers, live stays off.
2. **Model brains:** the member's own keys if they want, or the platform pool. With the member's own keys there is no platform cap (the bill is theirs); the page shows usage and lets the member set a cap of their own. On the platform pool a cap per agent per day is needed. *Proposal, for the owner to confirm:* Free $0.50 (today's default), Pro $1.00, Premium $2.00 per agent per day.
3. **Pro** is up to 9 agents, all styles and packs, plus: up to **3 model brains**, **30 skill slots**, **historical market data**, and **simulated training on historical data** to prepare an agent before it runs on paper. Premium adds autonomy, up to 20 agents and more brains. *Price of Pro and Premium: still open.* *To define:* what "training" means in the product (suggested: replaying the agent over stored candles faster than real time and keeping the result as its record, like the Lab's backtests, kept apart from the paper track and never on the leaderboard); what a "skill" is for a member (the Lab's skills are rule sets that are backtested before use); which data and how much history.
4. **Autonomous agents** get **their own league** (`premium:autonomous`) and may also be kept **private**.

Still open: prices; the number of brains on Premium; whether Free has skill slots; the training definition above; counsel's answer on item 1.

### Answers of 1 Oct 2026, second round
- Prices: Pro 9.99, Premium 15.99. Premium runs up to **6 model brains at once**. Free gets **5 skill slots**.
- **Simulated training** (defined by the owner): replay the agent over historical candles faster than real time and keep the result as its own record, separate from the paper track and outside the ranking.
- **Skills:** a skill bank and a marketplace, where a member picks skills made by others or creates their own. (The Lab's skills are rule sets that are backtested before use. A marketplace brings seller payouts, review of what is sold and liability for it; those are separate decisions and stay in the plan's marketplace step.)
- Risk to settle with counsel: the plans page lists brains, skill slots, historical data and autonomy, which the Arena cannot do yet. They are marked "coming soon", but selling a subscription for features that do not exist is a consumer-law question. The safe order is to open payments when most of them work, or to word them as roadmap, not as included.
