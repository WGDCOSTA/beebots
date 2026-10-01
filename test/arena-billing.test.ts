import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { ArenaApi } from "../src/arena/api.js";
import { ArenaAuth } from "../src/arena/auth.js";
import { Billing, HttpStripe, verifySignature, type BillingConfig, type StripeClient } from "../src/arena/billing.js";
import { Bots, LIMITS } from "../src/arena/bots.js";
import type { Mailer } from "../src/arena/mailer.js";
import { PLAN_PRICES, QUARANTINE_DAYS } from "../src/arena/plans.js";
import { ArenaStore } from "../src/arena/store.js";

const NOW = Date.UTC(2026, 9, 1, 12);
const DAY = 86_400_000;
const SECRET = "whsec_test";
const cfg: BillingConfig = { secretKey: "sk_test", webhookSecret: SECRET, prices: { pro: "price_pro", premium: "price_premium" }, automaticTax: true, baseUrl: "https://arena.test" };
const input = (name: string, style = "breezy") => ({ name, theme: "bunnies", avatar: "scout", style, coins: ["BTC"], rules: "Follow the BTC trend, cut losses fast." });

class FakeStripe implements StripeClient {
  calls: Array<Record<string, unknown>> = [];
  cancelled: string[] = [];
  failCancel = false;
  async checkout(o: Parameters<StripeClient["checkout"]>[0]) {
    this.calls.push({ ...o });
    return "https://stripe.test/pay";
  }
  async portal(customer: string) {
    return `https://stripe.test/portal/${customer}`;
  }
  async cancel(sub: string) {
    if (this.failCancel) throw new Error("down");
    this.cancelled.push(sub);
  }
}

class Inbox implements Mailer {
  sent: string[] = [];
  async send(_to: string, _s: string, text: string) {
    this.sent.push(text);
  }
}

const sign = (raw: string, t = Math.floor(NOW / 1000), secret = SECRET) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;
let evn = 0;
const event = (type: string, object: Record<string, unknown>) => JSON.stringify({ id: `evt_${++evn}`, type, data: { object } });

