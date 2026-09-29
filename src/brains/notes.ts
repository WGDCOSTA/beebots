// Research notes and background: what a bee has been studying, kept apart from lessons (which come from its own trades).
// Two kinds:
//   background  the owner's own words about what a bee is for or should keep in mind. Approved on the spot.
//   research    a bee's brain drafted it from the evidence the app already holds (src/brains/research.ts). It waits as
//               "pending" and only reaches a brain's context after the owner approves it.
// An approved note is mirrored into the hive mind as a memory node (bee -researched-> note, note -about-> coin), which the
// graph marks INFERRED: a note is a hypothesis with sources, never a measured fact. Brains see it in their context under
// `background`, framed as context and hypotheses, not orders. Nothing here trades.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { KnowledgeGraph } from "../graph/graph.js";
import { beeNode } from "../graph/hive-mind.js";

export type NoteKind = "background" | "research";
export type NoteStatus = "pending" | "approved" | "rejected";
export type Confidence = "low" | "medium" | "high";

export interface Note {
  id: string;
  /** A bee slot ("bee1"), or "hive" for every bee. */
  bee: string;
  kind: NoteKind;
  /** "owner", or the slot of the bee whose brain drafted it. */
  author: string;
  brain: string | null;
  title: string;
  text: string;
  evidence: string[];
  coins: string[];
  confidence: Confidence;
  status: NoteStatus;
  createdAt: number;
  decidedAt: number | null;
}

export const LIMITS = { title: 80, text: 700, evidence: 5, evidenceLen: 220, coins: 6, perBeeApproved: 30, total: 300 };

export class NoteError extends Error {}

const clean = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);
const coinOf = (c: string) => c.trim().toUpperCase().replace(/-.*$/, "").replace(/[^A-Z0-9]/g, "").slice(0, 12);

export interface NoteInput {
  bee: string;
  kind: NoteKind;
  author: string;
  brain?: string | null;
  title: string;
  text: string;
  evidence?: string[];
  coins?: string[];
  confidence?: Confidence;
}

export class NoteBook {
  private notes: Note[] = [];

  constructor(
    private path: string,
    private graph: KnowledgeGraph | null = null,
    private now: () => number = Date.now,
  ) {
    try {
      if (existsSync(path)) this.notes = (JSON.parse(readFileSync(path, "utf8")) as { notes: Note[] }).notes ?? [];
    } catch {
      this.notes = [];
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.tmp`, JSON.stringify({ version: 1, notes: this.notes }));
    renameSync(`${this.path}.tmp`, this.path);
  }

  all(): Note[] {
    return [...this.notes].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): Note | undefined {
    return this.notes.find((n) => n.id === id);
  }

  /** Approved notes a brain of this bee may read: its own and the hive's, the owner's background first. */
  approvedFor(bee: string, limit = 6): Note[] {
    return this.notes
      .filter((n) => n.status === "approved" && (n.bee === bee || n.bee === "hive"))
      .sort((a, b) => Number(b.kind === "background") - Number(a.kind === "background") || (b.decidedAt ?? b.createdAt) - (a.decidedAt ?? a.createdAt))
      .slice(0, limit);
  }

  pendingCount(bee?: string): number {
    return this.notes.filter((n) => n.status === "pending" && (!bee || n.bee === bee)).length;
  }

  add(i: NoteInput): Note {
    const title = clean(i.title, LIMITS.title);
    const text = clean(i.text, LIMITS.text);
    if (!title || text.length < 10) throw new NoteError("a note needs a title and at least a sentence");
    if (this.notes.length >= LIMITS.total) throw new NoteError(`the notebook is full (${LIMITS.total} notes): archive some first`);
    const owner = i.author === "owner";
    // A brain's note is a claim to weigh: it can never be written as already approved, whatever it says.
    const status: NoteStatus = i.kind === "background" && owner ? "approved" : "pending";
    const at = this.now();
    const n: Note = {
      id: randomBytes(5).toString("hex"),
      bee: i.bee,
      kind: i.kind === "background" && !owner ? "research" : i.kind,
      author: i.author,
      brain: i.brain ?? null,
      title,
      text,
      evidence: (i.evidence ?? []).map((e) => clean(e, LIMITS.evidenceLen)).filter(Boolean).slice(0, LIMITS.evidence),
      coins: [...new Set((i.coins ?? []).map(coinOf).filter(Boolean))].slice(0, LIMITS.coins),
      confidence: i.confidence ?? "low",
      status,
      createdAt: at,
      decidedAt: status === "approved" ? at : null,
    };
    if (status === "approved") this.checkRoom(n.bee);
    this.notes.push(n);
    this.save();
    this.mirror(n);
    return n;
  }

  private checkRoom(bee: string): void {
    const have = this.notes.filter((n) => n.status === "approved" && n.bee === bee).length;
    if (have >= LIMITS.perBeeApproved) throw new NoteError(`${bee} already has ${LIMITS.perBeeApproved} approved notes: archive some first`);
  }

  /** The owner's decision on a pending note. */
  decide(id: string, decision: "approve" | "reject"): Note {
    const n = this.get(id);
    if (!n) throw new NoteError("no such note");
    if (decision === "approve") {
      if (n.status !== "approved") this.checkRoom(n.bee);
      n.status = "approved";
    } else n.status = "rejected";
    n.decidedAt = this.now();
    this.save();
    this.mirror(n);
    return n;
  }

  remove(id: string): void {
    const n = this.get(id);
    if (!n) throw new NoteError("no such note");
    this.notes = this.notes.filter((x) => x.id !== id);
    this.save();
    this.graph?.remove(this.nodeOf(n));
  }

  private nodeOf(n: Note): string {
    return `memory:note-${n.id}`;
  }

  /** Approved notes live in the hive mind; anything else is taken out of it. */
  private mirror(n: Note): void {
    const g = this.graph;
    if (!g) return;
    const id = this.nodeOf(n);
    if (n.status !== "approved") return g.remove(id);
    g.upsert("memory", `note-${n.id}`, `note: ${n.title}`, { text: n.text, kind: n.kind === "background" ? "background" : "research note", confidence: n.confidence, evidence: n.evidence, coins: n.coins, author: n.author, noteId: n.id });
    const w = n.confidence === "high" ? 1 : n.confidence === "medium" ? 0.7 : 0.4;
    if (n.bee === "hive") for (const b of g.nodes("bee", 20)) g.link(b.id, "researched", id, w, { noteId: n.id });
    else g.link(beeNode(n.bee), "researched", id, w, { noteId: n.id });
    for (const c of n.coins) g.link(id, "about", g.upsert("coin", c, c), 1);
  }
}
