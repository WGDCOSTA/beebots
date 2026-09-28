// Timezone-aware wall-clock helpers (sessions, weekend rules, daily and weekly rollovers) without a dependency:
// Intl gives the offset of a zone at an instant; results are cached per UTC hour, so a multi-year M1 run stays fast.
const fmt = new Map<string, Intl.DateTimeFormat>();
const hourCache = new Map<string, number>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    fmt.set(tz, f);
  }
  return f;
}

/** Offset of `tz` from UTC at `ts`, in ms (Europe/London in July: +3_600_000). */
export function tzOffsetMs(tz: string, ts: number): number {
  if (tz === "Etc/UTC" || tz === "UTC") return 0;
  const key = `${tz}|${Math.floor(ts / 3_600_000)}`;
  const hit = hourCache.get(key);
  if (hit !== undefined) return hit;
  const parts = formatter(tz).formatToParts(new Date(Math.floor(ts / 3_600_000) * 3_600_000));
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  const off = asUtc - Math.floor(ts / 3_600_000) * 3_600_000;
  if (hourCache.size > 200_000) hourCache.clear();
  hourCache.set(key, off);
  return off;
}

export interface LocalParts {
  /** ms since epoch of local midnight, expressed as if the local clock were UTC (a stable day key). */
  dayStart: number;
  /** Minutes since local midnight. */
  minutes: number;
  /** 0 Sunday .. 6 Saturday. */
  dow: number;
}

export function localParts(ts: number, tz: string): LocalParts {
  const local = ts + tzOffsetMs(tz, ts);
  const dayStart = Math.floor(local / 86_400_000) * 86_400_000;
  return { dayStart, minutes: Math.floor((local - dayStart) / 60_000), dow: new Date(dayStart).getUTCDay() };
}

export const dayKey = (ts: number, tz: string) => localParts(ts, tz).dayStart;

/** Local Monday 00:00 of the week containing `ts` (a stable week key). */
export function weekKey(ts: number, tz: string): number {
  const p = localParts(ts, tz);
  const back = (p.dow + 6) % 7;
  return p.dayStart - back * 86_400_000;
}

export function hhmm(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return h! * 60 + m!;
}

/** Is `ts` inside [start, end) local time in `tz` on a weekday (Mon-Fri)? Windows that cross midnight are not supported. */
export function inWindow(ts: number, tz: string, start: string, end: string): boolean {
  const p = localParts(ts, tz);
  if (p.dow === 0 || p.dow === 6) return false;
  return p.minutes >= hhmm(start) && p.minutes < hhmm(end);
}

/** Minutes from `ts` to the next occurrence of (day-of-week, HH:MM) in `tz` (0 if it is now; up to 7 days). */
export function minutesUntil(ts: number, tz: string, day: number, time: string): number {
  const p = localParts(ts, tz);
  const d = (day - p.dow + 7) % 7;
  let m = d * 1440 + hhmm(time) - p.minutes;
  if (m < 0) m += 7 * 1440;
  return m;
}
