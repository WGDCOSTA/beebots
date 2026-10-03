// Visitor counter for the public page. Privacy by construction:
// an IP is only ever hashed with a random salt that lives in memory for one UTC day, then is discarded,
// so nothing stored (or logged) can be linked back to a person or across days. Only the total persists, and, for the
// visitors' map, a count per time zone the page reports (its own clock's zone, such as "Europe/Lisbon": never a location
// looked up from the address).
import { createHash, randomBytes } from "node:crypto";
import type { Db } from "./db.js";

const MAX_SEEN = 200_000;
/** Distinct zones kept for the map; the IANA database has about 600 names, aliases included. */
const MAX_PLACES = 700;

/** A real IANA time zone name, or null. */
export function cleanTz(tz: unknown): string | null {
  if (typeof tz !== "string" || tz.length > 40 || !/^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2}$/.test(tz)) return null;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

export class Visitors {
  private day = "";
  private salt = Buffer.alloc(0);
  private seen = new Set<string>();
  total: number;
  /** Visits per time zone, since the map began. */
  private places: Record<string, number>;

  constructor(
    private db: Db,
    private now: () => number = Date.now,
  ) {
    this.total = Number(db.getMeta("visitors_total") ?? 0);
    try {
      this.places = JSON.parse(db.getMeta("visitors_places") ?? "{}") as Record<string, number>;
    } catch {
      this.places = {};
    }
  }

  /** When the map started counting (the total is older). */
  get mapSince(): number {
    const s = Number(this.db.getMeta("visitors_places_since") ?? 0);
    if (s) return s;
    const t = this.now();
    this.db.setMeta("visitors_places_since", String(t));
    return t;
  }

  /** Visits per time zone, most first. */
  placeCounts(): Array<[string, number]> {
    return Object.entries(this.places).sort((a, b) => b[1] - a[1]);
  }

  /** Count one visit; the same visitor counts once per UTC day. `tz` is the page's own time zone, for the map. Returns the running total. */
  visit(clientAddr: string, tz: string | null = null): number {
    const d = new Date(this.now()).toISOString().slice(0, 10);
    if (d !== this.day) {
      this.day = d;
      this.salt = randomBytes(32);
      this.seen.clear();
    }
    const h = createHash("sha256").update(this.salt).update(clientAddr).digest("base64url").slice(0, 16);
    if (!this.seen.has(h) && this.seen.size < MAX_SEEN) {
      this.seen.add(h);
      this.total++;
      this.db.setMeta("visitors_total", String(this.total));
      const z = cleanTz(tz);
      if (z && (z in this.places || Object.keys(this.places).length < MAX_PLACES)) {
        void this.mapSince;
        this.places[z] = (this.places[z] ?? 0) + 1;
        this.db.setMeta("visitors_places", JSON.stringify(this.places));
      }
    }
    return this.total;
  }
}

/** The visitor's address as Caddy reports it (first X-Forwarded-For hop), else the socket address. Never logged. */
export function clientAddr(xff: string | string[] | undefined, socketAddr: string | undefined): string {
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
  return first || socketAddr || "unknown";
}
