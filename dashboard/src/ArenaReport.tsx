// An agent's answer as a report: its stance and how sure it is (its own opinion), the argument in sections that each point
// at their proof (a chart below or a figure), the charts with the marks it made, the figures as tiles, what would change its
// mind, what the data cannot say, and where the data came from. Figures are computed by the server; the agent only chose them.
import { ArenaChart } from "./ArenaChart";
import type { ReportData } from "./arenaChart";
import { useI18n } from "./i18n/I18n";

const METRIC_IDS = ["return", "range", "maxdd", "slope", "upbars", "best", "worst", "last", "high", "low", "atr", "rsi", "sma20", "sma50", "volchg"];

/** A metric's name in the member's language (the server's label is English). */
export function useMetricName() {
  const { t } = useI18n();
  return (id: string, fallback: string): string => {
    if (METRIC_IDS.includes(id)) return t(`met.${id}` as never);
    const m = /^([sr])(\d)$/.exec(id);
    if (m) return t(m[1] === "s" ? "met.support" : "met.resistance", { n: m[2]! });
    return fallback;
  };
}

export function ArenaReport({ report }: { report: ReportData }) {
  const { t, locale } = useI18n();
  const metricName = useMetricName();
  const chartIds = report.charts.map((c) => c.id);
  const metricLabel = (ref: string) => {
    const [a, b] = ref.includes(".") ? ref.split(".") : [undefined, ref];
    const m = report.metrics.find((x) => x.id === b && (!a || x.symbol === a.toUpperCase())) ?? null;
    return metricName(b!, m?.label ?? b!);
  };
  const date = (ts: number) => new Date(ts).toLocaleString(locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: false });
  return (
    <article className="rp">
      <header className="rp-head">
        <span className={`rp-stance ${report.stance}`}>{t(`rep.stance.${report.stance}` as never)}</span>
        <span className="dim small" title={t("rep.confidenceHelp")}>
          {t("rep.confidence", { n: Math.round(report.confidence * 100) })}
        </span>
      </header>
      <h3 className="rp-title">{report.headline}</h3>
      {report.summary && <p className="rp-sum">{report.summary}</p>}

      {report.metrics.length > 0 && (
        <div className="rp-tiles" aria-label={t("rep.figures")}>
          {report.metrics.map((m) => (
            <div key={`${m.symbol}.${m.id}`} className="rp-tile" title={m.help}>
              <span className="dim small">
                {report.sources.length > 1 ? `${m.symbol} · ` : ""}
                {metricName(m.id, m.label)}
              </span>
              <strong className={`num ${m.id !== "last" && m.id !== "high" && m.id !== "low" && /^-/.test(m.text) ? "bad" : /^\+/.test(m.text) ? "good" : ""}`}>{m.text}</strong>
            </div>
          ))}
        </div>
      )}

      {report.sections.map((s, i) => (
        <section key={i} className="rp-sec">
          <h4>{s.heading}</h4>
          <p>{s.text}</p>
          {s.evidence.length > 0 && (
            <p className="rp-ev small dim">
              {t("rep.evidence")}:{" "}
              {s.evidence.map((e, j) => (
                <span key={e} className={`rp-chip ${chartIds.includes(e) ? "cv" : ""}`}>
                  {chartIds.includes(e) ? `▣ ${report.charts.find((c) => c.id === e)?.title ?? e}` : metricLabel(e)}
                  {j < s.evidence.length - 1 ? "" : ""}
                </span>
              ))}
            </p>
          )}
        </section>
      ))}

      {report.charts.map((c) => (
        <ArenaChart key={c.id} chart={c} />
      ))}

      {report.counter && (
        <section className="rp-box">
          <h4>{t("rep.counter")}</h4>
          <p>{report.counter}</p>
        </section>
      )}
      {report.caveats.length > 0 && (
        <section className="rp-box">
          <h4>{t("rep.caveats")}</h4>
          <ul>
            {report.caveats.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </section>
      )}
      {report.unchecked.length > 0 && (
        <p className="rp-warn small" role="note">
          ⚠ {t("rep.unchecked", { list: report.unchecked.join(", ") })}
        </p>
      )}
      <footer className="rp-foot dim small">
        <div className="eyebrow">{t("rep.data")}</div>
        {report.sources.map((s) => (
          <p key={s.symbol}>
            {t("rep.source", { label: `${s.label} (${s.symbol})`, bars: s.bars, bar: s.bar, from: date(s.from), to: date(s.to) })}
            {s.kind === "commodity" || s.kind === "stock" ? ` ${t(s.kind === "commodity" ? "rep.note.commodity" : "rep.note.stock")}` : ""}
          </p>
        ))}
        <p>{t("rep.honest")}</p>
      </footer>
    </article>
  );
}
