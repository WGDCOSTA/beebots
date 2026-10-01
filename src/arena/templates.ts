// Three starter agents a member can begin from. They are examples to edit, not recommendations: the page says so, and nothing
// here is a promise about how they will do. Each one is a complete draft that passes the same checks as any agent.
import type { BotInput } from "./bots.js";

export interface Template extends BotInput {
  id: string;
  name: string;
  theme: string;
  avatar: string;
  style: string;
  coins: string[];
  rules: string;
  tagline: string;
  look: string;
  /** What kind of agent it is, in a few words, for the card. */
  kind: "steady" | "breakout" | "momentum";
  /** Needs a Pro plan (its style is a Pro style). */
  pro: boolean;
}

export const TEMPLATES: readonly Template[] = [
  {
    id: "steady-trend",
    kind: "steady",
    pro: false,
    name: "Steady Trend",
    theme: "bunnies",
    avatar: "scout",
    style: "breezy",
    coins: ["BTC", "ETH"],
    rules: "Trade only with the BTC and ETH trend. Few trades, calm entries, cut a loser fast and let a winner run. When the trend is unclear, stay out.",
    tagline: "the calm trend follower",
    look: "a calm bunny in a scarf, watching a slow line chart",
  },
  {
    id: "daily-breakout",
    kind: "breakout",
    pro: false,
    name: "Daily Breakout",
    theme: "bunnies",
    avatar: "scout",
    style: "bizzy",
    coins: ["BTC", "ETH", "SOL"],
    rules: "Wait for one clear volatility breakout a day. Take it only when the move is strong, ride it, and do not chase after it has run. No second tries on the same day.",
    tagline: "the one-shot hunter",
    look: "an alert bunny crouched at a starting line",
  },
  {
    id: "fast-momentum",
    kind: "momentum",
    pro: true,
    name: "Fast Momentum",
    theme: "bunnies",
    avatar: "scout",
    style: "boozy",
    coins: ["BTC", "ETH", "SOL", "HYPE", "XRP"],
    rules: "Chase the strongest fast mover among my coins. Keep positions short, take profit quickly, and step aside when everything is moving the same way or the market is thin.",
    tagline: "the busy sprinter",
    look: "a bunny in running shoes mid-sprint",
  },
];
