// Plans and payment, on the operator's own Stripe account. Card details never reach this server: the member pays on Stripe's page,
// and Stripe tells us by webhook what the subscription is. A webhook is believed only if its signature checks out, the plan is
// read from our own price ids (never from anything the page sends), and a repeated delivery changes nothing.
// Stripe's page and portal need to be set up in the Stripe dashboard (products, prices, the customer portal that lets a member switch plan).
import { createHmac, timingSafeEqual } from "node:crypto";
import { Bots } from "./bots.js";
import { PLAN_PRICES, QUARANTINE_DAYS } from "./plans.js";
import type { ArenaStore, ArenaUser, Tier } from "./store.js";

export type PaidTier = Exclude<Tier, "free">;
export const PAID_TIERS: readonly PaidTier[] = ["pro", "premium"];

export interface BillingConfig {
  secretKey: string;
  webhookSecret: string;
  /** The Stripe price id of each paid plan. */
  prices: Record<PaidTier, string>;
  /** Let Stripe Tax work out VAT on the checkout page. */
  automaticTax: boolean;
  /** Where Stripe sends the member back to (the Arena's public address). */
  baseUrl: string;
}

/** The three calls the Arena makes to Stripe. A fake in tests; HttpStripe in production. */
export interface StripeClient {
  checkout(o: { price: string; plan: PaidTier; userId: string; email: string; customer: string | null; successUrl: string; cancelUrl: string; automaticTax: boolean; locale: string }): Promise<string>;
  portal(customer: string, returnUrl: string): Promise<string>;
  cancel(subscription: string): Promise<void>;
}

const form = (o: Record<string, string>): string => new URLSearchParams(o).toString();

export class HttpStripe implements StripeClient {
  constructor(private readonly key: string, private readonly fetcher: typeof fetch = fetch) {}

  private async call(method: "POST" | "DELETE", path: string, body?: Record<string, string>): Promise<Record<string, unknown>> {
    const r = await this.fetcher(`https://api.stripe.com/v1/${path}`, {
      method,
      headers: { authorization: `Bearer ${this.key}`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      body: body ? form(body) : undefined,
    });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) throw new Error(`stripe ${path} answered ${r.status}`); // never echo Stripe's body: it can name the customer
    return j;
  }

  async checkout(o: Parameters<StripeClient["checkout"]>[0]): Promise<string> {
    const body: Record<string, string> = {
      mode: "subscription",
      "line_items[0][price]": o.price,
      "line_items[0][quantity]": "1",
      success_url: o.successUrl,
      cancel_url: o.cancelUrl,
      client_reference_id: o.userId,
      "metadata[plan]": o.plan,
      "subscription_data[metadata][plan]": o.plan,
      locale: o.locale,
    };
    if (o.customer) body.customer = o.customer;
    else body.customer_email = o.email;
    if (o.automaticTax) body["automatic_tax[enabled]"] = "true";
    const url = (await this.call("POST", "checkout/sessions", body)).url;
    if (typeof url !== "string") throw new Error("stripe gave no checkout address");
    return url;
  }

  async portal(customer: string, returnUrl: string): Promise<string> {
    const url = (await this.call("POST", "billing_portal/sessions", { customer, return_url: returnUrl })).url;
    if (typeof url !== "string") throw new Error("stripe gave no portal address");
    return url;
  }

  async cancel(subscription: string): Promise<void> {
    await this.call("DELETE", `subscriptions/${encodeURIComponent(subscription)}`);
  }
}

/** Checks Stripe's signature header (t=..., v1=...) over the exact bytes received. Five minutes of tolerance against replays. */
export function verifySignature(raw: string, header: string | undefined, secret: string, nowMs: number, toleranceSec = 300): boolean {
  if (!header) return false;
  const parts = header.split(",").map((p) => p.trim().split("="));
  const t = parts.find((p) => p[0] === "t")?.[1];
  const sigs = parts.filter((p) => p[0] === "v1").map((p) => p[1] ?? "");
  if (!t || !/^\d+$/.test(t) || sigs.length === 0) return false;
  if (Math.abs(nowMs / 1000 - Number(t)) > toleranceSec) return false;
  const want = createHmac("sha256", secret).update(`${t}.${raw}`).digest();
  return sigs.some((s) => {
    const got = Buffer.from(s, "hex");
    return got.length === want.length && timingSafeEqual(got, want);
  });
}

export class BillingError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** What changed for a member's agents after a plan change, so the caller can stop engines and clean the leaderboard. */
export type PlanChange = (userId: string, r: { quarantined: string[]; restored: string[]; purged: string[] }) => Promise<void> | void;

