// The coin book: which scalp rules each coin is tested with and may trade, and how each got there. It is how the lab
// evolves on its own. Rules enter from four sources:
//   - "lab-brain": the lab's own brain (brains/labBrain.ts) after a study of everything the brains know;
//   - "bunny:<slot>": a bunny's own brain proposing for its coins;
//   - "manual": the owner, from the admin panel;
//   - "autonomous": the book itself, from what the lab measured and what live trades did.
// Nothing here can make a rule trade. A rule only reaches the live scalper when the walk-forward lab passed it on real
// data for that coin (applyReport), and live results can take it away again (recordLive). Every change is logged.
//
// Lifecycle per coin and rule:
//   queued -> (lab) -> validated | failing -> (3 failures in a row) -> retired for 14 days -> queued again
//   validated -> (live: 12+ trades losing after costs) -> demoted for 7 days -> queued again
//   the owner can block (never tested or traded), pin (always tested), retire or requeue at any time.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJson } from "../ghostproof/canonical.js";
import { coinOfSet, DEFAULT_COSTS, registerScalpRules, SCALP_RULES, scalpRule, type ScalpGate, type ScalpReport, type ScalpRule } from "./scalp.js";
import { parseScalpSpec, scalpRuleFromSpec, type ScalpSpec } from "./scalpDsl.js";
import type { Params } from "./skills/types.js";

export type CandidateStatus = "queued" | "validated" | "failing" | "retired" | "demoted";
export type BookSource = "builtin" | "lab-brain" | "manual" | "autonomous" | `bunny:${string}`;

export interface LabTest {
  at: number;
  netBps: number;
  trades: number;
  positiveFolds: number;
  folds: number;
  plateauPct: number;
  edge: boolean;
  why: string;
  params: Params;
}

export interface LiveStats {
  trades: number;
  wins: number;
  netUsd: number;
  notionalUsd: number;
}

export interface Candidate {
  ruleId: string;
  status: CandidateStatus;
  source: BookSource;
  reason: string;
  proposedAt: number;
  updatedAt: number;
  /** Lab tests in a row without an edge. */
  fails: number;
  tests: number;
  lastTest: LabTest | null;
  live: LiveStats;
  /** Retired or demoted until then; then queued again. */
  until: number | null;
  pinned: boolean;
  blocked: boolean;
}

export interface RuleDef {
  id: string;
  name: string;
  description: string;
  /** null for the built-in rules (lab/scalp.ts). */
  spec: ScalpSpec | null;
  source: BookSource;
  createdAt: number;
}

export interface BookLog {
  at: number;
  coin: string;
  ruleId: string | null;
  event: string;
  source: BookSource | "owner" | "lab";
  text: string;
}

interface BookData {
  version: 1;
  rules: Record<string, RuleDef>;
  coins: Record<string, Candidate[]>;
  log: BookLog[];
  meta: Record<string, string | number>;
}

const DAY = 86_400_000;
export const BOOK_LIMITS = {
  failsToRetire: 3,
  retireDays: 14,
  demoteDays: 7,
  /** Live trades before live results can demote a rule the lab passed. */
  liveMinTrades: 12,
  /** Written rules tested per coin per lab run (built-ins always are, unless retired or blocked). */
  writtenPerCoin: 4,
  /** Open (not retired) candidates per coin. */
  openPerCoin: 10,
  rules: 200,
  /** A rule proposed for every coin ("*") is swept across this many coins, then left to the per-coin entries. */
  sweepCoins: 20,
  log: 400,
};
const COIN = /^[A-Z0-9]{1,20}$/;
const emptyLive = (): LiveStats => ({ trades: 0, wins: 0, netUsd: 0, notionalUsd: 0 });
const OPEN: CandidateStatus[] = ["queued", "validated", "failing"];

export class BookError extends Error {}

export class CoinBook {
  private d: BookData;
  private readonly path: string;

  constructor(
    labDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.path = join(labDir, "coin-book.json");
    this.d = { version: 1, rules: {}, coins: {}, log: [], meta: {} };
    try {
      if (existsSync(this.path)) {
        const raw = JSON.parse(readFileSync(this.path, "utf8")) as BookData;
        if (raw?.version === 1) this.d = { ...this.d, ...raw };
      }
    } catch {
      // A broken file starts a fresh book; the lab rebuilds it from the next report.
    }
    for (const b of SCALP_RULES) this.d.rules[b.id] = { id: b.id, name: b.name, description: b.description, spec: null, source: "builtin", createdAt: this.d.rules[b.id]?.createdAt ?? 0 };
    // A rule that no longer compiles (the DSL changed) is dropped, never half-loaded.
    for (const [id, r] of Object.entries(this.d.rules)) if (r.spec && !parseScalpSpec(r.spec).ok) delete this.d.rules[id];
    this.register();
  }

