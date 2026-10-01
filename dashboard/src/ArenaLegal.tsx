// The four legal pages (Terms, Privacy, Risk, Cookies). The text is legalText.ts, in English: English is the text that counts, so
// another language sees a notice and the same text. Until the operator sets the day counsel signed the texts off, every page
// carries a draft banner, and an operator detail that is not set is shown as missing, never hidden.
import { useEffect, useState } from "react";
import { arena } from "./arenaApi";
import { fillOperator, LEGAL, OPERATOR_FIELDS, type LegalDocId, type OperatorField } from "./legalText";
import { useI18n } from "./i18n/I18n";

export const LEGAL_DOCS = ["terms", "privacy", "risk", "cookies"] as const;
export type LegalDoc = (typeof LEGAL_DOCS)[number] & LegalDocId;

type Operator = Partial<Record<OperatorField, string>> & { reviewedOn?: string };

function Filled({ text, op }: { text: string; op: Operator }) {
  return (
    <>
      {fillOperator(text, op).map((x, i) => (x.missing ? <mark key={i}>{x.text}</mark> : <span key={i}>{x.text}</span>))}
    </>
  );
}

/** [Counsel to confirm ...] notes are shown as notes, so a reader can see what is still open. */
function Text({ text, op }: { text: string; op: Operator }) {
  const parts = text.split(/(\[[^\]]*(?:to confirm|to be filled in)[^\]]*\])/i);
  return (
    <>
      {parts.map((p, i) => (/^\[.*\]$/.test(p) ? <mark key={i} className="lg-open">{p}</mark> : <Filled key={i} text={p} op={op} />))}
    </>
  );
}

export function ArenaLegal({ doc }: { doc: LegalDoc }) {
  const { t, locale } = useI18n();
  const [op, setOp] = useState<Operator>({});
  useEffect(() => {
    void arena<Operator>("GET", "operator").then((r) => setOp(r.status === 200 ? r.data : {})).catch(() => setOp({}));
  }, []);
  const d = LEGAL[doc];
  const missing = OPERATOR_FIELDS.filter((f) => !(op[f] ?? "").trim());
  const reviewed = (op.reviewedOn ?? "").trim();

  return (
    <div className="as-legal">
      <h1 className="as-title">{t(`legal.${doc}` as const)}</h1>
      {reviewed ? (
        <div className="banner ok" role="note">
          {t("legal.reviewed", { date: reviewed })}
        </div>
      ) : (
        <div className="banner" role="note">
          {t("legal.banner")}
        </div>
      )}
      {locale !== "en" && (
        <div className="banner" role="note" lang={locale}>
          {t("legal.englishOnly")}
        </div>
      )}
      {missing.length > 0 && (
        <div className="banner" role="note">
          {t("legal.gaps")}
        </div>
      )}
      <p className="dim small">{t("legal.updated", { date: d.updated })}</p>
      <p lang="en">
        <Text text={d.intro} op={op} />
      </p>
      <nav className="lg-toc" aria-label={t(`legal.${doc}` as const)} lang="en">
        <ol>
          {d.sections.map((s, i) => (
            <li key={s.h}>
              <a href={`#/arena/legal/${doc}`} onClick={(e) => { e.preventDefault(); document.getElementById(`lg-${doc}-${i}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>
                {s.h}
              </a>
            </li>
          ))}
        </ol>
      </nav>
      <div lang="en">
        {d.sections.map((s, i) => (
          <section key={s.h} id={`lg-${doc}-${i}`} className="lg-sec">
            <h2>
              {i + 1}. {s.h}
            </h2>
            {s.p?.map((p, j) => (
              <p key={j}>
                <Text text={p} op={op} />
              </p>
            ))}
            {s.li && (
              <ul>
                {s.li.map((l, j) => (
                  <li key={j}>
                    <Text text={l} op={op} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
      <p className="lg-links">
        {LEGAL_DOCS.filter((x) => x !== doc).map((x) => (
          <a key={x} href={`#/arena/legal/${x}`}>
            {t(`legal.${x}` as const)}
          </a>
        ))}
        <a href="#/arena">{t("legal.back")}</a>
      </p>
    </div>
  );
}
