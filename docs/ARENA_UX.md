# Arena UX review

Status: review and design, 30 Sep 2026. Nothing drawn here is built. The visual version, with every mockup, is `docs/arena-screen-map.html` (open it in a browser; it is also published as an artifact).

## 1. What was checked

Every function in `docs/ARENA_PLAN.md` and in the later conversations was listed and matched to a screen: 48 functions (updated after step 1 was built).

| Status | Count | Meaning |
|---|---|---|
| Built | 6 | Works as it is: e-mail sign-in, theme and avatar picker, and, since step 1, the Arena's own frame, the landing page, the consent screen and six languages |
| Built, needs redesign | 8 | Exists, but the screen is wrong for what it has to do |
| Drawn | 32 | A mockup shows it, with its rules |
| Not in v1 | 2 | Decided: follow and comments; live trading opt-in |

The full table, with the screen number of each function, is in the HTML file.

## 2. The live screens, measured

Measured on a 390 px phone against the running Arena, not guessed.

| Severity | Finding | Evidence | Fix |
|---|---|---|---|
| High | The Arena sits inside the owner's navigation | Nav at 390 px: Live, Bunnies, Lab & warren memory, Arena (x 430 to 476), Admin. The "Arena" link is off screen | Own shell and bottom tab bar (S1) |
| High | Locked options lead nowhere | "Pro" labels are not tappable, no plan page exists | Paywall sheet and plans page (S10) |
| High | New members land on an empty card | The free AI design is one tap deeper, inside the form | Landing, consent, three-step first run (S2, S3) |
| High | No consent or legal entry points | Only a "paper trading only" line | Consent after the first link, so sign-in still cannot reveal who has an account (S2). Text needs a lawyer |
| Medium | Creating a bot is one long page | 1,927 px tall at 390 px wide, about 2.4 screens | Five steps with a live preview; greyed options with the reason (S5) |
| Medium | A bot card is a dead end | No detail, no versions screen (API exists), rules clip | Bot page: performance, decisions, versions, settings (S6) |
| Medium | One product, four names, wrong nouns | "Create a bunny" for Cats and Robots; bunny, bot, Warren, race track, Arena, beebots | One vocabulary (see decisions) |
| Medium | Leaderboard rows go nowhere | Not tappable, unlabeled league counts, no search, own row can be far down | Tappable rows, pinned "You", league picker, search, archive (S7, S8) |
| Medium | Touch targets | Primary 41 px, chips 37, tabs 37, Edit and Delete 30 px side by side (WCAG 2.2 minimum is 24, so they pass it; 44 is the usual phone guideline) | 44 px minimum |
| Medium | English only | No language setting | Decide language first |
| Medium | "Why did it do that?" has no honest answer | The decision model returns a choice and odds, not a sentence | Show inputs, odds and any risk rule that changed the result; never invent reasoning (S6) |
| Low | Plain loading, empty and error states | "Loading…" and "not reachable" with no retry | Skeletons, designed empties and errors (S17) |
| Low | Emoji avatars differ by device | | Painted packs replace them; layouts already leave room |
| Low | Dense status copy | "LONG BTC $622.00, -$0.03 open. 3 decisions…" | Pill, three figures, one line |
| Passes | Contrast and overflow | Body text 10.4:1, muted 5.3:1, status colours 4.7 to 9.0:1; no horizontal scroll at 390 px | Keep |

## 3. Navigation model

One Arena shell with four destinations and one action: Home, Board, **New bot** (centre), Market, Me. Me holds account and security, plan and billing, keys and usage, badges, notifications, affiliates and help. Public pages (landing, leaderboard, public profiles, marketplace browse) work signed out. The owner's Warren and admin stay in their own app. The platform console is a third, separate app that cannot open member data.

## 4. Rules the designs follow

- Same look as the product: dark violet-black ground, amber accent, Inter and JetBrains Mono, status always paired with a glyph or word.
- Mobile first, 44 px minimum targets, one thing per step in flows.
- A locked option is shown greyed with the reason and one tap to the paywall sheet; it never blocks a flow that can continue without it.
- Privacy wording is literal: what others see is listed on the same screen where the member chooses it.
- No invented reasoning: decision history shows what the bot saw, the odds it gave, and any risk rule that applied.
- Destructive actions name what goes; bot deletion asks for the bot's name, account deletion for the e-mail.
- Sample data in mockups is marked as sample.

## 5. Suggested build order

Each step is a normal slice with tests, and each can ship on its own.

1. **Shell, landing and consent.** Needs: a consent record per account, legal text (lawyer).
2. **Home, bot page, create flow.** Needs: bot version endpoint screen (API exists), pause and stop (new), templates content.
3. **Leaderboard v2 and public profiles.** Needs: public profile endpoints, `share rules` flag per bot, permanent final standings for the archive.
4. **Account, sessions, data export, notifications.** Needs: sessions list endpoint, a data export job, a notification store and e-mail sending for events.
5. **Plans, paywall and billing.** Blocked on price, processor and countries.
6. **Keys and usage.** Needs the key vault (encrypted per member, write-only) and quota reporting.
7. **Marketplace, studio, seller.** Needs the skill sandbox, verification pipeline, payment provider.
8. **Affiliates, badges, season recap.** Needs the attribution ledger and the badge engine.
9. **Platform console.** Needs the build check that fails when a console route touches member data.

## 6. Decisions (resolved 30 Sep 2026)

| # | Decision |
|---|---|
| 1 | English is the base, plus five languages (pt-BR, es, fr, de, it). Always English by default; no browser detection. |
| 2 | "Agent" is the noun in the chrome (autonomous, with a brain connected to one or more LLMs). The theme is a look, not the noun. |
| 3 | Pause keeps positions under their stops; Stop closes them. |
| 4 | Downgrade: extra agents go into 10-day quarantine, then are deleted (to confirm). |
| 5 | Reviews and star ratings: dropped. |
| 6 | Follow and comments: not in v1. |
| 7 | Templates: three, written by us, labelled as examples. Still to write. |
| 8 | Legal texts stay drafts until counsel signs them off; the operator is in Ireland (see `ARENA_LEGAL_OUTLINE.md`). |
| 9 | Payments on the operator's own Stripe account; launch from Ireland into the EU. Price still open. |

Step 1 of the build order (shell, landing, consent) is built; see the plan's build status.

## 7. Decisions that were needed (kept for the record)

1. **Language.** Recommended: Portuguese (Brasil) first, English second, settled before copy is final.
2. **Nouns.** Recommended: "bot" in the chrome, the theme's noun on the card ("Cat · Trend"), "Arena" for the place.
3. **Pause versus Stop.** Recommended: Pause keeps positions under their stops; Stop closes them.
4. **Downgrade.** Recommended: extra bots are paused, never deleted, and kept 30 days.
5. **Reviews and star ratings.** Recommended: skip at launch (drawn, but not in the plan).
6. **Follow and comments.** Recommended: not in v1; they add moderation work.
7. **Templates.** Recommended: three, written by us, labelled as examples.
8. **Legal text and contact.** A lawyer writes terms, privacy, age line, affiliate rules, risk notice.
9. **Still open from the plan.** Price and processor, countries, who pays model costs on Pro, hosted only or also self-run.