  // ---------- reading ----------

  /** Rules written as data, compiled (the live scalper finds them through lab/scalp.ts scalpRule). */
  written(): ScalpRule[] {
    return Object.values(this.d.rules).flatMap((r) => (r.spec ? [scalpRuleFromSpec(r.spec)] : []));
  }

  rule(id: string): RuleDef | null {
    return this.d.rules[id] ?? null;
  }

  candidates(coin: string): Candidate[] {
    return this.d.coins[coin] ?? [];
  }

  getMeta(k: string): string | number | undefined {
    return this.d.meta[k];
  }

  setMeta(k: string, v: string | number): void {
    this.d.meta[k] = v;
    this.save();
  }

  /** Brings retired and demoted entries back to the queue once their time is up. */
  refresh(at = this.now()): void {
    let changed = false;
    for (const [coin, list] of Object.entries(this.d.coins)) {
      for (const c of list) {
        if ((c.status === "retired" || c.status === "demoted") && c.until !== null && at >= c.until && coin !== "*") {
          c.status = "queued";
          c.fails = 0;
          c.until = null;
          c.live = emptyLive();
          c.updatedAt = at;
          this.note(coin, c.ruleId, "requeued", "autonomous", "its time out is over: tested again");
          changed = true;
        }
      }
    }
    if (changed) this.save();
  }

  /** Which rules to test each coin with in the next lab run. */
  testPlan(coin: string): ScalpRule[] {
    const own = this.candidates(coin);
    const out: ScalpRule[] = [];
    for (const b of SCALP_RULES) {
      const c = own.find((x) => x.ruleId === b.id);
      if (!c || (OPEN.includes(c.status) && !c.blocked)) out.push(b);
    }
    const sweep = this.candidates("*").filter((c) => OPEN.includes(c.status) && !c.blocked && !own.some((o) => o.ruleId === c.ruleId && (o.blocked || !OPEN.includes(o.status))));
    const writtenOwn = own.filter((c) => OPEN.includes(c.status) && !c.blocked && this.d.rules[c.ruleId]?.spec);
    const rank = (c: Candidate) => (c.pinned ? 0 : c.status === "queued" ? 1 : c.status === "validated" ? 2 : 3);
    const picks = [...writtenOwn.sort((a, b) => rank(a) - rank(b) || a.proposedAt - b.proposedAt), ...sweep];
    const seen = new Set(out.map((r) => r.id));
    for (const c of picks) {
      if (out.length - SCALP_RULES.length >= BOOK_LIMITS.writtenPerCoin && !c.pinned) break;
      const r = scalpRule(c.ruleId);
      if (r && !seen.has(r.id)) {
        out.push(r);
        seen.add(r.id);
      }
    }
    return out;
  }

  /** Coins the next lab run should include: something waits for a test there, or the owner pinned it. */
  priorityCoins(): string[] {
    const out: Array<{ coin: string; at: number }> = [];
    for (const [coin, list] of Object.entries(this.d.coins)) {
      if (coin === "*") continue;
      const wait = list.filter((c) => !c.blocked && (c.pinned || c.status === "queued"));
      if (wait.length) out.push({ coin, at: Math.min(...wait.map((c) => (c.pinned ? 0 : c.proposedAt))) });
    }
    return out.sort((a, b) => a.at - b.at).map((x) => x.coin);
  }

  /**
   * The live scalper's gate through the book: what the latest report passed, minus what the owner blocked or the book
   * retired or demoted, plus what the book validated on real data within `maxAgeDays` (a coin validated in an earlier
   * rotating batch keeps its rule until the evidence is stale).
   */
  gate(g: ScalpGate, at = this.now(), maxAgeDays = 14): ScalpGate {
    const allowed = (coin: string, ruleId: string) => {
      const c = this.candidates(coin).find((x) => x.ruleId === ruleId);
      return !c || (!c.blocked && OPEN.includes(c.status));
    };
    const rules = g.rules.filter((r) => allowed(r.coin, r.ruleId));
    for (const [coin, list] of Object.entries(this.d.coins)) {
      if (coin === "*") continue;
      for (const c of list) {
        const t = c.lastTest;
        if (c.blocked || c.status !== "validated" || !t?.edge || at - t.at > maxAgeDays * DAY) continue;
        if (!scalpRule(c.ruleId) || rules.some((r) => r.coin === coin && r.ruleId === c.ruleId)) continue;
        rules.push({ coin, ruleId: c.ruleId, params: t.params, netBps: t.netBps, trades: t.trades });
      }
    }
    rules.sort((a, b) => b.netBps - a.netBps);
    if (!rules.length) return { ...g, open: false, rules: [], reason: g.open ? "the coin book retired or blocked every rule the lab passed" : g.reason };
    return { ...g, open: true, rules, costs: g.costs ?? DEFAULT_COSTS, reason: `lab edge on ${[...new Set(rules.map((r) => r.coin))].join(", ")}` };
  }

