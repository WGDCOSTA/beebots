// The Arena's live board, open to everyone: the platform's own example agents (the "house") racing right now, drawn as the
// live site draws the bunnies, with the leaderboard rail and the decision stream; one agent opens its full profile.
// Members' agents never appear here: their results reach the public only through the leaderboard.
import { useEffect, useState } from "react";
import { ArenaOverview, register, type Live } from "./ArenaOverview";
import { ArenaChat } from "./ArenaChat";
import { ArenaProfile } from "./ArenaProfile";
import type { Agent, Catalogue } from "./ArenaParts";
import { STYLE_KEYS } from "./arenaModel";
import { useI18n } from "./i18n/I18n";

interface ShowcaseAgent {
  bot: Agent & { handle: string };
  live: Live | null;
}

const imageOf = (id: string) => `/arena/showcase-image/${id}`;
const hrefOf = (id: string) => `#/arena/live/${id}`;

export function ArenaLive({ id }: { id?: string }) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"profile" | "chat">("profile");
  const [agents, setAgents] = useState<ShowcaseAgent[] | null>(null);
  const [cat, setCat] = useState<Catalogue | null>(null);
  useEffect(() => {
    let alive = true;
    void fetch("/arena/catalogue")
      .then((r) => r.json() as Promise<Catalogue>)
      .then((c) => alive && setCat(c))
      .catch(() => {});
    const load = () =>
      void fetch("/arena/showcase", { cache: "no-store" })
        .then((r) => r.json() as Promise<{ agents: ShowcaseAgent[] }>)
        .then((j) => alive && setAgents(j.agents ?? []))
        .catch(() => alive && setAgents((x) => x ?? []));
    load();
    const iv = setInterval(load, 5_000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, []);

  if (!agents || !cat) return <div className="pcard arena-card dim">{t("common.loading")}</div>;
  const styleLabel = (st: string) => (STYLE_KEYS[st] ? t(STYLE_KEYS[st]!.title) : st);
  const list = agents.map((a) => a.bot);
  const live: Record<string, Live> = Object.fromEntries(agents.filter((a) => a.live).map((a) => [a.bot.id, a.live!]));

  if (id) {
    register(list, cat, styleLabel, imageOf);
    const one = agents.find((a) => a.bot.id === id);
    const board = [...agents].filter((a) => a.live).sort((x, y) => y.live!.bee.equityUsd - x.live!.bee.equityUsd);
    return (
      <>
        <a className="ag-back" href="#/arena/live">
          ← {t("live.title")}
        </a>
        {one ? (
          <>
            {/* Anyone may talk to a house agent: its record on one tab, a conversation on the other. */}
            <div className="ag-tabs" role="tablist">
              {(["profile", "chat"] as const).map((x) => (
                <button key={x} role="tab" aria-selected={tab === x} className={tab === x ? "on" : ""} onClick={() => setTab(x)}>
                  {x === "chat" ? "💬 " : ""}
                  {t(`live.tab.${x}` as const)}
                </button>
              ))}
            </div>
            {tab === "profile" ? (
              <ArenaProfile id={id} kind="house" bee={one.live?.bee} curve={one.live?.curve} rank={board.findIndex((a) => a.bot.id === id) + 1} of={board.length} />
            ) : (
              <div className="pcard arena-card" role="tabpanel">
                <ArenaChat source={{ kind: "house", id }} name={one.bot.name} />
              </div>
            )}
          </>
        ) : (
          <div className="pcard arena-card dim">{t("common.loading")}</div>
        )}
      </>
    );
  }

  return (
    <>
      <div className="arena-who">
        <h1 className="as-title">{t("live.title")}</h1>
        <span className="dim small">{t("live.sub", { n: list.length })}</span>
      </div>
      <ArenaOverview agents={list} cat={cat} live={live} styleLabel={styleLabel} imageOf={imageOf} hrefOf={hrefOf} />
    </>
  );
}
