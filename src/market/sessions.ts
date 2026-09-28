// Trading hours of the non-crypto X-Perps (stocks, ETFs, gold, oil), learned from the market itself.
//
// OKX does not publish when a stock or commodity X-Perp really trades, and a bee holding one into a closed session can
// be hit by a gap. So the engine watches: once a minute it samples every live stock/commodity ticker and, per hour of
// the week (UTC, Monday 00:00 = slot 0), counts how often the contract was really quoting (the ticker time moved and
// the price or the 24h volume changed) and how wide the spread was. After a week or more this is a calendar:
//   - a slot is "open" when it was active in at least OPEN_FRAC of its samples (and seen at least MIN_SAMPLES times);
//   - "closed" when it was seen enough but mostly idle;
//   - "unverified" when it was not seen enough yet.
// Macro bees may only open positions in an open slot that stays open for a while (engine.ts). Unverified = closed.
import { existsSync, readFileSync } from "node:fs";
import { writePrivateJson } from "../settings.js";
import type { Kind } from "./kinds.js";

export const WEEK_SLOTS = 168;
/** Samples an hour-of-week needs before it counts (about 20 minutes of watching across weeks). */
export const MIN_SAMPLES = 20;
/** Share of samples that must show a live market for the slot to be open. */
export const OPEN_FRAC = 0.7;
const HOUR = 3_600_000;

export interface CoinSessions {
  kind: Kind;
  /** Per hour-of-week: how many times it was sampled, and how many of those it was quoting. */
  samples: number[];
  active: number[];
  /** Per hour-of-week: sum of the spread (bp) over the active samples, for the mean. */
  spreadSum: number[];
}

export interface SessionCalendar {
  version: 1;
  startedAt: number;
  updatedAt: number;
  coins: Record<string, CoinSessions>;
}

export type SessionStatus = "open" | "closed" | "unverified";

export interface SessionInfo {
  status: SessionStatus;
  /** Open: minutes until the first slot that is not open (null = open all week). */
  closesInMin: number | null;
  /** Not open: minutes until the next open slot (null = none known). */
  opensInMin: number | null;
}

/** Hour of the week in UTC, Monday 00:00 = 0 .. Sunday 23:00 = 167. */
export function hourOfWeek(ts: number): number {
  const d = new Date(ts);
  return ((d.getUTCDay() + 6) % 7) * 24 + d.getUTCHours();
}

export function emptyCalendar(now: number): SessionCalendar {
  return { version: 1, startedAt: now, updatedAt: now, coins: {} };
}

export function loadCalendar(path: string): SessionCalendar | null {
  if (!existsSync(path)) return null;
  try {
    const c = JSON.parse(readFileSync(path, "utf8")) as SessionCalendar;
    return c?.version === 1 && c.coins ? c : null;
  } catch {
    return null;
  }
}

export function saveCalendar(path: string, c: SessionCalendar): void {
  writePrivateJson(path, c);
}

export interface TickSample {
  coin: string;
  kind: Kind;
  /** Exchange time of the ticker. */
  ts: number;
  last: number;
  vol24h: number;
  spreadBp: number;
}

/** Samples tickers into a calendar. Keep one per process; call sample() about once a minute. */
export class SessionRecorder {
  private prev = new Map<string, TickSample>();
  constructor(readonly calendar: SessionCalendar) {}

  sample(ticks: TickSample[], now: number): void {
    const h = hourOfWeek(now);
    for (const t of ticks) {
      if (t.kind !== "stock" && t.kind !== "commodity") continue;
      const p = this.prev.get(t.coin);
      this.prev.set(t.coin, t);
      if (!p) continue; // the first sighting has nothing to compare with
      const c = (this.calendar.coins[t.coin] ??= {
        kind: t.kind,
        samples: Array<number>(WEEK_SLOTS).fill(0),
        active: Array<number>(WEEK_SLOTS).fill(0),
        spreadSum: Array<number>(WEEK_SLOTS).fill(0),
      });
      // Quoting: the ticker is fresh (under 5 min old), its time moved, and the price or the volume changed.
      const fresh = now - t.ts < 5 * 60_000;
      const moved = t.ts > p.ts && (t.last !== p.last || t.vol24h !== p.vol24h);
      c.samples[h] = c.samples[h]! + 1;
      if (fresh && moved) {
        c.active[h] = c.active[h]! + 1;
        if (Number.isFinite(t.spreadBp)) c.spreadSum[h] = c.spreadSum[h]! + t.spreadBp;
      }
    }
    this.calendar.updatedAt = now;
  }
}

