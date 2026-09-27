import { useEffect, useState } from "react";
import { BeeColumn, money } from "./BeeColumn";
import { Header } from "./Header";
import { unlockAudio } from "./sound";
import { Ticker } from "./Ticker";
import { Toasts } from "./Toasts";
import { ALL_BEES, beeMeta, BEE_NAMES, TIER_INFO } from "./types";
import { useFeed } from "./useFeed";

function readSoundPref(): boolean {
  try {
    return localStorage.getItem("bees.sound") === "on";
  } catch {
    return false;
  }
}

export function App() {
  const [soundOn, setSoundOn] = useState(false);
  const feed = useFeed(soundOn);
  const [, force] = useState(0);

  // Re-render every second so "ago" / flash windows expire even when the stream is quiet.
  useEffect(() => {
    const t = setInterval(() => force((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // Sound needs a click before the browser allows audio: one click anywhere turns on a saved preference.
  useEffect(() => {
    if (!readSoundPref()) return;
    const once = () => setSoundOn(unlockAudio());
    window.addEventListener("pointerdown", once, { once: true });
    return () => window.removeEventListener("pointerdown", once);
  }, []);

  const toggleSound = () => {
    const next = !soundOn && unlockAudio();
    setSoundOn(next);
    try {
      localStorage.setItem("bees.sound", next ? "on" : "off");
    } catch {
      /* private mode: fine */
    }
  };

  const board = [...ALL_BEES].sort((a, b) => (feed.bees[b]?.equityUsd ?? 0) - (feed.bees[a]?.equityUsd ?? 0));
  const leaderEq = feed.bees[board[0]!]?.equityUsd ?? 0;
  const baseline = feed.snap?.startEquityUsd ?? 333;
  const stalled = feed.lastEventAt > 0 && Date.now() - feed.lastEventAt > 15_000;
  const blocked = feed.snap?.market.spreadBlocked ?? [];
  const extras = ALL_BEES.filter((b) => !BEE_NAMES.includes(b));

  return (
    <div className="app">
      <Header snap={feed.snap} connected={feed.connected} stalled={stalled} soundOn={soundOn} onSound={toggleSound} />
      <main className="grid">
        {BEE_NAMES.map((name) => {
          const bee = feed.bees[name];
          return (
            <BeeColumn
              key={name}
              name={name}
              bee={bee}
              curve={feed.curves[name]}
              baseline={baseline}
              rank={board.indexOf(name) + 1}
              gap={bee ? Math.max(0, leaderEq - bee.equityUsd) : null}
              flash={feed.flashes[name]}
            />
          );
        })}
        <aside className="rail">
          <section className="rail-card board">
            <div className="rail-head">
              <span className="eyebrow">Leaderboard</span>
              <span className="dim">equity</span>
            </div>
            {board.map((name, i) => {
              const b = feed.bees[name];
              const width = b ? Math.max(4, (b.equityUsd / Math.max(leaderEq, 1)) * 100) : 0;
              return (
                <div className="board-row" key={name} style={{ ["--bee" as string]: beeMeta(name).color }}>
                  <span className="board-rank num">{i + 1}</span>
                  <img src={beeMeta(name).img} alt="" />
                  <span className="board-name">{beeMeta(name).short}</span>
                  <span className="board-bar">
                    <span style={{ width: `${width}%` }} />
                  </span>
                  <span className="board-eq num">{b ? money(b.equityUsd) : "–"}</span>
                </div>
              );
            })}
          </section>
          {extras.length > 0 && (
            <section className="rail-card challengers">
              <div className="rail-head">
                <span className="eyebrow">Challengers</span>
                <a className="dim" href="#/lab">
                  evolution ↗
                </a>
              </div>
              {extras.map((name) => {
                const b = feed.bees[name];
                const m = beeMeta(name);
                const t = b?.evo ? TIER_INFO[b.evo.tier] : null;
                return (
                  <div className="ch-row" key={name} style={{ ["--bee" as string]: m.color }}>
                    <span className="ch-dot" aria-hidden />
                    <span className="ch-name">{m.short}</span>
                    <span className={`ch-pos num ${b?.position ? b.position.side : "dim"}`}>{b?.position ? `${b.position.side === "long" ? "▲" : "▼"} ${b.position.coin}` : "flat"}</span>
                    <span className={`num ${b && b.pnlUsd >= 0 ? "good" : "bad"}`}>{b ? `${b.pnlPct >= 0 ? "+" : ""}${b.pnlPct.toFixed(1)}%` : "–"}</span>
                    {t && (
                      <span className={`ch-tier ${t.tone}`} title={`${t.label} · level ${b!.evo!.level}`}>
                        {t.icon} L{b!.evo!.level}
                      </span>
                    )}
                  </div>
                );
              })}
            </section>
          )}
          <Ticker decisions={feed.decisions} perMin={feed.decisionTimes.length} />
          {blocked.length > 0 && (
            <section className="rail-card blocked">
              <span className="eyebrow">Spread gate says no</span>
              <div className="blocked-list num">
                {blocked.slice(0, 6).map((b) => (
                  <span key={b.coin}>
                    {b.coin} <span className="dim">{b.spreadBp}bp</span>
                  </span>
                ))}
              </div>
            </section>
          )}
        </aside>
      </main>
      <Toasts toasts={feed.toasts} />
    </div>
  );
}
