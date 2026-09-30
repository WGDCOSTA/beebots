import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Leaderboard, type Listing } from "../src/arena/ranking.js";
import { DAY_MS, seasonOf } from "../src/arena/score.js";
import { ArenaStore, handleProblem } from "../src/arena/store.js";

const MON = Date.UTC(2026, 8, 28); // Monday, season 2026-W40
const STEP = 600_000;

function world(nowAt = MON + 5 * DAY_MS) {
  const store = new ArenaStore(mkdtempSync(join(tmpdir(), "arena-lb-")));
  const clock = { t: nowAt };
  const lb = new Leaderboard(store.dir, () => clock.t);
  const listing = (n: string, over: Partial<Listing> = {}): Listing => ({ botId: `${n}`.padEnd(12, "0").slice(0, 12), userId: "u".padEnd(32, "0"), handle: `member-${n}`, name: `Bot ${n}`, theme: "bunnies", avatar: "scout", style: "breezy", tier: "free", version: 1, ...over });
  /** A bot that trades for `days` days with a given equity path, sampled every 10 minutes. */
  const feed = (l: Listing, days: number, equityAt: (i: number, n: number) => number, orders = 10, from = MON) => {
    const n = Math.floor((days * DAY_MS) / STEP);
    for (let i = 0; i < n; i++) lb.record(l, equityAt(i, n), Math.min(orders, i), from + i * STEP);
  };
  return { store, lb, clock, listing, feed };
}
const row = (s: ReturnType<Leaderboard["standings"]>, name: string) => s.rows.find((r) => r.name === name)!;

describe("the leaderboard", () => {
  it("ranks bots of one league by score and keeps the rest waiting with a reason", () => {
    const w = world();
    w.feed(w.listing("a"), 4, (i, n) => 1000 + (i / n) * 100); // +10%, smooth
    w.feed(w.listing("b"), 4, (i, n) => 1000 + (i / n) * 40); // +4%
    w.feed(w.listing("c"), 4, (i, n) => 1000 - (i / n) * 30); // -3%
    w.feed(w.listing("d"), 1, (i, n) => 1000 + (i / n) * 500); // great, but only a day old
    const s = w.lb.standings();
    expect(s.season).toMatchObject({ id: "2026-W40", current: true });
    expect(s.leagues).toEqual([{ id: "free:breezy", ranked: 3, waiting: 1 }]);
    expect(["a", "b", "c"].map((n) => row(s, `Bot ${n}`).rank)).toEqual([1, 2, 3]);
    expect(row(s, "Bot d")).toMatchObject({ rank: null });
    expect(row(s, "Bot d").reason).toMatch(/more days/);
    expect(row(s, "Bot a").metrics!.returnPct).toBeGreaterThan(9);
    expect(s.rows.map((r) => r.name).slice(-1)).toEqual(["Bot d"]); // unranked last
  });

  it("Free and Pro, and different styles, are separate leagues", () => {
    const w = world();
    w.feed(w.listing("a"), 4, (i, n) => 1000 + (i / n) * 100);
    w.feed(w.listing("p", { tier: "pro" }), 4, (i, n) => 1000 + (i / n) * 300);
    w.feed(w.listing("z", { style: "bizzy" }), 4, (i, n) => 1000 + (i / n) * 50);
    const s = w.lb.standings();
    expect(s.leagues.map((l) => l.id)).toEqual(["free:bizzy", "free:breezy", "pro:breezy"]);
    expect(s.rows.every((r) => r.rank === 1)).toBe(true); // each is first in its own league
  });

  it("a deep drawdown costs score even when the return is the same", () => {
    const w = world();
    w.feed(w.listing("calm"), 4, (i, n) => 1000 + (i / n) * 60);
    w.feed(w.listing("wild"), 4, (i, n) => (i < n / 2 ? 1000 + (i / (n / 2)) * 300 : 1300 - ((i - n / 2) / (n / 2)) * 240)); // ends +6% after a +30% peak
    const s = w.lb.standings();
    expect(row(s, "Bot calm").rank).toBe(1);
    expect(row(s, "Bot wild").metrics!.maxDrawdownPct).toBeGreaterThan(15);
  });

  it("only the latest version of a bot is ranked", () => {
    const w = world();
    const v1 = w.listing("a");
    w.feed(v1, 4, (i, n) => 1000 + (i / n) * 100);
    w.feed({ ...v1, version: 2 }, 4, (i, n) => 1000 - (i / n) * 50, 10, MON);
    const s = w.lb.standings();
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]).toMatchObject({ version: 2 });
    expect(s.rows[0]!.metrics!.returnPct).toBeLessThan(0);
  });

  it("a bot that leaves takes every trace with it", () => {
    const w = world();
    const a = w.listing("a");
    w.feed(a, 4, (i, n) => 1000 + i / n);
    w.lb.remove(a.botId);
    expect(w.lb.standings().rows).toEqual([]);
    expect(w.store.dir.prepare("SELECT COUNT(*) AS n FROM lb_points").get()).toEqual({ n: 0 });
  });

  it("deleting an account removes that member's bots from the board", () => {
    const w = world();
    const u = w.store.createUser("c".repeat(32), "c@example.com", 1);
    const a = w.listing("a", { userId: u.id });
    w.feed(a, 4, (i, n) => 1000 + i / n);
    expect(w.lb.listedBots(u.id)).toEqual([a.botId]);
    w.store.deleteUser(u.id, 1);
    expect(w.lb.standings().rows).toEqual([]);
  });

  it("a new public name shows at once, and only the public name is ever stored", () => {
    const w = world();
    const a = w.listing("a", { userId: "u".padEnd(32, "0") });
    w.feed(a, 4, (i, n) => 1000 + i / n);
    w.lb.rename(a.userId, "fast-ana");
    expect(w.lb.standings().rows[0]!.handle).toBe("fast-ana");
    const cols = (w.store.dir.prepare("PRAGMA table_info(lb_bots)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).not.toContain("email");
    expect(cols).not.toContain("rules");
  });

  it("keeps finished seasons for a while and drops the old ones", () => {
    const w = world(MON + 12 * DAY_MS);
    const a = w.listing("a");
    w.feed(a, 4, (i, n) => 1000 + i / n); // W40
    w.feed(a, 4, (i, n) => 1000 + i / n, 10, MON + 7 * DAY_MS); // W41
    const s = w.lb.standings("2026-W40");
    expect(s.season).toMatchObject({ id: "2026-W40", current: false, start: MON });
    expect(s.rows).toHaveLength(1);
    expect(w.lb.standings().season.id).toBe("2026-W41");
    expect(w.lb.standings().seasons).toEqual(["2026-W41", "2026-W40"]);
    w.clock.t = MON + 90 * DAY_MS;
    w.lb.prune();
    expect(w.lb.standings("2026-W40").rows).toEqual([]);
  });

  it("serves many readers from one calculation", () => {
    const w = world();
    w.feed(w.listing("a"), 4, (i, n) => 1000 + i / n);
    const first = w.lb.standings();
    expect(w.lb.standings()).toBe(first);
    w.lb.record(w.listing("a"), 1100, 10, MON + 5 * DAY_MS);
    expect(w.lb.standings()).not.toBe(first);
  });
});

