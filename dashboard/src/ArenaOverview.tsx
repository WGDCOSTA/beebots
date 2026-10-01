// The member's agents drawn exactly as the live board draws the bunnies: the same BeeColumn (portrait, equity, curve with
// axes, the last call and its odds, the day's trades and fees, totals), the same leaderboard rail and the same decision
// stream. Each agent runs the same Engine as a bunny, so GET /arena/bots/live hands over the very shapes these read.
import { useEffect, useState } from "react";
import { BeeColumn, money } from "./BeeColumn";
import type { Agent, Catalogue } from "./ArenaParts";
import { useI18n } from "./i18n/I18n";
import { Ticker } from "./Ticker";
import { BEE_META, type DecisionEvent, type PublicBee } from "./types";

interface Live {
  bee: PublicBee;
  curve: Array<[number, number]>;
  decisions: DecisionEvent[];
}

/** The member's running agents as the live board sees them, refreshed every 5 seconds (the live board streams). */
export function useArenaLive(): Record<string, Live> {
  const [live, setLive] = useState<Record<string, Live>>({});
  useEffect(() => {
    let alive = true;
    const load = () =>
      void fetch("/arena/bots/live", { cache: "no-store", credentials: "same-origin" })
        .then((r) => (r.ok ? (r.json() as Promise<{ live: Record<string, Live> }>) : null))
        .then((j) => alive && j && setLive(j.live ?? {}))
        .catch(() => {});
    load();
    const id = setInterval(load, 5_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return live;
}

/** An agent without a painted portrait still gets a round picture: its avatar's glyph on its colour. */
function glyphImage(glyph: string, color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="${color}" fill-opacity="0.28"/><text x="32" y="42" font-size="32" text-anchor="middle">${glyph}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Tells the shared components (beeMeta) who each agent is: its name, colour and portrait. */
function register(agents: Agent[], cat: Catalogue, styleLabel: (s: string) => string) {
  for (const a of agents) {
    const av = cat.themes.find((t) => t.id === a.theme)?.avatars.find((x) => x.id === a.avatar);
    const color = av?.color ?? "#f0b43c";
    BEE_META[a.id] = {
      title: a.name,
      short: a.name,
      tagline: a.tagline ?? "",
      styleLabel: a.mode === "autonomous" ? "Autonomous" : styleLabel(a.style),
      rules: a.rules ?? "",
      coins: a.coins ?? [],
      img: a.image ? `/arena/bot-image/${a.id}` : glyphImage(av?.glyph ?? "?", color),
      color,
      glow: `${color}73`,
      market: "crypto",
      squad: "crypto",
    };
  }
}

export function ArenaOverview({ agents, cat, live, styleLabel, after }: { agents: Agent[]; cat: Catalogue; live: Record<string, Live>; styleLabel: (s: string) => string; after?: React.ReactNode }) {
  const { t } = useI18n();
  register(agents, cat, styleLabel);
  const [, tick] = useState(0);
  // Re-render every second so the "ago" times and flashes move, as on the live board.
  useEffect(() => {
    const id = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const running = agents.filter((a) => live[a.id]);
  const board = [...running].sort((a, b) => live[b.id]!.bee.equityUsd - live[a.id]!.bee.equityUsd);
  const leaderEq = board[0] ? live[board[0].id]!.bee.equityUsd : 0;
  // The decision stream: every agent's latest calls, newest first, each labelled with its own agent.
  const decisions = running
    .flatMap((a) => live[a.id]!.decisions.map((d) => ({ ...d, bee: a.id })))
    .sort((x, y) => y.ts - x.ts)
    .slice(0, 60);
  const perMin = decisions.filter((d) => Date.now() - d.ts < 60_000).length;

  return (
    <div className="ar-overview">
      <div className="ar-cols">
        {running.map((a) => {
          const l = live[a.id]!;
          return (
            <BeeColumn
              key={a.id}
              name={a.id}
              bee={l.bee}
              curve={l.curve}
              baseline={l.bee.startEquityUsd ?? 1000}
              rank={board.indexOf(a) + 1}
              gap={Math.max(0, leaderEq - l.bee.equityUsd)}
              flash={undefined}
              href={`#/arena/agent/${a.id}`}
            />
          );
        })}
        {after}
      </div>
      {running.length > 0 && (
        <aside className="rail ar-rail">
          <section className="rail-card board">
            <div className="rail-head">
              <span className="eyebrow">{t("nav.board")}</span>
              <span className="dim num">pnl · equity</span>
            </div>
            {board.map((a, i) => {
              const b = live[a.id]!.bee;
              const m = BEE_META[a.id]!;
              const width = Math.max(4, (b.equityUsd / Math.max(leaderEq, 1)) * 100);
              return (
                <a className="board-row" href={`#/arena/agent/${a.id}`} key={a.id} style={{ ["--bee" as string]: m.color }}>
                  <span className="board-rank num">{i + 1}</span>
                  <img src={m.img} alt="" />
                  <span className="board-name">{m.short}</span>
                  <span className="board-bar">
                    <span style={{ width: `${width}%` }} />
                  </span>
                  <span className="board-meta num">
                    <span className={b.pnlPct >= 0 ? "good" : "bad"}>
                      {b.pnlPct >= 0 ? "+" : ""}
                      {b.pnlPct.toFixed(2)}%
                    </span>
                  </span>
                  <span className="board-eq num">{money(b.equityUsd)}</span>
                </a>
              );
            })}
          </section>
          <Ticker decisions={decisions} perMin={perMin} />
        </aside>
      )}
    </div>
  );
}
