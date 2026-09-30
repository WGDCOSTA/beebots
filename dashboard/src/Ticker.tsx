import { memo, useEffect, useMemo, useState } from "react";
import { ago, groupDecisions, humanLabel, type Item } from "./tickerModel";
import { beeMeta, type DecisionEvent } from "./types";

const signed = (x: number) => `${x >= 0 ? "+" : "−"}$${Math.abs(x).toFixed(2)}`;

function Odds({ d, color }: { d: DecisionEvent; color: string }) {
  const top = d.probabilities.slice(0, 3);
  if (!top.length) return null;
  return (
    <div className="tk-odds">
      <div className="tk-odds-bar" role="img" aria-label={top.map((p) => `${humanLabel(p.label)} ${Math.round(p.p * 100)}%`).join(", ")}>
        {top.map((p) => (
          <span key={p.label} style={{ flexGrow: Math.max(p.p, 0.02), background: p.label === d.choice ? color : "var(--muted-bar)" }} />
        ))}
      </div>
      <ul className="tk-odds-legend">
        {top.map((p) => (
          <li key={p.label} className={p.label === d.choice ? "chosen" : ""} title={p.label}>
            {humanLabel(p.label)} <span className="num">{Math.round(p.p * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const Row = memo(function Row({ item, now }: { item: Item<DecisionEvent>; now: number }) {
  const { d, n, since } = item;
  const meta = beeMeta(d.bee);
  const acted = d.action !== "hold";
  const live = d.live;
  const move = live ? (live.deltaUsd > 0 ? "up" : live.deltaUsd < 0 ? "down" : "still") : "still";
  // Jev's probability for the label it chose (not its separate "confidence" score), so it matches the odds bar.
  const pChoice = d.probabilities.find((p) => p.label === d.choice)?.p ?? null;
  const asked = !d.required && !d.watch && !d.pulse;
  return (
    <li className={`tk ${acted ? "acted" : ""} ${d.pulse ? "pulse" : ""} move-${move}`} style={{ ["--bee" as string]: meta.color }}>
      <div className="tk-head">
        <span className="tk-dot" aria-hidden />
        <span className="tk-name" title={meta.short}>
          {meta.short}
        </span>
        {n > 1 && (
          <span className="tk-count num" title={`Same call ${n} times in a row, since ${ago(since, now)} ago`}>
            ×{n}
          </span>
        )}
        <span className="tk-time num dim" title={d.latencyMs !== null ? `Jev answered in ${d.latencyMs} ms` : undefined}>
          {ago(d.ts, now)}
        </span>
      </div>
      <div className="tk-main">
        <span className="tk-action">{humanLabel(d.choice, d.jev)}</span>
        {asked && pChoice !== null && (
          <span className="tk-sure num" title="How sure Jev was about this choice">
            {Math.round(pChoice * 100)}% sure
          </span>
        )}
        {live && (
          <span className={`tk-pnl num ${live.valueUsd >= 0 ? "good" : "bad"}`} title={live.kind === "open" ? "Profit or loss on the open position" : "Total profit or loss so far"}>
            <small>{live.kind === "open" ? "open P&L" : "total P&L"}</small> {live.valueUsd >= 0 ? "▲" : "▼"} {signed(live.valueUsd)}
          </span>
        )}
      </div>
      {d.required ? (
        <div className="tk-detail">
          <span className="tk-tag">Rules</span>
          <span className="dim">Only one legal move, so Jev was not asked.</span>
        </div>
      ) : d.watch ? (
        <div className="tk-detail">
          <span className="tk-tag">Watching</span>
          <span>{d.watch}</span>
        </div>
      ) : d.pulse && live ? (
        <div className="tk-detail">
          <span className={`tk-tag ${live.side ?? "flat"}`}>{live.side === "long" ? "▲ Long" : live.side === "short" ? "▼ Short" : "Flat"}</span>
          <span className="dim">Benched: Jev sits out.</span>
          <span className={`tk-delta num ${move}`}>{move === "still" ? "±$0.00" : signed(live.deltaUsd)}</span>
        </div>
      ) : (
        <Odds d={d} color={meta.color} />
      )}
      {!d.pulse && (d.vetoedBy || d.forcedBy || acted) && (
        <div className={`tk-note ${d.forcedBy ? "forced" : d.vetoedBy ? "veto" : "act"}`}>
          {d.forcedBy ? `⚡ Code forced: ${humanLabel(d.action)}` : d.vetoedBy ? `✋ Blocked by the risk rules: ${d.vetoedBy}` : `→ ${humanLabel(d.action)}`}
        </div>
      )}
    </li>
  );
});

export function Ticker({ decisions, perMin }: { decisions: DecisionEvent[]; perMin: number }) {
  // A slow clock for the relative times; the rows themselves are memoised and only re-render when this ticks.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);
  const items = useMemo(() => groupDecisions(decisions), [decisions]);
  return (
    <section className="rail-card ticker">
      <div className="rail-head">
        <span className="eyebrow">Decision stream</span>
        <span className="num dim">{perMin}/min</span>
      </div>
      <p className="tk-help dim">What each bunny just decided, newest first. Repeated calls are grouped (×3).</p>
      <ol className="ticks">
        {items.map((it) => (
          <Row key={`${it.d.ts}-${it.d.bee}`} item={it} now={now} />
        ))}
      </ol>
    </section>
  );
}
