// The fields of an agent, in groups, shared by the create wizard (one group per step) and the agent's Settings (all at once).
// What the plan leaves out is shown locked, with the reason, and a coin a style cannot trade is greyed out, not hidden.
import { coinFits, STYLE_COINS, STYLE_KEYS, toggleCoin, withStyle, type BotDraft } from "./arenaModel";
import { Portrait, type Catalogue, type Limits } from "./ArenaParts";
import { useI18n } from "./i18n/I18n";

interface Props {
  cat: Catalogue;
  limits: Limits;
  d: BotDraft;
  set: (d: BotDraft) => void;
}

export function LookFields({ cat, limits, d, set }: Props) {
  const { t } = useI18n();
  const theme = cat.themes.find((x) => x.id === d.theme);
  return (
    <>
      <div className="eyebrow">{t("field.theme")}</div>
      <div className="ab-chips">
        {cat.themes.map((th) => {
          const locked = th.tier === "pro" && !limits.proThemes;
          return (
            <button key={th.id} type="button" className={`ab-chip ${d.theme === th.id ? "on" : ""}`} disabled={locked} title={locked ? t("field.proOnly") : th.blurb} onClick={() => set({ ...d, theme: th.id, avatar: th.avatars[0]!.id })}>
              {th.label}
              {locked && <small> {t("field.pro")}</small>}
            </button>
          );
        })}
      </div>
      {theme && <p className="dim small">{theme.blurb}</p>}

      <div className="eyebrow">{t("field.avatar")}</div>
      <div className="ab-avatars">
        {theme?.avatars.map((a) => (
          <button key={a.id} type="button" className={`ab-avatar ${d.avatar === a.id ? "on" : ""}`} onClick={() => set({ ...d, avatar: a.id })} aria-label={a.label} aria-pressed={d.avatar === a.id}>
            <Portrait cat={cat} theme={d.theme} avatar={a.id} size={52} />
            <span className="small">{a.label}</span>
          </button>
        ))}
      </div>

      <label className="eyebrow" htmlFor="af-name">
        {t("field.name")}
      </label>
      <input id="af-name" className="pinput" maxLength={24} placeholder={t("field.namePh")} value={d.name} onChange={(e) => set({ ...d, name: e.target.value })} />

      <label className="eyebrow" htmlFor="af-tag">
        {t("field.tagline")} <span className="dim">({t("field.optional")})</span>
      </label>
      <input id="af-tag" className="pinput" maxLength={40} placeholder={t("field.taglinePh")} value={d.tagline} onChange={(e) => set({ ...d, tagline: e.target.value })} />

      <label className="eyebrow" htmlFor="af-look">
        {t("field.look")} <span className="dim">({t("field.lookFor")})</span>
      </label>
      <input id="af-look" className="pinput" maxLength={400} placeholder={t("field.lookPh")} value={d.look} onChange={(e) => set({ ...d, look: e.target.value })} />
    </>
  );
}

export function StyleFields({ cat, limits, d, set }: Props) {
  const { t } = useI18n();
  return (
    <>
      <div className="eyebrow">{t("field.style")}</div>
      <div className="ab-styles">
        {Object.entries(STYLE_KEYS).map(([id, s]) => {
          const locked = !limits.styles.includes(id);
          return (
            <button key={id} type="button" className={`ab-style ${d.style === id ? "on" : ""}`} disabled={locked} aria-pressed={d.style === id} onClick={() => set(withStyle(d, id))}>
              <strong>
                {t(s.title)}
                {locked && <small> {t("field.pro")}</small>}
              </strong>
              <span className="dim small">{t(s.blurb)}</span>
            </button>
          );
        })}
      </div>

      <div className="eyebrow">
        {t("field.coins")} <span className="dim">({d.coins.length}/{limits.maxCoins})</span>
      </div>
      <div className="ab-chips">
        {cat.coins.map((c) => {
          const fits = coinFits(d.style, c);
          return (
            <button
              key={c}
              type="button"
              className={`ab-chip ${d.coins.includes(c) ? "on" : ""}`}
              aria-pressed={d.coins.includes(c)}
              disabled={!fits}
              title={fits ? undefined : t("field.coinNo", { style: t(STYLE_KEYS[d.style]!.title), coins: (STYLE_COINS[d.style] ?? []).join(", ") })}
              onClick={() => set({ ...d, coins: toggleCoin(d.coins, c, limits.maxCoins, d.style) })}
            >
              {c}
            </button>
          );
        })}
      </div>
      {STYLE_COINS[d.style] && <p className="dim small">{t("field.coinNo", { style: t(STYLE_KEYS[d.style]!.title), coins: STYLE_COINS[d.style]!.join(", ") })}</p>}
    </>
  );
}

export function RulesField({ d, set, note }: Pick<Props, "d" | "set"> & { note?: string }) {
  const { t } = useI18n();
  return (
    <>
      <label className="eyebrow" htmlFor="af-rules">
        {t("field.rules")}
      </label>
      <textarea id="af-rules" className="pinput ab-rules" rows={5} maxLength={500} placeholder={t("field.rulesPh")} value={d.rules} onChange={(e) => set({ ...d, rules: e.target.value })} />
      <div className="dim small">
        {d.rules.trim().length} / 500{note ? `. ${note}` : ""}
      </div>
    </>
  );
}

export function ListedField({ d, set }: Pick<Props, "d" | "set">) {
  const { t } = useI18n();
  return (
    <label className="ab-listed">
      <input type="checkbox" checked={d.listed} onChange={(e) => set({ ...d, listed: e.target.checked })} />
      <span>
        <strong>{t("field.listed")}</strong>
        <span className="dim small"> {t("field.listedHelp")}</span>
      </span>
    </label>
  );
}
