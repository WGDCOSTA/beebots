import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { ArenaApi } from "../src/arena/api.js";
import { ArenaAuth, normaliseEmail, SESSION_TTL_MS, TOKEN_TTL_MS } from "../src/arena/auth.js";
import type { Mailer } from "../src/arena/mailer.js";
import { ArenaStore } from "../src/arena/store.js";

class Inbox implements Mailer {
  sent: Array<{ to: string; text: string }> = [];
  fail = false;
  async send(to: string, _subject: string, text: string) {
    if (this.fail) throw new Error("smtp down");
    this.sent.push({ to, text });
  }
  tokenFor(to: string): string {
    const m = [...this.sent].reverse().find((s) => s.to === to.toLowerCase())?.text.match(/token=([\w-]+)/);
    if (!m) throw new Error("no mail");
    return m[1]!;
  }
}

function setup() {
  const clock = { t: 1_700_000_000_000 };
  const store = new ArenaStore(mkdtempSync(join(tmpdir(), "arena-")));
  const inbox = new Inbox();
  const auth = new ArenaAuth(store, inbox, { baseUrl: "https://arena.test", now: () => clock.t });
  const api = new ArenaApi(auth, store, { secureCookie: true, now: () => clock.t });
  return { clock, store, inbox, auth, api };
}

async function signIn(s: ReturnType<typeof setup>, email: string) {
  await s.auth.requestLink(email, "1.1.1.1");
  return s.auth.verify(s.inbox.tokenFor(email))!;
}

interface Out {
  status: number;
  body: Record<string, unknown>;
  cookie?: string;
}
async function call(api: ArenaApi, method: string, path: string, body?: unknown, headers: Record<string, string> = { "x-arena": "1" }): Promise<Out> {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, headers, socket: { remoteAddress: "9.9.9.9" } });
  let status = 0;
  let text = "";
  let cookie: string | undefined;
  const res = Object.assign(new EventEmitter(), {
    headersSent: false,
    writeHead(s: number, h: Record<string, string>) {
      status = s;
      cookie = h["set-cookie"];
    },
    end(t: string) {
      text = t;
    },
  });
  await api.handle(req as never, res as never, path);
  return { status, body: JSON.parse(text || "{}"), cookie };
}

describe("sign-in links", () => {
  it("accepts well-formed addresses only", () => {
    expect(normaliseEmail("  Ana@Example.COM ")).toBe("ana@example.com");
    for (const bad of ["", "no-at", "a@b", "a b@c.com", "<x>@y.com", 5, null]) expect(normaliseEmail(bad)).toBeNull();
  });

  it("a link works once, then never again", async () => {
    const s = setup();
    await s.auth.requestLink("ana@example.com", "1.1.1.1");
    const token = s.inbox.tokenFor("ana@example.com");
    expect(s.auth.verify(token)).not.toBeNull();
    expect(s.auth.verify(token)).toBeNull();
  });

  it("a link expires after 15 minutes", async () => {
    const s = setup();
    await s.auth.requestLink("ana@example.com", "1.1.1.1");
    s.clock.t += TOKEN_TTL_MS + 1;
    expect(s.auth.verify(s.inbox.tokenFor("ana@example.com"))).toBeNull();
  });

  it("stores only hashes, never the token or the session", async () => {
    const s = setup();
    await s.auth.requestLink("ana@example.com", "1.1.1.1");
    const token = s.inbox.tokenFor("ana@example.com");
    const r = s.auth.verify(token)!;
    const dump = JSON.stringify([s.store.dir.prepare("SELECT * FROM login_tokens").all(), s.store.dir.prepare("SELECT * FROM sessions").all()]);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(r.session);
  });

  it("rejects guessed or malformed tokens", () => {
    const s = setup();
    for (const t of ["", "short", "x".repeat(300), undefined, 42, "a".repeat(43)]) expect(s.auth.verify(t)).toBeNull();
  });

  it("answers the same for a new and an existing address (no account enumeration)", async () => {
    const s = setup();
    await signIn(s, "ana@example.com");
    const a = await s.auth.requestLink("ana@example.com", "1.1.1.1");
    const b = await s.auth.requestLink("new@example.com", "1.1.1.1");
    expect(a).toEqual(b);
  });

  it("limits links per address and per network address", async () => {
    const s = setup();
    for (let i = 0; i < 8; i++) await s.auth.requestLink("ana@example.com", `10.0.0.${i}`);
    expect(s.inbox.sent.filter((m) => m.to === "ana@example.com")).toHaveLength(5);
    const s2 = setup();
    for (let i = 0; i < 30; i++) await s2.auth.requestLink(`u${i}@example.com`, "2.2.2.2");
    expect(s2.inbox.sent).toHaveLength(20);
    s2.clock.t += 3_600_001;
    await s2.auth.requestLink("late@example.com", "2.2.2.2");
    expect(s2.inbox.sent).toHaveLength(21);
  });

  it("a failing mail provider does not crash or reveal anything", async () => {
    const s = setup();
    s.inbox.fail = true;
    await expect(s.auth.requestLink("ana@example.com", "1.1.1.1")).resolves.toEqual({ ok: true });
  });
});

