// What each plan costs. The amounts are what the pages show; the amounts that are charged are the prices set up in the
// operator's Stripe account (their ids come from the environment), so the two have to be kept the same by hand.
// Set on 1 Oct 2026 by the owner: Pro 9.99, Premium 15.99. The currency and the period were not stated: euro and month are assumed.
import type { Tier } from "./store.js";

export interface PlanPrice {
  /** In cents of the currency. */
  amount: number;
  currency: "eur";
  interval: "month";
}

export const PLAN_PRICES: Record<Exclude<Tier, "free">, PlanPrice> = {
  pro: { amount: 999, currency: "eur", interval: "month" },
  premium: { amount: 1599, currency: "eur", interval: "month" },
};

/** How long an agent that no longer fits the plan is kept (stopped, off the board) before it is deleted. */
export const QUARANTINE_DAYS = 10;
