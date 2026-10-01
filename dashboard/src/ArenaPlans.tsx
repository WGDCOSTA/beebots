// The plans page: what Free, Pro and Premium include and cost. Paying happens on Stripe's own page, so no card detail is
// ever typed here. What a plan promises but the Arena cannot do yet is marked "coming soon" and never sold as if it worked.
import { useEffect, useState } from "react";
import { arena, type BillingView, type Member } from "./arenaApi";
import { fmtPrice, planFeatures, TIER_LABEL, type PlanLimits } from "./arenaModel";
import { useI18n } from "./i18n/I18n";

interface PlanRow {
  id: "free" | "pro" | "premium";
  price: { amount: number; currency: string; interval: string } | null;
  limits: PlanLimits;
}

export function ArenaPlans({ me, paid, onChanged }: { me: Member; paid: boolean; onChanged: () => void }) {
  const { t, locale } = useI18n();
  const [plans, setPlans] = useState<PlanRow[] | null>(null);
  const [open, setOpen] = useState(true);
  const [current, setCurrent] = useState<BillingView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void arena<{ open: boolean; plans: PlanRow[]; current: BillingView | null }>("GET", "billing/plans")
      .then((r) => {
        setPlans(r.data.plans ?? []);
        setOpen(!!r.data.open);
        setCurrent(r.data.current);
      })
      .catch(() => setError(t("common.down")));
  }, [t, me.tier]);

  // Back from Stripe: the webhook may need a few seconds to arrive, so look again a few times.
  useEffect(() => {
    if (!paid || me.tier !== "free") return;
    let n = 0;
    const id = setInterval(() => {
      onChanged();
      if (++n >= 8) clearInterval(id);
    }, 3000);
    return () => clearInterval(id);
  }, [paid, me.tier, onChanged]);

  const go = async (path: "billing/checkout" | "billing/portal", body: Record<string, unknown>, key: string) => {
    setBusy(key);
    setError("");
    try {
      const r = await arena<{ url?: string }>("POST", path, body);
      if (r.status === 200 && r.data.url) window.location.assign(r.data.url);
      else setError(r.data.error ?? t("plans.error"));
    } catch {
      setError(t("plans.error"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <h1 className="as-title">{t("plans.title")}</h1>
      <p className="dim">{t("plans.lead")}</p>
      {paid && <p className="good">{t(me.tier === "free" ? "plans.paid" : "plans.paidDone")}</p>}
      {!open && <p className="pcard arena-card dim">{t("plans.closed")}</p>}
      {error && <p className="bad">{error}</p>}
      <div className="pl-grid">
        {plans?.map((p) => {
          const mine = me.tier === p.id;
          return (
            <div key={p.id} className={`pcard arena-card pl-card ${mine ? "mine" : ""}`}>
              <div className="arena-who">
                <h3>{TIER_LABEL[p.id]}</h3>
                {mine && <span className="badge ok">{t("plans.current")}</span>}
              </div>
              <div className="pl-price num">{p.price ? t("plans.perMonth", { price: fmtPrice(p.price.amount, p.price.currency, locale) }) : t("plans.free0")}</div>
              <ul className="pl-feats">
                {planFeatures(p.limits).map((f) => (
                  <li key={f.key + String(f.vars?.n ?? "")}>
                    {t(f.key, f.vars)} {f.soon && <span className="pl-soon">{t("plans.soon")}</span>}
                  </li>
                ))}
              </ul>
              {open && !mine && p.id !== "free" && me.tier === "free" && (
                <button className="pbtn" disabled={busy !== null} onClick={() => void go("billing/checkout", { plan: p.id }, p.id)}>
                  {busy === p.id ? t("plans.redirecting") : t("plans.choose", { plan: TIER_LABEL[p.id] })}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {open && current?.canManage && (
        <div className="arena-actions">
          <button className="pbtn ghost" disabled={busy !== null} onClick={() => void go("billing/portal", {}, "portal")}>
            {busy === "portal" ? t("plans.redirecting") : t("plans.manage")}
          </button>
          <span className="dim small">{t("plans.manageHelp")}</span>
        </div>
      )}
      <p className="dim small">{t("plans.tax")}</p>
    </>
  );
}
