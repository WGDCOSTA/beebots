// What a visitor sees before signing in: what the Arena is, the real leaderboard so they see people and not promises, and the way in.
import { useEffect, useState } from "react";
import { ArenaSignIn } from "./ArenaSignIn";
import { fmtPct, leagueText } from "./arenaModel";
import { useI18n } from "./i18n/I18n";

interface Row {
  rank: number | null;
  botId: string;
  name: string;
  handle: string;
  theme: string;
  avatar: string;
  league: string;
  metrics: { returnPct: number } | null;
}
interface Board {
  enabled: boolean;
  rows?: Row[];
}
interface Theme {
  id: string;
  avatars: Array<{ id: string; glyph: string; color: string }>;
}

export function ArenaLanding({ notice }: { notice?: string }) {
  const { t, locale } = useI18n();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [all, setAll] = useState<Row[]>([]);
  const [themes, setThemes] = useState<Theme[]>([]);

  useEffect(() => {
    let alive = true;
    // The board moves while a visitor reads: look again every 30 seconds, as the live dashboard streams.
    const load = () =>
      void fetch("/arena/leaderboard", { cache: "no-store" })
        .then((r) => r.json() as Promise<Board>)
        .then((b) => {
          if (!alive) return;
          setRows((b.rows ?? []).filter((r) => r.rank !== null));
          setAll(b.rows ?? []);
        })
        .catch(() => alive && setRows((x) => x ?? []));
    load();
    const id = setInterval(load, 30_000);
    void fetch("/arena/catalogue")
      .then((r) => r.json() as Promise<{ themes: Theme[] }>)
      .then((c) => alive && setThemes(c.themes))
      .catch(() => {});
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // The first league that has someone ranked, top three.
  const league = rows?.[0]?.league;
  const top = (rows ?? []).filter((r) => r.league === league).slice(0, 3);
  const glyph = (r: Row) => themes.find((x) => x.id === r.theme)?.avatars.find((a) => a.id === r.avatar);
  // Nobody ranked yet: show who is racing, so the page is alive from the first hour.
  const warming = top.length === 0 ? all.filter((r) => r.rank === null).slice(0, 6) : [];

  const start = () => {
    const el = document.getElementById("arena-email");
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    el?.focus();
  };

  return (
    <>
      <section className="as-hero">
        <span className="eyebrow">{t("landing.eyebrow")}</span>
        <h1>{t("landing.title")}</h1>
        <p className="lead">{t("landing.lead")}</p>
        <div className="as-cta">
          <button className="pbtn" onClick={start}>
            {t("landing.cta")}
          </button>
          <a className="pbtn ghost" href="#/arena/ranking">
            {t("landing.board")}
          </a>
        </div>
        {all.length > 0 && (
          // Decorative: every agent racing right now, drifting past. The board beside it says who they are in words.
          <div className="as-parade" aria-hidden>
            <div className="as-parade-track">
              {[...all, ...all].map((r, i) => (
                <span className="ab-portrait as-parade-av" key={`${r.botId}-${i}`} style={{ ["--av" as string]: glyph(r)?.color ?? "#888" }} title={r.name}>
                  {glyph(r)?.glyph ?? "?"}
                </span>
              ))}
            </div>
          </div>
        )}
      </section>

      <div className="as-grid">
        <ArenaSignIn notice={notice} />
        <div>
          <div className="pcard arena-card">
            <span className="eyebrow">{league ? t("landing.preview", { league: leagueText(league, t) }) : t("nav.board")}</span>
            {rows !== null && top.length === 0 && warming.length === 0 && <p className="dim">{t("landing.previewEmpty")}</p>}
            {warming.map((r) => (
              <div className="rk-row wait" key={r.botId} style={{ ["--av" as string]: glyph(r)?.color ?? "#888" }}>
                <span className="ab-portrait rk-glyph" style={{ ["--av" as string]: glyph(r)?.color ?? "#888" }} aria-hidden>
                  {glyph(r)?.glyph ?? "?"}
                </span>
                <div className="rk-main">
                  <strong>{r.name}</strong>
                  <div className="dim small">@{r.handle}</div>
                </div>
                <span className="as-warm">{t("rank.waiting")}</span>
              </div>
            ))}
            {top.map((r) => (
              <div className="rk-row" key={r.botId} style={{ ["--av" as string]: glyph(r)?.color ?? "#888" }}>
                <span className={`rk-rank r${r.rank}`}>{r.rank}</span>
                <span className="ab-portrait rk-glyph" style={{ ["--av" as string]: glyph(r)?.color ?? "#888" }} aria-hidden>
                  {glyph(r)?.glyph ?? "?"}
                </span>
                <div className="rk-main">
                  <strong>{r.name}</strong>
                  <div className="dim small">@{r.handle}</div>
                </div>
                <strong className={`num ${(r.metrics?.returnPct ?? 0) >= 0 ? "good" : "bad"}`}>{fmtPct(r.metrics?.returnPct ?? 0, locale)}</strong>
              </div>
            ))}
          </div>
          <div className="pcard arena-card as-how">
            <h3>{t("landing.how")}</h3>
            {(["1", "2", "3"] as const).map((n) => (
              <div className="step" key={n}>
                <span className="n">{n}</span>
                <div>
                  <strong>{t(`landing.how${n}.t` as const)}</strong>
                  <div className="dim small">{t(`landing.how${n}.b` as const)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <p className="dim small">{t("landing.notice")}</p>
    </>
  );
}