async function setup(open = true) {
  const store = new ArenaStore(mkdtempSync(join(tmpdir(), "arena-bill-")));
  const stripe = new FakeStripe();
  const changes: Array<{ userId: string; quarantined: string[]; restored: string[]; purged: string[] }> = [];
  const clock = { t: NOW };
  const billing = new Billing(store, open ? cfg : null, open ? stripe : null, (userId, r) => void changes.push({ userId, ...r }), () => clock.t);
  const inbox = new Inbox();
  const auth = new ArenaAuth(store, inbox, { baseUrl: "https://arena.test" });
  const api = new ArenaApi(auth, store, { secureCookie: true, billing, now: () => clock.t });
  await auth.requestLink("ana@example.com", "1.1.1.1");
  const v = auth.verify(inbox.sent.at(-1)!.match(/token=([\w-]+)/)![1])!;
  store.acceptConsent(v.user.id, 1);
  const bots = (tier: "free" | "pro" | "premium") => new Bots(store.tenant(v.user.id), tier, () => clock.t);
  return { store, stripe, billing, api, changes, clock, uid: v.user.id, cookie: `arena_session=${v.session}`, bots, tier: () => store.userById(v.user.id)!.tier };
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function http(api: ArenaApi, method: string, path: string, body?: unknown, cookie?: string, headers: Record<string, string> = {}, rawBody?: string) {
  const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
  const req = Object.assign(Readable.from(payload === undefined ? [] : [Buffer.from(payload)]), { method, url: path, headers: { ...(headers["x-arena"] === "none" ? {} : { "x-arena": "1" }), ...(cookie ? { cookie } : {}), ...headers }, socket: { remoteAddress: "9.9.9.9" } });
  let status = 0;
  let text = "";
  const res = Object.assign(new EventEmitter(), { headersSent: false, writeHead: (s: number) => void (status = s), end: (t: string) => void (text = String(t)) });
  await api.handle(req as never, res as never, path.split("?")[0]!);
  return { status, body: JSON.parse(text || "{}") as Json };
}

describe("Stripe's signature", () => {
  const raw = '{"id":"evt_x"}';
  it("accepts the right one and nothing else", () => {
    expect(verifySignature(raw, sign(raw), SECRET, NOW)).toBe(true);
    expect(verifySignature(raw, sign(raw, undefined, "other"), SECRET, NOW)).toBe(false);
    expect(verifySignature(raw + " ", sign(raw), SECRET, NOW)).toBe(false); // the exact bytes
    expect(verifySignature(raw, undefined, SECRET, NOW)).toBe(false);
    expect(verifySignature(raw, "garbage", SECRET, NOW)).toBe(false);
    expect(verifySignature(raw, `t=abc,v1=00`, SECRET, NOW)).toBe(false);
  });
  it("refuses an old one, so a captured event cannot be replayed later", () => {
    const old = Math.floor(NOW / 1000) - 3600;
    expect(verifySignature(raw, sign(raw, old), SECRET, NOW)).toBe(false);
  });
  it("accepts any of several v1 signatures", () => {
    const t = Math.floor(NOW / 1000);
    const good = sign(raw).split("v1=")[1];
    expect(verifySignature(raw, `t=${t},v1=deadbeef,v1=${good}`, SECRET, NOW)).toBe(true);
  });
});

describe("the plans", () => {
  it("are public, with the owner's prices", async () => {
    const w = await setup();
    const r = await http(w.api, "GET", "/arena/billing/plans");
    expect(r.status).toBe(200);
    expect(r.body.open).toBe(true);
    expect(r.body.plans.map((p: Json) => p.id)).toEqual(["free", "pro", "premium"]);
    expect(r.body.plans[1].price).toEqual({ amount: 999, currency: "eur", interval: "month" });
    expect(r.body.plans[2].price.amount).toBe(1599);
    expect(r.body.plans[2].limits).toMatchObject({ bots: 20, brains: 6, autonomy: true });
    expect(r.body.plans[1].limits).toMatchObject({ brains: 3, skillSlots: 30, history: true });
    expect(r.body.plans[0].limits).toMatchObject({ bots: 1, brains: 1, skillSlots: 5, history: false });
    expect(PLAN_PRICES.pro.amount).toBe(999);
  });
  it("say payments are closed when Stripe is not set up, and checkout refuses", async () => {
    const w = await setup(false);
    expect((await http(w.api, "GET", "/arena/billing/plans")).body.open).toBe(false);
    expect((await http(w.api, "POST", "/arena/billing/checkout", { plan: "pro" }, w.cookie)).status).toBe(503);
  });
});

describe("checkout", () => {
  it("uses our own price for the plan asked, and the member's id, never anything else the page sends", async () => {
    const w = await setup();
    const r = await http(w.api, "POST", "/arena/billing/checkout", { plan: "premium", price: "price_evil", userId: "someone-else" }, w.cookie);
    expect(r.body.url).toBe("https://stripe.test/pay");
    expect(w.stripe.calls[0]).toMatchObject({ price: "price_premium", plan: "premium", userId: w.uid, email: "ana@example.com", automaticTax: true });
  });
  it("refuses an unknown plan, a signed-out caller, and a second subscription", async () => {
    const w = await setup();
    expect((await http(w.api, "POST", "/arena/billing/checkout", { plan: "free" }, w.cookie)).status).toBe(400);
    expect((await http(w.api, "POST", "/arena/billing/checkout", { plan: "pro" })).status).toBe(401);
    w.store.setTier(w.uid, "pro");
    expect((await http(w.api, "POST", "/arena/billing/checkout", { plan: "premium" }, w.cookie)).status).toBe(409);
  });
  it("opens the portal only for someone who has a Stripe customer", async () => {
    const w = await setup();
    expect((await http(w.api, "POST", "/arena/billing/portal", {}, w.cookie)).status).toBe(404);
    w.store.setBilling(w.uid, { customer: "cus_1" }, NOW);
    expect((await http(w.api, "POST", "/arena/billing/portal", {}, w.cookie)).body.url).toBe("https://stripe.test/portal/cus_1");
  });
});

describe("the webhook", () => {
  const post = (w: Awaited<ReturnType<typeof setup>>, raw: string, sig = sign(raw)) => http(w.api, "POST", "/arena/billing/webhook", undefined, undefined, { "x-arena": "none", "stripe-signature": sig }, raw);

  it("needs no cookie and no x-arena header, only a good signature", async () => {
    const w = await setup();
    const raw = event("checkout.session.completed", { client_reference_id: w.uid, customer: "cus_1", subscription: "sub_1", payment_status: "paid", metadata: { plan: "pro" } });
    expect((await post(w, raw, "t=1,v1=00")).status).toBe(400);
    expect(w.tier()).toBe("free");
    expect((await post(w, raw)).status).toBe(200);
    expect(w.tier()).toBe("pro");
    expect(w.store.billingOf(w.uid)).toMatchObject({ customer: "cus_1", subscription: "sub_1" });
  });
  it("does not make anyone paid for an unpaid session or an unknown plan", async () => {
    const w = await setup();
    await post(w, event("checkout.session.completed", { client_reference_id: w.uid, customer: "cus_1", subscription: "sub_1", payment_status: "unpaid", metadata: { plan: "pro" } }));
    expect(w.tier()).toBe("free");
    await post(w, event("checkout.session.completed", { client_reference_id: w.uid, customer: "cus_1", subscription: "sub_1", payment_status: "paid", metadata: { plan: "admin" } }));
    expect(w.tier()).toBe("free");
    await post(w, event("checkout.session.completed", { client_reference_id: "nobody", customer: "cus_9", payment_status: "paid", metadata: { plan: "pro" } }));
    expect(w.store.userIdByCustomer("cus_9")).toBeNull();
  });
  it("handles a repeated delivery once", async () => {
    const w = await setup();
    const raw = event("checkout.session.completed", { client_reference_id: w.uid, customer: "cus_1", subscription: "sub_1", payment_status: "paid", metadata: { plan: "pro" } });
    await post(w, raw);
    w.store.setTier(w.uid, "free"); // if it were handled again, the plan would come back
    await post(w, raw);
    expect(w.tier()).toBe("free");
  });
  it("follows the subscription: switching plan, a late payment keeps the plan, ending it returns to Free", async () => {
    const w = await setup();
    w.store.setBilling(w.uid, { customer: "cus_1", subscription: "sub_1" }, NOW);
    const sub = (status: string, price: string) => event("customer.subscription.updated", { id: "sub_1", customer: "cus_1", status, current_period_end: NOW / 1000 + 30 * 86400, items: { data: [{ price: { id: price } }] } });
    await post(w, sub("active", "price_premium"));
    expect(w.tier()).toBe("premium");
    expect(w.store.billingOf(w.uid).periodEnd).toBe(NOW + 30 * DAY);
    await post(w, sub("past_due", "price_premium"));
    expect(w.tier()).toBe("premium");
    await post(w, sub("active", "price_pro"));
    expect(w.tier()).toBe("pro");
    await post(w, event("customer.subscription.deleted", { id: "sub_1", customer: "cus_1", items: { data: [{ price: { id: "price_pro" } }] } }));
    expect(w.tier()).toBe("free");
    expect(w.store.billingOf(w.uid).status).toBe("canceled");
  });
  it("ignores events about customers it does not know", async () => {
    const w = await setup();
    expect((await post(w, event("customer.subscription.updated", { id: "s", customer: "cus_x", status: "active", items: { data: [{ price: { id: "price_pro" } }] } }))).status).toBe(200);
    expect(w.tier()).toBe("free");
  });
});

describe("quarantine after a downgrade", () => {
  it("keeps the oldest agents the plan allows, quarantines the rest, and refuses to touch them", async () => {
    const w = await setup();
    w.store.setTier(w.uid, "pro");
    let n = 1000;
    const bots = new Bots(w.store.tenant(w.uid), "pro", () => (n += 1000));
    const a = bots.create(input("First"));
    const b = bots.create(input("Second"));
    const c = bots.create(input("Boozy One", "boozy"));
    await w.billing.applyTier(w.uid, "free");
    const free = w.bots("free");
    expect(free.find(a.id).state).toBe("running");
    expect(free.find(b.id).state).toBe("quarantined");
    expect(free.find(c.id)).toMatchObject({ state: "quarantined", quarantinedAt: NOW });
    expect(w.changes.at(-1)!.quarantined.sort()).toEqual([b.id, c.id].sort());
    for (const act of [() => free.setState(b.id, "paused"), () => free.update(b.id, input("Second")), () => free.startAgain(b.id)]) expect(act).toThrow(/quarantine/);
    expect(free.list().length).toBe(3); // still counts against the plan: no dodging the limit
    expect(() => free.create(input("Fourth"))).toThrow();
  });
  it("restores them, as stopped, when the member upgrades again", async () => {
    const w = await setup();
    w.store.setTier(w.uid, "pro");
    const pro = w.bots("pro");
    const a = pro.create(input("First"));
    const b = pro.create(input("Second"));
    await w.billing.applyTier(w.uid, "free");
    await w.billing.applyTier(w.uid, "pro");
    expect(w.bots("pro").find(b.id)).toMatchObject({ state: "stopped", quarantinedAt: null });
    expect(w.bots("pro").find(a.id).state).toBe("running");
    expect(w.changes.at(-1)!.restored).toEqual([b.id]);
  });
  it("deletes an agent when its 10 days are over, with its portrait, and not a day before", async () => {
    const w = await setup();
    w.store.setTier(w.uid, "pro");
    const pro = w.bots("pro");
    pro.create(input("First"));
    const b = pro.create(input("Second"));
    w.store.savePortrait(w.uid, b.id, Buffer.from("jpg"));
    await w.billing.applyTier(w.uid, "free");
    w.clock.t = NOW + (QUARANTINE_DAYS - 1) * DAY;
    await w.billing.sweep();
    expect(w.bots("free").list().map((x) => x.id)).toContain(b.id);
    w.clock.t = NOW + QUARANTINE_DAYS * DAY;
    await w.billing.sweep();
    expect(w.bots("free").list().map((x) => x.id)).not.toContain(b.id);
    expect(w.store.readPortrait(w.uid, b.id)).toBeNull();
    expect(w.changes.at(-1)!.purged).toEqual([b.id]);
  });
  it("also catches a plan that was changed by hand, on the periodic sweep", async () => {
    const w = await setup();
    w.store.setTier(w.uid, "premium");
    const p = w.bots("premium");
    for (let i = 0; i < 3; i++) p.create(input(`Agent ${i}`));
    w.store.setTier(w.uid, "free");
    await w.billing.sweep();
    expect(w.bots("free").list().filter((x) => x.state === "quarantined")).toHaveLength(2);
  });
});

describe("deleting an account with a subscription", () => {
  it("cancels the subscription first", async () => {
    const w = await setup();
    w.store.setBilling(w.uid, { customer: "cus_1", subscription: "sub_1" }, NOW);
    const r = await http(w.api, "POST", "/arena/account/delete", { confirm: "ana@example.com" }, w.cookie);
    expect(r.status).toBe(200);
    expect(w.stripe.cancelled).toEqual(["sub_1"]);
    expect(w.store.userById(w.uid)).toBeNull();
  });
  it("keeps the account when Stripe cannot be told, so nobody is charged for nothing", async () => {
    const w = await setup();
    w.store.setBilling(w.uid, { customer: "cus_1", subscription: "sub_1" }, NOW);
    w.stripe.failCancel = true;
    const r = await http(w.api, "POST", "/arena/account/delete", { confirm: "ana@example.com" }, w.cookie);
    expect(r.status).toBe(502);
    expect(w.store.userById(w.uid)).not.toBeNull();
  });
  it("needs no Stripe for someone who never paid", async () => {
    const w = await setup(false);
    expect((await http(w.api, "POST", "/arena/account/delete", { confirm: "ana@example.com" }, w.cookie)).status).toBe(200);
  });
});

describe("the Stripe calls", () => {
  it("send what Stripe needs, with the key in the header, and never repeat Stripe's answer on a failure", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const ok = (async (url: string, init: RequestInit) => (seen.push({ url, init }), new Response(JSON.stringify({ url: "https://pay" }), { status: 200 }))) as unknown as typeof fetch;
    const s = new HttpStripe("sk_x", ok);
    expect(await s.checkout({ price: "price_pro", plan: "pro", userId: "u1", email: "a@b.co", customer: null, successUrl: "https://a/ok", cancelUrl: "https://a/no", automaticTax: true, locale: "de" })).toBe("https://pay");
    const body = new URLSearchParams(String(seen[0]!.init.body));
    expect(seen[0]!.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer sk_x");
    expect(Object.fromEntries(body)).toMatchObject({ mode: "subscription", "line_items[0][price]": "price_pro", client_reference_id: "u1", customer_email: "a@b.co", "metadata[plan]": "pro", "automatic_tax[enabled]": "true", locale: "de" });
    const bad = (async () => new Response(JSON.stringify({ error: { message: "card for ana@example.com" } }), { status: 402 })) as unknown as typeof fetch;
    await expect(new HttpStripe("sk_x", bad).portal("cus_1", "https://a")).rejects.toThrow(/answered 402$/);
  });
});

describe("limits", () => {
  it("say what the owner decided", () => {
    expect(LIMITS.free).toMatchObject({ bots: 1, brains: 1, skillSlots: 5 });
    expect(LIMITS.pro).toMatchObject({ bots: 9, brains: 3, skillSlots: 30, history: true });
    expect(LIMITS.premium).toMatchObject({ bots: 20, brains: 6 });
  });
});
