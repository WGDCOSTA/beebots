import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NoteBook, NoteError } from "../src/brains/notes.js";
import { Researcher } from "../src/brains/research.js";
import type { CouncilBee } from "../src/brains/council.js";
import type { JsonAnswer, JsonAsk, LlmClient } from "../src/brains/llm.js";
import { KnowledgeGraph, nodeId } from "../src/graph/graph.js";
import { contextFor, registerBees } from "../src/graph/hive-mind.js";
import { confidenceOf } from "../src/graph/memory.js";

const path = () => join(mkdtempSync(join(tmpdir(), "notes-")), "notes.json");
const BEES: CouncilBee[] = [
  { slot: "bee1", name: "Zippy", style: "bizzy", rules: "", coins: ["BTC"], brain: "openai", model: "x" },
  { slot: "bee2", name: "Calm", style: "breezy", rules: "", coins: ["ETH"], brain: "claude", model: "x" },
];

function setup() {
  const graph = new KnowledgeGraph(":memory:");
  registerBees(graph, BEES);
  const p = path();
  return { graph, p, book: new NoteBook(p, graph, () => 1000) };
}

describe("notebook", () => {
  it("approves the owner's background at once, and holds a brain's note until the owner decides", () => {
    const { book } = setup();
    const bg = book.add({ bee: "bee1", kind: "background", author: "owner", title: "Study gold", text: "Keep an eye on how gold reacts to real yields." });
    expect(bg).toMatchObject({ status: "approved", kind: "background" });
    // A brain cannot pass a note off as the owner's background or as approved.
    const n = book.add({ bee: "bee1", kind: "background", author: "bee1", brain: "openai", title: "Claim", text: "SOL leads BTC this week.", evidence: ["tradeRecord SOL +12 over 4 trades"] });
    expect(n).toMatchObject({ status: "pending", kind: "research", decidedAt: null });
    expect(book.approvedFor("bee1").map((x) => x.id)).toEqual([bg.id]);
    expect(book.pendingCount("bee1")).toBe(1);
    book.decide(n.id, "approve");
    expect(book.approvedFor("bee1").map((x) => x.id)).toEqual([bg.id, n.id]);
    expect(() => book.decide("nope", "approve")).toThrow(NoteError);
  });

  it("cleans and bounds what it stores", () => {
    const { book } = setup();
    const n = book.add({ bee: "bee1", kind: "research", author: "bee1", title: "  A   title \n", text: "x".repeat(2000), evidence: Array.from({ length: 9 }, (_, i) => `evidence number ${i}`), coins: ["btc-usdt-swap", "BTC", "eth!", "a", "b", "c", "d", "e", "f"] });
    expect(n.title).toBe("A title");
    expect(n.text).toHaveLength(700);
    expect(n.evidence).toHaveLength(5);
    expect(n.coins).toEqual(["BTC", "ETH", "A", "B", "C", "D"]);
    expect(() => book.add({ bee: "bee1", kind: "background", author: "owner", title: "", text: "short" })).toThrow(/title/);
  });

  it("survives a restart, and shows a bee its own and the hive's approved notes only", () => {
    const { book, p, graph } = setup();
    const a = book.add({ bee: "bee1", kind: "background", author: "owner", title: "Mine", text: "Only for the first bee to read." });
    const h = book.add({ bee: "hive", kind: "background", author: "owner", title: "Everyone", text: "Everybody should read this one." });
    book.add({ bee: "bee2", kind: "background", author: "owner", title: "Theirs", text: "Only for the second bee to read." });
    const again = new NoteBook(p, graph);
    expect(again.approvedFor("bee1").map((x) => x.id).sort()).toEqual([a.id, h.id].sort());
    expect(again.approvedFor("bee2").map((x) => x.title).sort()).toEqual(["Everyone", "Theirs"]);
  });

  it("mirrors approved notes into the hive mind as inferred memories, and takes rejected ones out", () => {
    const { book, graph } = setup();
    const n = book.add({ bee: "bee1", kind: "research", author: "bee1", brain: "openai", title: "SOL leads", text: "SOL has led BTC over the last week.", evidence: ["labRanking: momentum +9%"], coins: ["SOL"], confidence: "medium" });
    expect(graph.node(`memory:note-${n.id}`)).toBeNull();
    book.decide(n.id, "approve");
    const edge = graph.out(nodeId("bee", "bee1"), "researched")[0]!;
    expect(edge.dst).toBe(`memory:note-${n.id}`);
    expect(confidenceOf(edge)).toBe("INFERRED");
    expect(graph.out(edge.dst, "about")[0]!.dst).toBe(nodeId("coin", "SOL"));
    const ctx = contextFor(graph, "bee1").background!;
    expect(ctx.trust).toMatch(/never orders/);
    expect(ctx.notes[0]).toMatchObject({ title: "SOL leads", confidence: "medium", coins: ["SOL"] });
    expect(contextFor(graph, "bee2").background).toBeNull();
    book.decide(n.id, "reject");
    expect(graph.node(`memory:note-${n.id}`)).toBeNull();
    expect(contextFor(graph, "bee1").background).toBeNull();
    book.decide(n.id, "approve");
    book.remove(n.id);
    expect(graph.node(`memory:note-${n.id}`)).toBeNull();
    expect(book.get(n.id)).toBeUndefined();
  });

  it("puts a hive note in front of every bee", () => {
    const { book, graph } = setup();
    book.add({ bee: "hive", kind: "background", author: "owner", title: "House rule", text: "Weigh facts before inferences, always." });
    expect(contextFor(graph, "bee1").background!.notes).toHaveLength(1);
    expect(contextFor(graph, "bee2").background!.notes).toHaveLength(1);
  });

  it("caps approved notes per bee", () => {
    const { book } = setup();
    for (let i = 0; i < 30; i++) book.add({ bee: "bee1", kind: "background", author: "owner", title: `n${i}`, text: `A note of at least ten characters ${i}` });
    expect(() => book.add({ bee: "bee1", kind: "background", author: "owner", title: "one more", text: "One more than the cap allows." })).toThrow(/already has 30/);
  });
});

