# Arena: multi-user bot platform plan

Status: proposal, nothing here is built yet. Decisions marked **Decided** come from the owner; everything else is a recommendation to confirm.

## 1. Product in one paragraph

Today Warren is a single-owner system: one engine, one database, one admin. The Arena turns it into a platform where each user sets up their own bots with their own keys (Jev, ChatGPT/Codex or any OpenAI-compatible model), competes in public rankings, collects badges, picks avatars from themed categories, and can publish or sell skills. Money comes from **subscriptions** (**Decided**).

## 2. Decisions

| Topic | Decision |
|---|---|
| Copy trading | **Removed** from the plan. No copying of orders, paper or real. Rule forking (copying a bot's *rules*, not its trades) stays. |
| Money mode at launch | Paper trading only. Live trading is a later phase behind legal review. |
| Business model | Subscription (**Decided**). |
| Tiers | Free and Pro (Pro includes selling skills). |
| Platform admin | Sees operations only. No user keys, positions, bots or strategy text. |

## 3. Tiers

| | Free | Pro |
|---|---|---|
| Bots | 1 | Several (limit set per plan) |
| Skills | Simple, free ones only | Advanced, may publish paid skills |
| Own skills | Create and share free | Create, share and sell |
| Avatars | Standard pack | All packs, AI generation with monthly quota |
| Affiliate | Yes, same link | Yes, plus a bonus on Pro conversions |
| LLM | Bring your own key | Bring your own key, optional platform credits |

Quotas (bots, decisions per hour, LLM calls, storage) are enforced per tier from day one. Without them a Free user can cost more than a Pro user.

## 4. Access boundary (the "admin sees nothing" rule)

- Every user row carries `tenant_id`; no query is allowed without it (enforced in one data-access layer, tested).
- Provider keys are stored encrypted per tenant with envelope encryption (a KMS master key). Keys are decrypted only inside the bot worker for the duration of a call and never returned by any API, including to their owner (write-only, show last 4).
- The platform admin app is a separate service with its own auth. It exposes: health, queue depth, costs, subscription status, abuse reports, marketplace moderation. It has no route that reads a tenant's bots, positions, prompts or keys. This is tested by an automated check that fails the build if an admin route touches tenant tables.
- Be honest in the UI and terms: in a hosted model the server must decrypt keys to call providers, so the guarantee is "no admin tooling and no routine access, audited", not "mathematically impossible". A self-run runner is the only absolute guarantee and is a later option.
- Skill authors never see who uses their skill beyond aggregate counts and revenue.

## 5. Bots, themes and avatars

- A bot belongs to a **theme category**; the user picks an avatar from that category. Launch categories: Bunnies (today), Cats, Dogs, Zombies, Robots, Gods, Heroes, Memes. Packs can be added without code changes (data-driven: `theme`, `avatar`, palette).
- Avatars must be original or properly licensed. Names like "Heroes" and "Memes" invite trademark and copyright problems (existing characters, celebrity likeness). Policy: generated or commissioned art only, generic archetypes (a knight, a masked vigilante), no real people or known IP. AI generation passes image moderation; uploads are off at first.
- Theme packs are a clean monetisation and retention lever (seasonal packs, Pro-only packs).

## 5b. Badges

Badges reward behaviour, not luck alone, and unlock things:
- Progress: first bot, first profitable week, 30-day streak, first published skill.
- Quality: low drawdown season, verified skill, top 10% of a league.
- Community: a skill installed by N users, helpful reports.
- Some badges unlock slots (extra bot, advanced skill class) so the progression feels earned; subscription still gates the paid features.

## 6. Ranking

- **Seasons** with identical starting capital, identical data and identical fee/slippage model for everyone.
- **Leagues** by style (scalper, swing, macro) and by tier (Free and Pro do not compete together).
- Metric: return plus risk-adjusted score (Sharpe, max drawdown) with a minimum number of trades and days before a bot is ranked.
- Anti-gaming: cap on bots per account, a rules change creates a new version with its own stats, open positions shown with a delay.

## 7. Skill marketplace

- Free skills first; paid skills require Pro (seller plan).
- Versions are immutable. Buyers opt in to updates.
- Skills are sandboxed, declare permissions, cannot read provider keys, and only *suggest* to the brain; the owner's engine and risk limits still execute.
- Verification badge requires the existing real-data backtest plus a paper-trading period.
- Refund window, report button, and a platform kill switch per skill version.
- Buyer and seller are blind to each other's bots.
- Payments through Stripe Connect (or a local equivalent). Seller KYC, tax and payouts are handled by the processor; we keep a commission.

## 8. Affiliates

### Design principle
Affiliate income must come from **real product sales to real customers**, never from recruiting or from users paying to join a tier of earners. That is what keeps it legal and sustainable.

### What the owner asked for and what I recommend
The request was a multi-level marketing plan. I recommend **not** building a multi-level plan:
- Multi-level compensation is regulated and in many jurisdictions (including Brazil, where "economia popular" law and consumer code apply, and the US) it can be treated as a pyramid scheme when pay depends on recruitment rather than product sales. The risk lands on the platform and on its users.
- A single-level program gives almost the same growth with far less legal exposure.

Recommended:
- **Single level**: a user shares a link; when the referred person buys a subscription or a skill, the referrer earns a commission on that payment.
- **Optional second level** only after legal review, and only as a small commission on the same real sales, never on sign-ups.
- Commission paid on cleared payments, with a holding period for refunds, for a limited time per referred customer (for example 12 months), with a minimum payout.
- No fee to join, no earnings claims, required disclosure that links are affiliate links, and a ban on misleading marketing ("guaranteed profit").
- Fraud controls: self-referral detection, duplicate accounts, chargeback clawback, rate limits, manual review for large payouts.
- Dashboard for affiliates: clicks, sign-ups, conversions, pending and paid commissions, payout history.

Final scope of this section is pending the owner's answer and a lawyer's review.

## 9. Data model (first cut)

`users`, `tenants`, `subscriptions`, `plans`, `quotas`, `provider_keys` (encrypted), `bots` (tenant, theme, avatar, config version), `bot_versions`, `skills`, `skill_versions`, `skill_installs`, `purchases`, `payouts`, `seasons`, `season_entries`, `badges`, `user_badges`, `themes`, `avatars`, `affiliate_links`, `referrals`, `commissions`, `reports`, `audit_log`.

## 10. Phases and acceptance

1. **Arena Free (paper).** Accounts, tenant isolation with tests, one bot, simple skills, season ranking, admin with no tenant access. Accept: a second account cannot read the first one's data through any route; admin build check passes.
2. **Pro.** Subscriptions, multiple bots, advanced skills, provider keys vault, quotas. Accept: quotas enforced; keys never appear in any response or log.
3. **Free skill marketplace.** Publish, install, verify, report, kill switch. Accept: an installed skill cannot read keys or other tenants.
4. **Paid marketplace.** Seller onboarding, payments, refunds, commission. Accept: end-to-end purchase and payout in the processor's test mode.
5. **Themes and badges.** Packs, avatar picker, badge engine, unlocks.
6. **Affiliates** (single level). Links, attribution, commission ledger, payouts, fraud checks.
7. **Live trading**, only after legal review and a custody decision (hosted with KMS or user-run runner).

## 10b. Build status

- **Phase 1, slice 1 (accounts): built.** `src/arena/` runs as its own process (`pnpm arena`, default port 8090), separate from the engine and the admin panel. Magic-link sign-in (one-time token valid 15 minutes, hashed at rest), sessions (30 days sliding, hashed, HttpOnly SameSite=Lax cookie), one SQLite file per user reachable only through the store, account deletion, per-address and per-network rate limits, and an identical answer for known and unknown addresses. E-mail goes out through Resend when `ARENA_MAIL_API_KEY` and `ARENA_MAIL_FROM` are set; otherwise links print to stderr (development only). The Resend call is written to their documented API but has not been exercised against the real service.
- **Phase 1, slice 2 (pages): built.** `#/arena` in the dashboard: e-mail form, "check your inbox" with a resend countdown, the page the e-mailed link opens (the token is removed from the address bar once spent), the account page (sign out, delete account with the e-mail typed back). The Vite dev server proxies `/arena` to `ARENA_URL` (default http://127.0.0.1:8090); in production the reverse proxy must send `/arena/*` to the Arena service.
- **Phase 1, slice 3 (bots): built.** Themes and avatars are data (`src/arena/themes.ts`: Bunnies, Cats, Dogs, Robots free; Zombies, Gods, Heroes, Memes Pro; generic archetypes only, art is glyph + colour until painted portraits exist). A member's bots live in their own database (`src/arena/bots.ts`). Free: 1 bot, Trend and Breakout styles, up to 3 coins, free packs. Pro: up to 10 bots, every style, up to 8 coins, every pack. A new style, coin set or rules text creates a new version; name, theme and avatar change in place. The plan comes from the account row and no route can change it. These bots are stored and editable but are not run yet.
- **Phase 1, slice 4a (like the admin, plus free AI for the first bunny): built.** A member's bot now has the same fields the admin panel gives a bunny: name, tagline, rules, coins, style and a `look` for its portrait; a style that cannot trade the chosen coins is refused with the reason (Trend: BTC, ETH; Breakout: BTC, ETH, SOL, HYPE). For the member's **first bunny only**, the platform pays for the AI: a sentence becomes a full draft (`designBee`, the same designer the admin uses; the member reviews it and presses Create) and the portrait is painted with the platform's image model (`paintBee`, stored privately per member and served only to its owner). It is bounded three ways: 3 designs and 2 portraits per member for life, only while the member has never had a bunny (design) or only for that first bunny (portrait), and a platform-wide daily budget (`ARENA_AI_DAILY_LIMIT`, default 100). A provider failure does not spend the member's try. The platform's key is its own (`ARENA_OPENAI_KEY`), never the owner's. Fake services were used in tests; the real OpenAI calls were not exercised.
- **Phase 1, slice 4b (the race track): built.** `src/arena/runner.ts` runs every member's bunnies on paper with the same Engine the Warren uses: one engine per bot, each with its own SQLite file and a single slot, all reading one shared market feed (`feed.ts`, which coalesces refreshes so a hundred engines make one exchange call) and deciding with the platform's default chat model through `decider.ts`, an adapter that answers Jev's question (pick one move from the menu, rate the signal) with a strict JSON schema, so the engine's guard rails are unchanged: an off-menu answer or a failure means hold, and a per-bot daily USD cap stops spending. The executor is the simulator and the mode is always dry: nothing here can place a real order. A new version of a bot starts a fresh paper account (new file); a cosmetic edit keeps it; deleting a bot or the account stops its engine and removes its files. Off by default: `ARENA_RUN=1` plus `ARENA_OPENAI_KEY`. Knobs: `ARENA_MAX_RUNNERS` (25), `ARENA_TICK_MS` (60000), `ARENA_START_USD` (1000), `ARENA_BOT_DAILY_USD` (0.50), `ARENA_LLM_MODEL`, `ARENA_LLM_USD_PER_MTOK` (0.3, an estimate). Bot rules are limited to 500 characters, as in the admin panel. Each bot card shows its paper account, position, last call and budget, refreshed every 15 seconds. Tested with a fake market and a fake model; the real exchange feed, the real model and load with many engines were not exercised.
- Next slice: season ranking (capital and rules equal for everyone, risk-adjusted score, leagues by style and tier).

## 11. Risks

- Regulatory: ranking, showing trades and any money-mode; affiliate structure; marketplace payments and tax.
- Abuse: prompt injection in third-party skills, SSRF through custom provider or MCP URLs, image generation misuse.
- Cost: LLM and compute per bot; shared exchange and data-provider rate limits.
- Trust: a marketplace lives or dies on verification and honest performance display.

## 12. Open questions

1. Affiliate: single level (recommended) or a second level after legal review?
2. Who pays for LLM calls on Pro: user keys only, or optional platform credits?
3. Seller payouts: which processor and which countries at launch?
4. Hosted only at first, or also a self-run runner?