describe("public names", () => {
  it("are 3 to 20 safe characters, and not official-sounding", () => {
    expect(handleProblem("fast-ana")).toBeNull();
    for (const bad of ["", "ab", "a".repeat(21), "with space", "-lead", "Ünï", "admin", "Warren", "official", 5, null]) expect(handleProblem(bad)).not.toBeNull();
  });

  it("every account gets a neutral one, unique, never the e-mail; changing it checks for clashes", () => {
    const store = new ArenaStore(mkdtempSync(join(tmpdir(), "arena-h-")));
    const a = store.createUser("a".repeat(32), "ana@example.com", 1);
    const b = store.createUser("a".repeat(31) + "b", "bob@example.com", 1);
    expect(a.handle).toMatch(/^bunny-/);
    expect(a.handle).not.toContain("ana");
    expect(b.handle).not.toBe(a.handle);
    expect(store.setHandle(a.id, "Fast-Ana")).toBeNull();
    expect(store.userById(a.id)!.handle).toBe("fast-ana");
    expect(store.setHandle(b.id, "fast-ana")).toMatch(/taken/);
    expect(store.setHandle(a.id, "fast-ana")).toBeNull(); // your own name is fine
    expect(store.setHandle(a.id, "admin")).toMatch(/reserved/);
  });

  it("old directories without public names get one on opening", () => {
    const root = mkdtempSync(join(tmpdir(), "arena-hm-"));
    const s1 = new ArenaStore(root);
    s1.createUser("d".repeat(32), "d@example.com", 1);
    s1.dir.exec("UPDATE users SET handle = NULL");
    s1.close();
    const s2 = new ArenaStore(root);
    expect(s2.userById("d".repeat(32))!.handle).toMatch(/^bunny-dddd/);
  });
});

describe("season ids match the week", () => {
  it("W40 starts on the Monday used here", () => expect(seasonOf(MON).start).toBe(MON));
});
