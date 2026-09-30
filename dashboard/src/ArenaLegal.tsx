// The four legal pages. The real texts are written with counsel before launch; until then each page says plainly that it is a draft.
import { useI18n } from "./i18n/I18n";

export const LEGAL_DOCS = ["terms", "privacy", "risk", "cookies"] as const;
export type LegalDoc = (typeof LEGAL_DOCS)[number];

export function ArenaLegal({ doc }: { doc: LegalDoc }) {
  const { t } = useI18n();
  return (
    <div className="as-legal">
      <h1 className="as-title">{t(`legal.${doc}` as const)}</h1>
      <div className="banner" role="note">
        {t("legal.banner")}
      </div>
      <p>{t("legal.body")}</p>
      <p>
        <a href="#/arena">{t("legal.back")}</a>
      </p>
    </div>
  );
}
