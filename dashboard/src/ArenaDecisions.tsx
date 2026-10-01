// An agent's decisions, newest first, with the facts behind each: what it saw, the odds it gave every option, what was
// done, and the risk rule that overruled it or acted for it. The model answers with a choice and odds, not words, so
// nothing here is an explanation the platform invented.
import { useState } from "react";
import { agoParts, choiceText, didKey, riskSay } from "./arenaModel";
import { useI18n } from "./i18n/I18n";

export interface DecisionFact {
  ts: number;
  choice: string | null;
  confidence: number | null;
  odds: Array<{ label: string; p: number }>;
  did: { kind: string; coin?: string; side?: string; sizeUsd?: number; reason?: string };
  vetoedBy: string | null;
  forcedBy: string | null;
  status: string;
  saw: { me: Record<string, unknown>; cols: string[]; coins: Record<string, Array<number | null>> };
}

export function useAgo() {
  const { locale } = useI18n();
  const f = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  return (ts: number) => {
    const a = agoParts(ts, Date.now());
    return f.format(a.n, a.unit);
  };
}

function Decision({ d }: { d: DecisionFact }) {
  const { t, locale } = useI18n();
  const ago = useAgo();
  const [open, setOpen] = useState(false);
  const side = d.did.side === "short" ? t("side.short") : t("side.long");
  const did = t(didKey(d.did.kind), { side, coin: d.did.coin ?? "" });
  const rule = d.forcedBy ?? d.vetoedBy;
  const pct = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
  return (
    <li className="dc">
      <div className="dc-head">
        <strong>{did}</strong>
        <span className="dim small">{ago(d.ts)}</span>
      </div>
      <div className="small">
        {d.choice ? (
          <>
            {t("dec.chose", { choice: choiceText(d.choice, t) })}
            {d.confidence !== null && <span className="dim"> · {t("dec.sure", { p: pct.format(d.confidence) })}</span>}
          </>
        ) : (
          <span className="dim">{t("dec.noAnswer")}</span>
        )}
      </div>
      {d.odds.length > 0 && (
        <div className="dc-odds" aria-label={t("dec.odds")}>
          {d.odds.slice(0, 4).map((o) => (
            <div key={o.label} className="dc-odd">
              <span className="small">{choiceText(o.label, t)}</span>
              <span className="dc-bar" aria-hidden>
                <i style={{ width: `${Math.round(o.p * 100)}%` }} />
              </span>
              <span className="num small">{pct.format(o.p)}</span>
            </div>
          ))}
        </div>
      )}
      {rule && (
        <div className={`dc-rule small ${d.forcedBy ? "forced" : "veto"}`}>
          <strong>{t(d.forcedBy ? "dec.ruleActed" : "dec.ruleBlocked")}:</strong> {t(riskSay(rule).key, riskSay(rule).vars)}
        </div>
      )}
      {d.saw.cols.length > 0 && (
        <>
          <button className="linkbtn small" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? t("dec.hideSaw") : t("dec.showSaw")}
          </button>
          {open && (
            <div className="dc-saw">
              <div className="small dim">{Object.entries(d.saw.me).map(([k, v]) => `${k}: ${String(v)}`).join(" · ")}</div>
              <div className="dc-table" role="table">
                <div className="dc-row head" role="row">
                  <span role="columnheader" />
                  {d.saw.cols.map((c) => (
                    <span key={c} role="columnheader">
                      {c}
                    </span>
                  ))}
                </div>
                {Object.entries(d.saw.coins).map(([coin, vals]) => (
                  <div className="dc-row" role="row" key={coin}>
                    <strong role="rowheader">{coin}</strong>
                    {vals.map((v, i) => (
                      <span key={i} className="num" role="cell">
                        {v === null ? "–" : v}
                      </span>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </li>
  );
}

export function ArenaDecisions({ decisions }: { decisions: DecisionFact[] }) {
  const { t } = useI18n();
  return (
    <>
      <p className="dim small">{t("dec.intro")}</p>
      {decisions.length === 0 ? <p className="dim">{t("dec.empty")}</p> : <ul className="dc-list">{decisions.map((d, i) => <Decision key={`${d.ts}-${i}`} d={d} />)}</ul>}
    </>
  );
}