  // ---------- writing ----------

  /**
   * A rule for a coin (or "*" for every coin the lab tests next): an existing rule by id, or a new one written as data.
   * Returns the rule id it was filed under. Throws BookError with a readable reason.
   */
  propose(p: { coin: string; ruleId?: string; spec?: unknown; source: BookSource; reason: string }): { ruleId: string; note: string } {
    const at = this.now();
    const coin = p.coin.trim().toUpperCase();
    if (coin !== "*" && !COIN.test(coin)) throw new BookError(`"${p.coin}" is not a coin`);
    let ruleId = p.ruleId?.trim() ?? "";
    if (p.spec !== undefined) {
      const parsed = parseScalpSpec(p.spec);
      if (!parsed.ok) throw new BookError(`the rule is not valid: ${parsed.error}`);
      ruleId = this.file(parsed.spec, p.source, at);
    }
    if (!ruleId || !this.d.rules[ruleId]) throw new BookError(`unknown rule "${ruleId || "?"}"`);
    const list = (this.d.coins[coin] ??= []);
    const have = list.find((c) => c.ruleId === ruleId);
    if (have) {
      if (have.blocked) throw new BookError(`${ruleId} is blocked by the owner on ${coin}`);
      if (OPEN.includes(have.status)) return { ruleId, note: `${ruleId} is already in ${coin}'s book (${have.status})` };
      if (p.source !== "manual" && have.until !== null && at < have.until) throw new BookError(`${ruleId} was ${have.status} on ${coin} until ${new Date(have.until).toISOString().slice(0, 10)}`);
      Object.assign(have, { status: "queued", source: p.source, reason: p.reason.slice(0, 300), fails: 0, until: null, live: emptyLive(), updatedAt: at });
      this.note(coin, ruleId, "requeued", p.source, p.reason);
      this.save();
      return { ruleId, note: `${ruleId} queued again on ${coin}` };
    }
    if (list.filter((c) => OPEN.includes(c.status)).length >= BOOK_LIMITS.openPerCoin) throw new BookError(`${coin} already has ${BOOK_LIMITS.openPerCoin} open rules`);
    list.push({ ruleId, status: "queued", source: p.source, reason: p.reason.slice(0, 300), proposedAt: at, updatedAt: at, fails: 0, tests: 0, lastTest: null, live: emptyLive(), until: null, pinned: false, blocked: false });
    this.note(coin, ruleId, "proposed", p.source, p.reason);
    this.save();
    return { ruleId, note: `${ruleId} queued for the lab on ${coin}` };
  }

  /** Files a written rule; the same rule twice is one entry, a different rule under a taken id gets a new id. */
  private file(spec: ScalpSpec, source: BookSource, at: number): string {
    const same = Object.values(this.d.rules).find((r) => r.spec && canonicalJson({ ...r.spec, id: "" }) === canonicalJson({ ...spec, id: "" }));
    if (same) return same.id;
    let id = spec.id;
    for (let n = 2; this.d.rules[id]; n++) id = `${spec.id.slice(0, 36)}_v${n}`;
    if (Object.keys(this.d.rules).length >= BOOK_LIMITS.rules) throw new BookError(`the book holds ${BOOK_LIMITS.rules} rules already: retire some first`);
    this.d.rules[id] = { id, name: spec.name, description: spec.description, spec: { ...spec, id }, source, createdAt: at };
    this.register();
    return id;
  }