export function slotStatus(c: CoinSessions | undefined, slot: number): SessionStatus {
  const n = c?.samples[slot] ?? 0;
  if (!c || n < MIN_SAMPLES) return "unverified";
  return c.active[slot]! / n >= OPEN_FRAC ? "open" : "closed";
}

/** Where a coin's session stands at `now`, from the calendar. No calendar or no data = unverified. */
export function sessionInfo(cal: SessionCalendar | null, coin: string, now: number): SessionInfo {
  const c = cal?.coins[coin];
  const h = hourOfWeek(now);
  const status = slotStatus(c, h);
  const minsLeftInHour = 60 - new Date(now).getUTCMinutes();
  if (status === "open") {
    for (let k = 1; k < WEEK_SLOTS; k++) if (slotStatus(c, (h + k) % WEEK_SLOTS) !== "open") return { status, closesInMin: minsLeftInHour + (k - 1) * 60, opensInMin: null };
    return { status, closesInMin: null, opensInMin: null };
  }
  for (let k = 1; k < WEEK_SLOTS; k++) if (slotStatus(c, (h + k) % WEEK_SLOTS) === "open") return { status, closesInMin: null, opensInMin: minsLeftInHour + (k - 1) * 60 };
  return { status, closesInMin: null, opensInMin: null };
}

/** May a bee open a position on this coin now? Only in a verified open session that stays open `noOpenMin` more. */
export function mayOpen(info: SessionInfo, noOpenMin: number): boolean {
  return info.status === "open" && (info.closesInMin === null || info.closesInMin > noOpenMin);
}

/** A readable week for one coin: 7 rows (Mon..Sun) of 24 characters. # open, . closed, ? unverified. */
export function weekGrid(c: CoinSessions | undefined): string[] {
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return days.map((d, i) => {
    let row = "";
    for (let hr = 0; hr < 24; hr++) {
      const s = slotStatus(c, i * 24 + hr);
      row += s === "open" ? "#" : s === "closed" ? "." : "?";
    }
    return `${d} ${row}`;
  });
}

/** Per coin: how much of the week is verified, open hours, and the mean spread while open. */
export function calendarSummary(cal: SessionCalendar | null) {
  if (!cal) return [];
  return Object.entries(cal.coins)
    .map(([coin, c]) => {
      let verified = 0;
      let open = 0;
      let spread = 0;
      let active = 0;
      for (let s = 0; s < WEEK_SLOTS; s++) {
        const st = slotStatus(c, s);
        if (st !== "unverified") verified++;
        if (st === "open") open++;
        spread += c.spreadSum[s]!;
        active += c.active[s]!;
      }
      return {
        coin,
        kind: c.kind,
        verifiedPct: Math.round((verified / WEEK_SLOTS) * 100),
        openHoursPerWeek: open,
        meanSpreadBp: active ? Math.round((spread / active) * 100) / 100 : null,
        grid: weekGrid(c),
      };
    })
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.coin.localeCompare(b.coin));
}

/** Watching time so far, in hours (for "come back after a week"). */
export const watchedHours = (cal: SessionCalendar | null, now: number) => (cal ? Math.floor((now - cal.startedAt) / HOUR) : 0);

/** Which instrument kinds a bee's market trades. */
export function marketKinds(market: string): Kind[] {
  return market === "commodities" ? ["commodity"] : market === "stocks" ? ["stock"] : market === "macro" ? ["commodity", "stock"] : ["crypto"];
}

/** Short session line for Jev's state: "open 190m" (minutes to the close), "open" (no close known), "closed". */
export function sessionLabel(info: SessionInfo): string {
  if (info.status === "open") return info.closesInMin === null ? "open" : `open ${info.closesInMin}m`;
  return info.status;
}

export const SESSION_NOTE =
  "state.session: each coin's session (open with minutes to the close, closed, or unverified). Stocks and commodities gap when their market is shut: " +
  "new positions are only offered well before a close; near a close prefer taking profit or tightening risk over holding through it.";
