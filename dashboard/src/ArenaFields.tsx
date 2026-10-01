// The fields of an agent, in groups, shared by the create wizard (one group per step) and the agent's Settings (all at once).
// What the plan leaves out is shown locked, with the reason, and a coin a style cannot trade is greyed out, not hidden.
import { coinFits, PROVIDER_LABEL, STYLE_COINS, STYLE_KEYS, toggleCoin, withStyle, type BotDraft } from "./arenaModel";
import { Portrait, type Catalogue, type KeysState, type Limits, type SkillsState } from "./ArenaParts";
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
      {!limits.proThemes && (
        <a className="small" href="#/arena/plans">
          {t("plans.seeLocked")}
        </a>
      )}

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

export function StyleFields({ cat, limits, d, set, skills }: Props & { skills?: SkillsState }) {
  const { t } = useI18n();
  const isSkill = d.mode === "skill";
  const usable = (skills?.skills ?? []).filter((s) => !s.locked);
  if (d.mode === "autonomous")
    return (
      <>
        <div className="eyebrow">{t("field.style")}</div>
        <div className="ab-style on" aria-live="polite">
          <strong>{t("style.auto.t")}</strong>
          <span className="dim small">{t("style.auto.b")}</span>
        </div>
      </>
    );
  return (
    <>
      {isSkill && (
        <>
          <label className="eyebrow" htmlFor="af-skill">
            {t("skills.pick")}
          </label>
          <select id="af-skill" className="pinput" value={d.skill ?? ""} onChange={(e) => set({ ...d, skill: e.target.value || null, style: "boozy" })}>
            <option value="">{t("skills.choose")}</option>
            {usable.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          {usable.length === 0 && (
            <a className="small" href="#/arena/skills">
              {t("skills.getOne")}
            </a>
          )}
          <p className="dim small">{t("skills.pickHelp")}</p>
        </>
      )}
      {!isSkill && <div className="eyebrow">{t("field.style")}</div>}
      {!isSkill && (
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
      )}

      {!isSkill && limits.styles.length < 3 && (
        <a className="small" href="#/arena/plans">
          {t("plans.seeLocked")}
        </a>
      )}

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
      {!isSkill && STYLE_COINS[d.style] && <p className="dim small">{t("field.coinNo", { style: t(STYLE_KEYS[d.style]!.title), coins: STYLE_COINS[d.style]!.join(", ") })}</p>}
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

/** Which models an agent thinks with: the platform's shared one and/or the member's own keys, up to what the plan allows. With several, they vote. */
export function BrainField({ d, set, keys, limits }: Pick<Props, "d" | "set" | "limits"> & { keys: KeysState }) {
  const { t } = useI18n();
  const chosen = d.brains ?? ["platform"];
  const max = limits.brains;
  if (!keys.open && chosen.length === 1 && chosen[0] === "platform") return null;
  const toggle = (id: string) => {
    const has = chosen.includes(id);
    const next = has ? chosen.filter((x) => x !== id) : [...chosen, id];
    if (next.length === 0 || next.length > max) return;
    set({ ...d, brains: next });
  };
  const options = [{ id: "platform", label: t("brain.platform") }, ...keys.keys.map((k) => ({ id: k.id, label: `${k.label} · ${PROVIDER_LABEL[k.provider] ?? k.provider} · ${k.model}` }))];
  return (
    <>
      <div className="eyebrow">
        {t("brain.field")} <span className="dim">({chosen.length}/{max})</span>
      </div>
      <div className="ab-brains" role="group" aria-label={t("brain.field")}>
        {options.map((o) => {
          const on = chosen.includes(o.id);
          return (
            <label key={o.id} className={on ? "on" : ""}>
              <input type="checkbox" checked={on} disabled={(!on && chosen.length >= max) || (on && chosen.length === 1)} onChange={() => toggle(o.id)} />
              <span>{o.label}</span>
            </label>
          );
        })}
      </div>
      <p className="dim small">{t(max > 1 ? "brain.helpMany" : "brain.help", { n: max })}</p>
      {chosen.length > 1 && <p className="small">{t("brain.vote", { n: chosen.length })}</p>}
      {max === 1 && (
        <a className="small" href="#/arena/plans">
          {t("plans.seeLocked")}
        </a>
      )}
      {keys.keys.length === 0 && (
        <a className="small" href="#/arena/me">
          {t("brain.addKey")}
        </a>
      )}
    </>
  );
}
/** Fixed style or autonomous. Chosen when the agent is made and never changed afterwards. Autonomous is Premium only: shown locked, with the way to the plans. */
export function ModeField({ d, set, limits }: Pick<Props, "d" | "set" | "limits">) {
  const { t } = useI18n();
  const mode = d.mode ?? "fixed";
  return (
    <>
      <div className="eyebrow">{t("mode.field")}</div>
      <div className="ab-styles">
        <button type="button" className={`ab-style ${mode === "fixed" ? "on" : ""}`} aria-pressed={mode === "fixed"} onClick={() => set({ ...d, mode: "fixed" })}>
          <strong>{t("mode.fixed.t")}</strong>
          <span className="dim small">{t("mode.fixed.b")}</span>
        </button>
        <button type="button" className={`ab-style ${mode === "skill" ? "on" : ""}`} aria-pressed={mode === "skill"} onClick={() => set({ ...d, mode: "skill", style: "boozy", coins: d.coins.length ? d.coins : ["BTC"] })}>
          <strong>{t("mode.skill.t")}</strong>
          <span className="dim small">{t("mode.skill.b")}</span>
        </button>
        <button type="button" className={`ab-style ${mode === "autonomous" ? "on" : ""}`} aria-pressed={mode === "autonomous"} disabled={!limits.autonomy} onClick={() => set({ ...d, mode: "autonomous" })}>
          <strong>
            {t("mode.auto.t")}
            {!limits.autonomy && <small> {t("field.premium")}</small>}
          </strong>
          <span className="dim small">{t("mode.auto.b")}</span>
        </button>
      </div>
      {!limits.autonomy && (
        <a className="small" href="#/arena/plans">
          {t("plans.seeLocked")}
        </a>
      )}
    </>
  );
}