  /** What the lab measured, coin by coin. Synthetic runs teach nothing and are ignored. */
  applyReport(report: ScalpReport): number {
    if (report.source !== "real") return 0;
    const at = report.createdAt;
    // The same report applied twice (a restart backfills the latest) must not count its failures twice.
    if (Number(this.d.meta.applied_report_at ?? 0) >= at) return 0;
    this.d.meta.applied_report_at = at;
    let n = 0;
    const swept = new Set<string>();
    for (const r of report.results) {
      if (r.oos.trades === 0 && r.folds.length === 0) continue; // too little history: not a test
      const coin = coinOfSet(r.dataset);
      const list = (this.d.coins[coin] ??= []);
      let c = list.find((x) => x.ruleId === r.ruleId);
      const sweep = this.candidates("*").find((x) => x.ruleId === r.ruleId);
      if (!c) {
        const def = this.d.rules[r.ruleId];
        c = { ruleId: r.ruleId, status: "queued", source: sweep?.source ?? def?.source ?? "builtin", reason: sweep ? `swept: ${sweep.reason}` : "tested by the lab", proposedAt: at, updatedAt: at, fails: 0, tests: 0, lastTest: null, live: emptyLive(), until: null, pinned: false, blocked: false };
        list.push(c);
      }
      if (sweep) swept.add(r.ruleId);
      if (c.blocked) continue;
      const params = r.folds[r.folds.length - 1]?.params ?? r.bestAll?.params ?? {};
      c.lastTest = { at, netBps: r.oos.netExpectancyBps, trades: r.oos.trades, positiveFolds: r.positiveFolds, folds: r.folds.length, plateauPct: r.plateauPct, edge: r.edge, why: r.why.slice(0, 300), params };
      c.tests++;
      c.updatedAt = at;
      const was = c.status;
      if (r.edge) {
        c.status = "validated";
        c.fails = 0;
        if (was !== "validated") this.note(coin, c.ruleId, "validated", "lab", r.why);
      } else {
        c.fails++;
        if (c.fails >= BOOK_LIMITS.failsToRetire && !c.pinned) {
          c.status = "retired";
          c.until = at + BOOK_LIMITS.retireDays * DAY;
          this.note(coin, c.ruleId, "retired", "autonomous", `${c.fails} lab runs in a row without an edge: ${r.why}`);
        } else {
          c.status = "failing";
          if (was === "validated") this.note(coin, c.ruleId, "lost its edge", "lab", r.why);
        }
      }
      n++;
    }
    for (const id of swept) {
      const s = this.candidates("*").find((x) => x.ruleId === id)!;
      s.tests++;
      if (s.tests >= BOOK_LIMITS.sweepCoins) {
        s.status = "retired";
        s.until = null;
        this.note("*", id, "sweep done", "autonomous", `tested on ${s.tests} coins; each coin keeps its own entry`);
      }
    }
    this.save();
    return n;
  }

  /**
   * A live (demo or real) scalp closed. When a rule the lab passed keeps losing after costs on enough trades, the book
   * demotes it for that coin: the lab's paper fills were too kind, and the market decides.
   */
  recordLive(r: { coin: string; ruleId: string; netUsd: number; notionalUsd: number }): void {
    const at = this.now();
    const coin = r.coin.toUpperCase();
    const list = (this.d.coins[coin] ??= []);
    let c = list.find((x) => x.ruleId === r.ruleId);
    if (!c) {
      c = { ruleId: r.ruleId, status: "validated", source: this.d.rules[r.ruleId]?.source ?? "builtin", reason: "traded live", proposedAt: at, updatedAt: at, fails: 0, tests: 0, lastTest: null, live: emptyLive(), until: null, pinned: false, blocked: false };
      list.push(c);
    }
    c.live.trades++;
    if (r.netUsd > 0) c.live.wins++;
    c.live.netUsd += r.netUsd;
    c.live.notionalUsd += Math.abs(r.notionalUsd);
    c.updatedAt = at;
    const bps = c.live.notionalUsd > 0 ? (c.live.netUsd / c.live.notionalUsd) * 1e4 : 0;
    if (c.status === "validated" && c.live.trades >= BOOK_LIMITS.liveMinTrades && bps < 0 && !c.pinned) {
      c.status = "demoted";
      c.until = at + BOOK_LIMITS.demoteDays * DAY;
      this.note(coin, c.ruleId, "demoted", "autonomous", `live: ${c.live.trades} trades, ${bps.toFixed(1)} bp/trade after costs (lab said ${c.lastTest ? c.lastTest.netBps.toFixed(1) : "?"})`);
    }
    this.save();
  }

