// The create wizard: five short steps (start, look, style, rules, review) with a live preview that follows every choice.
// "Start" offers the platform's AI help (first agent), an example to edit, or a blank page. The server checks everything
// again, so the page's own checks are only there to say what is missing before the member presses Create.
import { useState } from "react";
import { arena, type Limits } from "./arenaApi";
import { stepIssue, STYLE_KEYS, styleTitleKey, WIZARD_STEPS, type BotDraft, type Say, type WizardStep } from "./arenaModel";
import { BrainField, ListedField, LookFields, ModeField, RulesField, StyleFields } from "./ArenaFields";
import { Portrait, type ArenaData } from "./ArenaParts";
import { useI18n } from "./i18n/I18n";

const BLANK: BotDraft = { name: "", theme: "bunnies", avatar: "scout", style: "breezy", coins: ["BTC"], rules: "", tagline: "", look: "", listed: true };

const KIND_KEY = { steady: "new.tpl.steady", breakout: "new.tpl.breakout", momentum: "new.tpl.momentum" } as const;

export function ArenaNew({ data, limits, onDone, onCancel }: { data: ArenaData; limits: Limits; onDone: (id: string) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [step, setStep] = useState<WizardStep>("start");
  const [d, setD] = useState<BotDraft>(BLANK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [idea, setIdea] = useState("");
  const [designing, setDesigning] = useState(false);
  const [note, setNote] = useState(false);
  const [left, setLeft] = useState(data.ai?.designsLeft ?? 0);
  const [from, setFrom] = useState<"ai" | "template" | "blank" | null>(null);

  const say = (m: Say) => t(m.key, m.vars);
  const styleName = (id: string) => t(STYLE_KEYS[id]?.title ?? "style.breezy.t");
  const i = WIZARD_STEPS.indexOf(step);
  const issue = stepIssue(step, d, limits.maxCoins, styleName);
  const full = data.agents.length >= limits.bots;

  if (full)
    return (
      <div className="pcard arena-card">
        <h3>{t("new.title")}</h3>
        <p className="dim">{t(limits.bots === 1 ? "home.quotaFull1" : "home.quotaFull", { n: limits.bots })}</p>
        <div className="arena-actions">
          <a className="pbtn" href="#/arena/plans">
            {t("home.quarantine.cta")}
          </a>
          <button className="pbtn ghost" onClick={onCancel}>
            {t("new.back")}
          </button>
        </div>
      </div>
    );

  const design = async () => {
    setDesigning(true);
    setError("");
    setNote(false);
    try {
      const r = await arena<{ draft?: Partial<BotDraft> }>("POST", "ai/design", { description: idea });
      if (r.status === 200 && r.data.draft) {
        const f = r.data.draft;
        setD((cur) => ({ ...cur, ...f, coins: f.coins ?? cur.coins }));
        setLeft((x) => Math.max(0, x - 1));
        setNote(true);
        setFrom("ai");
      } else {
        if (r.status === 422) setLeft((x) => Math.max(0, x - 1));
        setError(r.data.error ?? t("ai.error"));
      }
    } catch {
      setError(t("common.down"));
    } finally {
      setDesigning(false);
    }
  };

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await arena<{ bot?: { id: string } }>("POST", "bots/create", d);
      if (r.status === 200 && r.data.bot) {
        await data.reload();
        onDone(r.data.bot.id);
      } else setError(r.data.error ?? t("err.save"));
    } catch {
      setError(t("common.down"));
    } finally {
      setBusy(false);
    }
  };

  const go = (n: number) => {
    setError("");
    setStep(WIZARD_STEPS[Math.min(WIZARD_STEPS.length - 1, Math.max(0, n))]!);
  };
  const theme = data.cat.themes.find((x) => x.id === d.theme);

  return (
    <div className="pcard arena-card nw">
      <div className="arena-who">
        <h3>{t("new.title")}</h3>
        <span className="dim small">{t("new.stepOf", { n: i + 1, total: WIZARD_STEPS.length })}</span>
      </div>
      <ol className="nw-steps" aria-label={t("new.title")}>
        {WIZARD_STEPS.map((s, n) => (
          <li key={s} className={n === i ? "on" : n < i ? "done" : ""} aria-current={n === i ? "step" : undefined}>
            <span>{t(`new.step.${s}` as const)}</span>
          </li>
        ))}
      </ol>

      {step !== "start" && (
        <div className="nw-preview" aria-label={t("new.preview")}>
          <Portrait cat={data.cat} theme={d.theme} avatar={d.avatar} size={48} />
          <div>
            <strong>{d.name.trim() || t("new.unnamed")}</strong> {d.tagline && <span className="dim small">{d.tagline.startsWith("the ") ? d.tagline : `the ${d.tagline}`}</span>}
            <div className="small dim">
              {t(styleTitleKey(d.mode, d.style))} · {d.mode === "autonomous" ? t("coins.any") : d.coins.join(" · ")} {theme ? `· ${theme.label}` : ""}
            </div>
          </div>
        </div>
      )}

      <form
        className="ab-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (step === "review") void create();
          else if (!issue) go(i + 1);
        }}
      >
        {step === "start" && (
          <>
            <p className="lead">{t("new.start.lead")}</p>
            {data.ai?.canDesign && left > 0 && (
              <div className="ab-ai">
                <div className="eyebrow">{t("ai.title")}</div>
                <p className="dim small">{t("ai.help", { n: left })}</p>
                <textarea className="pinput ab-rules" rows={3} maxLength={400} aria-label={t("ai.title")} placeholder={t("ai.placeholder")} value={idea} onChange={(e) => setIdea(e.target.value)} />
                <div className="arena-actions">
                  <button type="button" className="pbtn" disabled={designing || idea.trim().length < 8} onClick={() => void design()}>
                    {designing ? t("ai.going") : t("ai.go")}
                  </button>
                  {note && (
                    <button type="button" className="pbtn ghost" onClick={() => go(1)}>
                      {t("new.next")}
                    </button>
                  )}
                </div>
                {note && <p className="dim small">{t("ai.done")}</p>}
              </div>
            )}
            <div className="eyebrow">{t("new.start.template")}</div>
            <p className="dim small">{t("new.example")}</p>
            <div className="nw-tpls">
              {data.templates.map((tp) => {
                const locked = tp.pro && !limits.styles.includes(tp.style);
                return (
                  <button
                    key={tp.id}
                    type="button"
                    className={`ab-style nw-tpl ${from === "template" && d.name === tp.name ? "on" : ""}`}
                    disabled={locked}
                    onClick={() => {
                      const { id: _id, kind: _k, pro: _p, ...fields } = tp; // eslint-disable-line @typescript-eslint/no-unused-vars
                      setD({ ...BLANK, ...fields, mode: "fixed", coins: fields.coins.slice(0, limits.maxCoins) });
                      setFrom("template");
                      go(1);
                    }}
                  >
                    <strong>
                      {tp.name}
                      {locked && <small> {t("field.pro")}</small>}
                    </strong>
                    <span className="dim small">{t(KIND_KEY[tp.kind])}</span>
                  </button>
                );
              })}
            </div>
            <div className="arena-actions">
              <button
                type="button"
                className="pbtn ghost"
                onClick={() => {
                  setD(BLANK);
                  setFrom("blank");
                  go(1);
                }}
              >
                {t("new.start.blank")}
              </button>
              <button type="button" className="linkbtn" onClick={onCancel}>
                {t("new.cancel")}
              </button>
            </div>
          </>
        )}
        {step === "look" && <LookFields cat={data.cat} limits={limits} d={d} set={setD} />}
        {step === "style" && (
          <>
            <ModeField d={d} set={setD} limits={limits} />
            <StyleFields cat={data.cat} limits={limits} d={d} set={setD} />
          </>
        )}
        {step === "rules" && <RulesField d={d} set={setD} />}
        {step === "review" && (
          <>
            <p className="lead">{t("new.review.lead")}</p>
            <dl className="nw-review">
              <dt>{t("field.rules")}</dt>
              <dd>{d.rules}</dd>
              <dt>{t("field.style")}</dt>
              <dd>{t(styleTitleKey(d.mode, d.style))}</dd>
              <dt>{t("field.coins")}</dt>
              <dd>{d.mode === "autonomous" ? t("coins.any") : d.coins.join(", ")}</dd>
            </dl>
            <BrainField d={d} set={setD} keys={data.keys} limits={limits} />
            <ListedField d={d} set={setD} />
          </>
        )}

        {error && <p className="bad">{error}</p>}
        {step !== "start" && (
          <>
            {issue && <p className="dim small">{say(issue)}</p>}
            <div className="arena-actions">
              <button type="button" className="pbtn ghost" onClick={() => go(i - 1)}>
                {t("new.back")}
              </button>
              <button className="pbtn" disabled={busy || issue !== null}>
                {step === "review" ? (busy ? t("new.creating") : t("new.create")) : t("new.next")}
              </button>
              <button type="button" className="linkbtn" onClick={onCancel}>
                {t("new.cancel")}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
