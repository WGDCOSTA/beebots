// The Arena's operator controls (arena/ops.ts): closed without a token, refuses a wrong one, lists every member's agents
// and pauses, resumes or stops one or all of them through the members' own path.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Bots } from "../src/arena/bots.js";
import { ArenaOps } from "../src/arena/ops.js";
import { ArenaStore } from "../src/arena/store.js";

const TOKEN = "t".repeat(32);
function setup() {
  const store = new ArenaStore(mkdtempSync(join(tmpdir(), "ops-")));
  const ids: string[] = [];
  for (const [i, handle] of ["alice", "bob"].entries()) {
    const id = `${String(i + 1).repeat(32)}`;
    store.createUser(id, `${handle}@example.test`, 1);
    store.setHandle(id, handle);
    store.setTier(id, "pro");
    new Bots(store.tenant(id), "pro").create({ name: `Agent ${handle}`, theme: "bunnies", avatar: "scout", style: "breezy", coins: ["BTC"], rules: "Follow the trend calmly.", listed: true } as never);
    ids.push(id);
  }
  const updated: string[] = [];
  const runner = { status: () => ({}), update: async (u: string) => void updated.push(u), running: 0 };
  return { store, ids, updated, ops: new ArenaOps(store, runner, TOKEN) };
}
const req = (token?: string) => ({ headers: token ? { "x-ops-token": token } : {}, method: "GET" }) as never;
const res = () => {
  const r = { status: 0, body: "" as string, writeHead(s: number) { r.status = s; }, end(b: string) { r.body = b; } };
  return r;
};

describe("ArenaOps", () => {
  it("is closed without a token and refuses a wrong one", async () => {
    const { store } = setup();
    const closed = new ArenaOps(store, null, undefined);
    const r1 = res();
    await closed.handle(req(TOKEN), r1 as never, "/ops/agents");
    expect(r1.status).toBe(503);
    const { ops } = setup();
    const r2 = res();
    await ops.handle(req("wrong-token-wrong-token-wrong-tok"), r2 as never, "/ops/agents");
    expect(r2.status).toBe(401);
  });

  it("lists every member's agents without e-mail addresses", async () => {
    const { ops } = setup();
    const r = res();
    await ops.handle(req(TOKEN), r as never, "/ops/agents");
    expect(r.status).toBe(200);
    const v = JSON.parse(r.body);
    expect(v.agents.map((a: { handle: string }) => a.handle).sort()).toEqual(["alice", "bob"]);
    expect(r.body).not.toContain("@example.test");
  });

  it("pauses and resumes every agent, or stops one, and tells the runner", async () => {
    const { ops, ids, updated, store } = setup();
    expect((await ops.setState({ action: "pause", all: true })).body).toMatchObject({ changed: 2 });
    expect(updated.sort()).toEqual([...ids].sort());
    expect(new Bots(store.tenant(ids[0]!), "pro").list()[0]!.state).toBe("paused");
    expect((await ops.setState({ action: "resume", all: true })).body).toMatchObject({ changed: 2 });
    const bot = new Bots(store.tenant(ids[1]!), "pro").list()[0]!;
    expect((await ops.setState({ action: "stop", userId: ids[1], botId: bot.id })).body).toMatchObject({ changed: 1 });
    expect(new Bots(store.tenant(ids[1]!), "pro").list()[0]!.state).toBe("stopped");
    expect((await ops.setState({ action: "explode" })).status).toBe(400);
  });
});