  /** A brain retires a rule on a coin. Never one the owner pinned or filed: those are the owner's to retire. */
  retire(coin: string, ruleId: string, source: BookSource, reason: string): void {
    const k = coin.trim().toUpperCase();
    const c = this.candidates(k).find((x) => x.ruleId === ruleId);
    if (!c) throw new BookError(`${ruleId} is not in ${k}'s book`);
    if (c.pinned || c.source === "manual") throw new BookError(`${ruleId} on ${k} is the owner's: only the owner retires it`);
    if (!OPEN.includes(c.status)) throw new BookError(`${ruleId} on ${k} is already ${c.status}`);
    const at = this.now();
    Object.assign(c, { status: "retired", until: at + BOOK_LIMITS.retireDays * DAY, updatedAt: at });
    this.note(k, ruleId, "retired", source, reason);
    this.save();
  }

  /** The owner's hand on the book. */
  manual(action: "block" | "unblock" | "pin" | "unpin" | "retire" | "requeue", coin: string, ruleId: string, reason = ""): void {
    const at = this.now();
    const k = coin.trim().toUpperCase();
    if (k !== "*" && !COIN.test(k)) throw new BookError(`"${coin}" is not a coin`);
    if (!this.d.rules[ruleId]) throw new BookError(`unknown rule "${ruleId}"`);
    const list = (this.d.coins[k] ??= []);
    let c = list.find((x) => x.ruleId === ruleId);
    if (!c) {
      c = { ruleId, status: "queued", source: "manual", reason: reason || "set by the owner", proposedAt: at, updatedAt: at, fails: 0, tests: 0, lastTest: null, live: emptyLive(), until: null, pinned: false, blocked: false };
      list.push(c);
    }
    if (action === "block") c.blocked = true;
    if (action === "unblock") c.blocked = false;
    if (action === "pin") c.pinned = true;
    if (action === "unpin") c.pinned = false;
    if (action === "retire") Object.assign(c, { status: "retired", until: null, pinned: false });
    if (action === "requeue") Object.assign(c, { status: "queued", until: null, fails: 0, live: emptyLive() });
    c.updatedAt = at;
    this.note(k, ruleId, action, "owner", reason || action);
    this.save();
  }

  /** The book for a page: rule specs only when `specs` (the owner's view); the public sees names and numbers. */
  view(specs = false, at = this.now()) {
    const coins = Object.entries(this.d.coins)
      .map(([coin, list]) => ({
        coin,
        candidates: list.map((c) => ({
          ruleId: c.ruleId,
          name: this.d.rules[c.ruleId]?.name ?? c.ruleId,
          status: c.status,
          source: c.source,
          reason: c.reason,
          tests: c.tests,
          lastTest: c.lastTest ? { at: c.lastTest.at, netBps: +c.lastTest.netBps.toFixed(2), trades: c.lastTest.trades, folds: `${c.lastTest.positiveFolds}/${c.lastTest.folds}`, plateauPct: Math.round(c.lastTest.plateauPct), edge: c.lastTest.edge, why: c.lastTest.why } : null,
          live: c.live.trades ? { trades: c.live.trades, wins: c.live.wins, netUsd: +c.live.netUsd.toFixed(2), netBps: c.live.notionalUsd ? +((c.live.netUsd / c.live.notionalUsd) * 1e4).toFixed(2) : 0 } : null,
          until: c.until,
          pinned: c.pinned,
          blocked: c.blocked,
        })),
      }))
      .sort((a, b) => (a.coin === "*" ? -1 : b.coin === "*" ? 1 : b.candidates.filter((c) => c.status === "validated").length - a.candidates.filter((c) => c.status === "validated").length || a.coin.localeCompare(b.coin)));
    const count = (s: CandidateStatus) => coins.reduce((n, c) => n + c.candidates.filter((x) => x.status === s).length, 0);
    return {
      at,
      totals: { coins: coins.filter((c) => c.coin !== "*").length, rules: Object.keys(this.d.rules).length, queued: count("queued"), validated: count("validated"), failing: count("failing"), retired: count("retired"), demoted: count("demoted") },
      rules: Object.values(this.d.rules).map((r) => ({ id: r.id, name: r.name, description: r.description, source: r.source, createdAt: r.createdAt, ...(specs && r.spec ? { spec: r.spec } : {}) })),
      coins,
      log: this.d.log.slice(-60).reverse(),
    };
  }

  private note(coin: string, ruleId: string | null, event: string, source: BookLog["source"], text: string): void {
    this.d.log.push({ at: this.now(), coin, ruleId, event, source, text: text.slice(0, 300) });
    if (this.d.log.length > BOOK_LIMITS.log) this.d.log.splice(0, this.d.log.length - BOOK_LIMITS.log);
  }

  private register(): void {
    registerScalpRules(this.written());
  }

  /** Written atomically: a crash mid-write leaves the previous book. Only the engine process writes it. */
  save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.d));
    renameSync(tmp, this.path);
  }
}
