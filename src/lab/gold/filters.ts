// Eligibility filters: spread, sessions, news blackouts, the weekend. Pure functions of the config and the clock.
import { inWindow, localParts, minutesUntil, hhmm } from "./time.js";
import type { EngineConfig, NewsEvent, StrategyProfile } from "./types.js";

export function spreadOk(cfg: EngineConfig["filters"]["spread"], spread: number, atr: number | null): { ok: boolean; reason?: string } {
  if (!cfg.enabled) return { ok: true };
  if (spread > cfg.max_allowed) return { ok: false, reason: `spread ${spread.toFixed(2)} > ${cfg.max_allowed}` };
  if (cfg.max_atr_ratio !== undefined && atr !== null && atr > 0 && spread / atr > cfg.max_atr_ratio) return { ok: false, reason: `spread/ATR ${(spread / atr).toFixed(3)} > ${cfg.max_atr_ratio}` };
  return { ok: true };
}

/** May a new breakout be armed at `ts`? With sessions off, always. Per-strategy flags override the engine's. */
export function sessionOk(cfg: EngineConfig["filters"]["sessions"], profile: Pick<StrategyProfile, "session_filter">, ts: number): boolean {
  if (!cfg.enabled) return true;
  const flags = { london: cfg.london, new_york: cfg.new_york, asia: cfg.asia, ...(profile.session_filter ?? {}) } as Record<string, boolean | undefined>;
  for (const [name, w] of Object.entries(cfg.windows)) if (flags[name] && inWindow(ts, w.tz, w.start, w.end)) return true;
  return false;
}

/** Sorted news lookups (binary search) so a multi-year run does not scan the calendar on every bar. */
export class NewsCalendar {
  private events: NewsEvent[];
  constructor(
    events: NewsEvent[],
    private beforeMs: number,
    private afterMs: number,
  ) {
    this.events = [...events].sort((a, b) => a.time - b.time);
  }

  /** The event whose blackout [time - before, time + after] contains `ts`, if any. */
  at(ts: number): NewsEvent | null {
    let lo = 0;
    let hi = this.events.length - 1;
    let first = this.events.length;
    // first event with time >= ts - after
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.events[mid]!.time >= ts - this.afterMs) {
        first = mid;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    const e = this.events[first];
    return e && e.time - this.beforeMs <= ts ? e : null;
  }
}

export interface WeekendState {
  /** Friday after the cut-off through Sunday: no new entries. */
  blockEntries: boolean;
  /** Within `minutes_before_close` of the weekly close. */
  nearClose: boolean;
}

export function weekendState(cfg: EngineConfig["filters"]["weekend"], tz: string, ts: number): WeekendState {
  if (!cfg.enabled) return { blockEntries: false, nearClose: false };
  const p = localParts(ts, tz);
  const cut = cfg.block_new_entries_after;
  const blockEntries = p.dow === 6 || p.dow === 0 || (p.dow === cut.day && p.minutes >= hhmm(cut.time)) || (cut.day < 5 && p.dow > cut.day && p.dow < 6);
  const nearClose = minutesUntil(ts, tz, cfg.market_close.day, cfg.market_close.time) <= cfg.minutes_before_close;
  return { blockEntries, nearClose };
}