type Obj = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export class Billing {
  constructor(
    private readonly store: ArenaStore,
    readonly cfg: BillingConfig | null,
    private readonly stripe: StripeClient | null,
    private readonly onChange: PlanChange,
    private readonly now: () => number = Date.now,
  ) {}

  get open(): boolean {
    return !!this.cfg && !!this.stripe;
  }

  private planOfPrice(price: string | null): PaidTier | null {
    return PAID_TIERS.find((p) => this.cfg?.prices[p] === price) ?? null;
  }

  /** Sets the plan and brings the member's agents in line with it. */
  async applyTier(userId: string, tier: Tier): Promise<void> {
    const u = this.store.userById(userId);
    if (!u) return;
    this.store.setTier(userId, tier);
    await this.reconcile(userId);
    this.store.audit(userId, `plan ${tier}`, this.now());
  }

  /** Quarantines what the plan no longer allows, restores what it allows again, deletes what is past its 10 days. */
  async reconcile(userId: string): Promise<void> {
    const u = this.store.userById(userId);
    if (!u) return;
    const bots = new Bots(this.store.tenant(userId), u.tier, this.now);
    const r = bots.reconcile(this.now());
    const purged = bots.purgeQuarantined(this.now());
    for (const id of purged) this.store.removePortrait(userId, id);
    if (r.quarantined.length || r.restored.length || purged.length) await this.onChange(userId, { ...r, purged });
  }

  /** The periodic safety net: every member, in case an event was missed or a quarantine ran out. */
  async sweep(): Promise<void> {
    for (const id of this.store.allUserIds()) await this.reconcile(id);
  }

  async checkout(u: ArenaUser, plan: unknown, locale: string): Promise<string> {
    if (!this.cfg || !this.stripe) throw new BillingError("Payments are not open yet.", 503);
    if (plan !== "pro" && plan !== "premium") throw new BillingError("Pick a plan.");
    const b = this.store.billingOf(u.id);
    // Someone who already pays changes plan in Stripe's portal, so there is never a second subscription.
    if (u.tier !== "free" || (b.subscription && b.status && !["canceled", "incomplete_expired"].includes(b.status))) throw new BillingError("You already have a paid plan. Change it from Manage billing.", 409);
    return this.stripe.checkout({ price: this.cfg.prices[plan], plan, userId: u.id, email: u.email, customer: b.customer, successUrl: `${this.cfg.baseUrl}/#/arena/plans?paid=1`, cancelUrl: `${this.cfg.baseUrl}/#/arena/plans`, automaticTax: this.cfg.automaticTax, locale });
  }

  async portal(u: ArenaUser): Promise<string> {
    if (!this.cfg || !this.stripe) throw new BillingError("Payments are not open yet.", 503);
    const b = this.store.billingOf(u.id);
    if (!b.customer) throw new BillingError("There is no billing to manage yet.", 404);
    return this.stripe.portal(b.customer, `${this.cfg.baseUrl}/#/arena/me`);
  }

  /** Called when an account is deleted: a subscription must not outlive the account. Returns false if Stripe could not be told. */
  async cancelFor(userId: string): Promise<boolean> {
    const b = this.store.billingOf(userId);
    if (!b.subscription) return true;
    if (!this.stripe) return false;
    try {
      await this.stripe.cancel(b.subscription);
      return true;
    } catch {
      return false;
    }
  }

  /** Handles one webhook delivery. Throws BillingError for what Stripe should retry or never send again. */
  async webhook(raw: string, signature: string | undefined): Promise<void> {
    if (!this.cfg) throw new BillingError("Payments are not open yet.", 503);
    if (!verifySignature(raw, signature, this.cfg.webhookSecret, this.now())) throw new BillingError("Bad signature.", 400);
    let ev: Obj;
    try {
      ev = JSON.parse(raw) as Obj;
    } catch {
      throw new BillingError("Bad event.", 400);
    }
    const id = str(ev.id);
    const type = str(ev.type);
    const obj = ((ev.data as Obj | undefined)?.object ?? {}) as Obj;
    if (!id || !type) throw new BillingError("Bad event.", 400);
    if (!this.store.firstSight(id, this.now())) return;
    if (type === "checkout.session.completed") await this.completed(obj);
    else if (type.startsWith("customer.subscription.")) await this.subscription(type, obj);
  }

  private async completed(o: Obj): Promise<void> {
    const userId = str(o.client_reference_id);
    const customer = str(o.customer);
    const sub = str(o.subscription);
    if (!userId || !this.store.userById(userId) || !customer) return;
    this.store.setBilling(userId, { customer, subscription: sub }, this.now());
    // The plan is whatever we put in the session's metadata when we made it. The tier itself follows the subscription events.
    const plan = str((o.metadata as Obj | undefined)?.plan);
    if (o.payment_status === "paid" && (plan === "pro" || plan === "premium")) await this.applyTier(userId, plan);
  }

  private async subscription(type: string, o: Obj): Promise<void> {
    const customer = str(o.customer);
    const userId = customer ? this.store.userIdByCustomer(customer) : null;
    if (!userId) return;
    const status = type === "customer.subscription.deleted" ? "canceled" : str(o.status);
    const item = (((o.items as Obj | undefined)?.data as Obj[] | undefined) ?? [])[0];
    const end = Number(o.current_period_end ?? item?.current_period_end ?? NaN);
    this.store.setBilling(userId, { subscription: str(o.id), status, periodEnd: Number.isFinite(end) ? end * 1000 : null }, this.now());
    const plan = this.planOfPrice(str((item?.price as Obj | undefined)?.id)) ?? ((p) => (p === "pro" || p === "premium" ? p : null))(str((o.metadata as Obj | undefined)?.plan));
    if (status === "active" || status === "trialing" || status === "past_due") {
      if (plan) await this.applyTier(userId, plan);
    } else if (status === "canceled" || status === "unpaid" || status === "incomplete_expired" || status === "paused") await this.applyTier(userId, "free");
  }

  view(u: ArenaUser): { open: boolean; plan: Tier; status: string | null; periodEnd: number | null; canManage: boolean; quarantineDays: number } {
    const b = this.store.billingOf(u.id);
    return { open: this.open, plan: u.tier, status: b.status, periodEnd: b.periodEnd, canManage: this.open && !!b.customer, quarantineDays: QUARANTINE_DAYS };
  }
}

export const prices = PLAN_PRICES;