describe("sessions", () => {
  it("identify the user, slide forward with use, and expire", async () => {
    const s = setup();
    const { session, user } = await signIn(s, "ana@example.com");
    expect(s.auth.user(session)?.id).toBe(user.id);
    s.clock.t += SESSION_TTL_MS - 1000;
    expect(s.auth.user(session)).not.toBeNull();
    s.clock.t += SESSION_TTL_MS - 1000;
    expect(s.auth.user(session)).not.toBeNull();
    s.clock.t += SESSION_TTL_MS + 1;
    expect(s.auth.user(session)).toBeNull();
  });

  it("end on logout", async () => {
    const s = setup();
    const { session } = await signIn(s, "ana@example.com");
    s.auth.logout(session);
    expect(s.auth.user(session)).toBeNull();
  });

  it("the same address always lands on the same account", async () => {
    const s = setup();
    const a = await signIn(s, "ana@example.com");
    const b = await signIn(s, "ANA@example.com");
    expect(b.user.id).toBe(a.user.id);
  });
});

describe("one database per user", () => {
  it("keeps each user's data in their own file", async () => {
    const s = setup();
    const ana = (await signIn(s, "ana@example.com")).user;
    const bob = (await signIn(s, "bob@example.com")).user;
    s.store.tenant(ana.id).prepare("INSERT INTO meta (key, value) VALUES ('secret', 'ana-only')").run();
    expect(s.store.tenant(bob.id).prepare("SELECT * FROM meta").all()).toEqual([]);
  });

  it("refuses ids that are not current users, including path tricks", () => {
    const s = setup();
    for (const id of ["../arena", "..", "", "a".repeat(32), "../../etc/passwd", "0".repeat(31) + "/"]) expect(() => s.store.tenant(id)).toThrow();
  });

  it("deleting an account removes the row, the sessions and the file", async () => {
    const s = setup();
    const { session, user } = await signIn(s, "ana@example.com");
    s.store.tenant(user.id);
    s.store.deleteUser(user.id, s.clock.t);
    expect(s.auth.user(session)).toBeNull();
    expect(s.store.userById(user.id)).toBeNull();
    expect(() => s.store.tenant(user.id)).toThrow();
  });
});

describe("HTTP API", () => {
  it("full round trip: request, verify, me, logout", async () => {
    const s = setup();
    expect((await call(s.api, "POST", "/arena/auth/request", { email: "ana@example.com" })).status).toBe(200);
    const v = await call(s.api, "POST", "/arena/auth/verify", { token: s.inbox.tokenFor("ana@example.com") });
    expect(v.status).toBe(200);
    expect(v.cookie).toMatch(/HttpOnly/);
    expect(v.cookie).toMatch(/SameSite=Lax/);
    expect(v.cookie).toMatch(/Secure/);
    const cookie = v.cookie!.split(";")[0]!;
    const me = await call(s.api, "GET", "/arena/me", undefined, { cookie });
    expect(me.status).toBe(200);
    expect((me.body.user as { email: string }).email).toBe("ana@example.com");
    await call(s.api, "POST", "/arena/auth/logout", {}, { "x-arena": "1", cookie });
    expect((await call(s.api, "GET", "/arena/me", undefined, { cookie })).status).toBe(401);
  });

  it("rejects state changes without the x-arena header", async () => {
    const s = setup();
    expect((await call(s.api, "POST", "/arena/auth/request", { email: "ana@example.com" }, {})).status).toBe(403);
  });

  it("answers 401 without a session and 400 for bad input", async () => {
    const s = setup();
    expect((await call(s.api, "GET", "/arena/me", undefined, {})).status).toBe(401);
    expect((await call(s.api, "POST", "/arena/auth/request", { email: "nope" })).status).toBe(400);
    expect((await call(s.api, "POST", "/arena/auth/verify", { token: "x" })).status).toBe(400);
  });

  it("account deletion needs the e-mail typed back", async () => {
    const s = setup();
    const { session } = await signIn(s, "ana@example.com");
    const cookie = `arena_session=${session}`;
    const h = { "x-arena": "1", cookie };
    expect((await call(s.api, "POST", "/arena/account/delete", { confirm: "wrong@example.com" }, h)).status).toBe(400);
    expect((await call(s.api, "POST", "/arena/account/delete", { confirm: "ana@example.com" }, h)).status).toBe(200);
    expect((await call(s.api, "GET", "/arena/me", undefined, { cookie })).status).toBe(401);
  });

  it("ignores paths that are not the Arena's", async () => {
    const s = setup();
    const req = Object.assign(Readable.from([]), { method: "GET", headers: {}, socket: {} });
    expect(await s.api.handle(req as never, {} as never, "/admin/x")).toBe(false);
  });
});