class Fake implements LlmClient {
  asked: JsonAsk<unknown>[] = [];
  constructor(
    readonly brain: "openai" | "claude",
    private reply: unknown,
    readonly model = "m",
  ) {}
  async json<T>(ask: JsonAsk<T>): Promise<JsonAnswer<T>> {
    this.asked.push(ask as JsonAsk<unknown>);
    return { data: ask.validate.parse(this.reply), brain: this.brain, model: this.model, inputTokens: 1, outputTokens: 1, latencyMs: 1 };
  }
}

describe("researcher", () => {
  function rig(reply: unknown, over: { max?: number; keys?: boolean } = {}) {
    const { graph, book } = setup();
    let t = 1_000_000;
    const brain = new Fake("openai", reply);
    const r = new Researcher({
      graph,
      notes: book,
      clients: over.keys === false ? {} : { openai: brain },
      bees: () => BEES,
      playbookPath: join(mkdtempSync(join(tmpdir(), "pb-")), "playbook.json"),
      ranking: () => null,
      maxCallsPerDay: over.max ?? 5,
      now: () => t,
    });
    return { r, book, brain, tick: (ms: number) => (t += ms) };
  }
  const good = { notes: [{ title: "SOL leads BTC", claim: "SOL has outrun BTC over the pack's window.", evidence: ["tradeRecord: SOL +$12 over 4 trades"], coins: ["SOL"], confidence: "low" }] };

  it("drafts notes as pending, from the evidence pack only, and never approves them", async () => {
    const { r, book, brain } = rig(good);
    const out = await r.research("bee1");
    expect(out.drafted).toBe(1);
    expect(book.all()[0]).toMatchObject({ status: "pending", kind: "research", author: "bee1", brain: "openai", bee: "bee1" });
    expect(brain.asked[0]!.system).toMatch(/ONLY from the evidence pack/);
    expect(brain.asked[0]!.system).toMatch(/never recommend an order/);
    const pack = JSON.parse(brain.asked[0]!.user);
    expect(Object.keys(pack)).toEqual(expect.arrayContaining(["bee", "labRanking", "hive", "market", "alreadyWritten"]));
    expect(book.approvedFor("bee1")).toEqual([]);
  });

  it("drops a note without evidence and a duplicate title", async () => {
    const { r, book } = rig({
      notes: [
        { title: "No evidence", claim: "A claim with nothing behind it at all.", evidence: [], coins: [], confidence: "high" },
        { title: "Short evidence", claim: "A claim with a scrap behind it here.", evidence: ["x"], coins: [], confidence: "high" },
        { title: "Kept", claim: "A claim with a number behind it here.", evidence: ["labRanking: score 0.41"], coins: [], confidence: "low" },
        { title: "kept", claim: "The same title again, in another case.", evidence: ["labRanking: score 0.41"], coins: [], confidence: "low" },
      ].slice(0, 3),
    });
    expect((await r.research("bee1")).drafted).toBe(1);
    expect(book.all().map((n) => n.title)).toEqual(["Kept"]);
  });

  it("says so when there is nothing new, and explains what blocks it", async () => {
    const empty = rig({ notes: [] });
    expect((await empty.r.research("bee1")).note).toMatch(/Nothing new/);
    expect(empty.r.blocked("bee1")).toMatch(/researched 0 min ago/);
    empty.tick(31 * 60_000);
    expect(empty.r.blocked("bee1")).toBeNull();
    expect(rig(good, { keys: false }).r.blocked("bee1")).toMatch(/no key/);
    expect(rig(good).r.blocked("bee9" as never)).toMatch(/not running/);
    const capped = rig({ notes: [] }, { max: 1 });
    await capped.r.research("bee1");
    capped.tick(31 * 60_000);
    expect(capped.r.blocked("bee1")).toMatch(/daily/);
    await expect(capped.r.research("bee1")).rejects.toThrow(/Cannot research now/);
  });

  it("stops asking when too many notes wait for review", async () => {
    const { r, book, tick } = rig(good);
    for (let i = 0; i < 6; i++) book.add({ bee: "bee1", kind: "research", author: "bee1", title: `p${i}`, text: `A pending note number ${i} here.`, evidence: ["some evidence here"] });
    tick(60 * 60_000);
    expect(r.blocked("bee1")).toMatch(/waiting for your review/);
  });
});
