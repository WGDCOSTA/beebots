// Pure helpers for the decision stream: readable labels, grouping of repeats, relative time. No React, so the root suite tests it.

/** The slice of a decision event the stream reads (structural, so this file has no imports). */
export interface StreamDecision {
  ts: number;
  bee: string;
  choice: string | null;
  action: string;
  vetoedBy: string | null;
  forcedBy: string | null;
  jev: string;
  pulse?: boolean;
  watch?: string;
  required?: boolean;
  live?: { side: "long" | "short" | null };
}

/** Plain names for Jev's menu labels. Anything else is tidied: "FT_BB_RSI_LONG_ENTRY" reads "BB RSI long entry". */
const KNOWN: Record<string, string> = {
  WAIT: "Wait",
  HOLD: "Hold",
  HOLD_WINNER: "Hold the winner",
  CLOSE: "Close the position",
  CLOSE_ALL: "Close everything",
  TAKE_PROFIT: "Take profit",
  CUT_LOSS: "Cut the loss",
  WATCHING: "Watching",
};

export function humanLabel(raw: string | null, jev?: string): string {
  if (raw === null || raw === "") return jev === "unreachable" ? "Jev unreachable" : jev === "daily_cap" ? "Jev's daily cap reached" : "No call";
  const known = KNOWN[raw];
  if (known) return known;
  const t = raw
    .replace(/^FT_/, "")
    .replace(/_+/g, " ")
    .trim()
    .toLowerCase();
  const words = t.split(" ").map((w) => (w.length <= 3 && /^[a-z]+$/.test(w) && !["long", "buy", "the", "and", "or", "add", "sell"].includes(w) ? w.toUpperCase() : w));
  const s = words.join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "now", "12s", "4m", "3h". */
export function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

export interface Item<T extends StreamDecision = StreamDecision> {
  d: T;
  /** How many times in a row this bunny made the same call (this row is the newest). */
  n: number;
  /** When the run started (the oldest of the group). */
  since: number;
}

const keyOf = (d: StreamDecision) => [d.bee, d.choice, d.watch ?? "", d.action, d.vetoedBy ?? "", d.forcedBy ?? "", d.required ? 1 : 0, d.pulse ? 1 : 0, d.live?.side ?? "", d.jev].join("|");

/**
 * Newest first in, newest first out. A bunny that makes the same call again (same choice, same reason, same outcome)
 * does not get a new row: its last row counts the repeat. Different bunnies interleave freely, so a repeat is judged
 * against that bunny's previous row, not the one above it.
 */
export function groupDecisions<T extends StreamDecision>(decisions: readonly T[], limit = 60): Array<Item<T>> {
  const out: Array<Item<T>> = [];
  const lastKept = new Map<string, Item<T>>();
  // Walk oldest -> newest so a run is folded into its newest row.
  for (let i = decisions.length - 1; i >= 0; i--) {
    const d = decisions[i]!;
    const prev = lastKept.get(d.bee);
    if (prev && keyOf(prev.d) === keyOf(d)) {
      prev.d = d;
      prev.n++;
      continue;
    }
    const it: Item<T> = { d, n: 1, since: d.ts };
    lastKept.set(d.bee, it);
    out.push(it);
  }
  return out.reverse().slice(0, limit);
}
