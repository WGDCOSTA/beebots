import { EquityChart } from "./EquityChart";
import { BRAIN_LABEL } from "./panelTypes";
import { beeMeta, TIER_INFO, type BeeName, type PublicBee } from "./types";
import type { Curve, FeedState } from "./useFeed";

const CAP_LABEL: Record<string, string> = { trade_cap: "BENCHED", fee_budget: "BENCHED", loss_stop: "SENT HOME", retired: "RETIRED" };

export const money = (x: number, d = 2) => `${x < 0 ? "−" : ""}$${Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
export const signed = (x: number, d = 2) => `${x >= 0 ? "+" : "−"}$${Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const px = (x: number | null | undefined) =>
  x === null || x === undefined ? "–" : x >= 1000 ? x.toLocaleString("en-US", { maximumFractionDigits: 1 }) : x >= 1 ? x.toFixed(3) : x.toPrecision(4);

function Delta({ usd, pct }: { usd: number; pct?: number }) {
  const up = usd >= 0;
  return (
    <span className={up ? "good" : "bad"}>
      {up ? "▲" : "▼"} {signed(usd)}
      {pct !== undefined && <span className="dim"> ({up ? "+" : "−"}{Math.abs(pct).toFixed(2)}%)</span>}
    </span>
  );
}

function Meter({ label, value, max, text }: { label: string; value: number; max: number; text: string }) {
  const frac = Math.max(0, Math.min(1, max > 0 ? value / max : 0));
  return (
    <div className="meter">
      <div className="meter-head">
        <span>{label}</span>
        <span className="num">{text}</span>
      </div>
      <div className="meter-track">
        <div className={`meter-fill ${frac >= 1 ? "full" : frac >= 0.75 ? "warn" : ""}`} style={{ width: `${frac * 100}%` }} />
      </div>
    </div>
  );
}

export function ProbBars({ top3, choice, color, big }: { top3: Array<[string, number]>; choice: string | null; color: string; big?: boolean }) {
  return (
    <div className={`probs ${big ? "big" : ""}`}>
      {top3.map(([label, p]) => (
        <div className={`prob ${label === choice ? "chosen" : ""}`} key={label}>
          <span className="prob-label">{label}</span>
          <span className="prob-track">
            <span className="prob-fill" style={{ width: `${Math.max(2, p * 100)}%`, background: label === choice ? color : "var(--muted-bar)" }} />
          </span>
          <span className="prob-p num">{Math.round(p * 100)}%</span>
        </div>
      ))}
    </div>
  );
}

/** One line of technical facts: brain, market, level/points, health, slots, R. */
function TechStrip({ bee }: { bee: PublicBee }) {
  const b = bee.brain;
  const e = bee.evo;
  const used = (bee.position ? 1 : 0) + (bee.legs?.length ?? 0);
  return (
    <div className="tech-strip num">
      {b && (
        <span className={`chip-t ${b.online ? "" : "off"}`} title={b.online ? `${BRAIN_LABEL[b.id] ?? b.id} plans for this bee (${b.model})` : "No key or sign-in: a rules pick plans for this bee"}>
          <i className={`dot ${b.online ? "on" : ""}`} />
          {BRAIN_LABEL[b.id] ?? b.id}
          {b.online && b.model ? <em> {b.model}</em> : <em> rules</em>}
        </span>
      )}
      {bee.method && bee.method.kind !== "own" && (
        <span className="chip-t method" title={`Specialisation its brains chose${bee.method.since ? ` (since ${new Date(bee.method.since).toISOString().slice(0, 16).replace("T", " ")} UTC)` : ""}`}>
          METHOD {bee.method.kind === "skill" ? (bee.method.name ?? bee.method.id) : bee.method.id}
        </span>
      )}
      {bee.market && bee.market !== "crypto" && <span className="chip-t macro">MACRO · {bee.market}</span>}
      {e && (
        <span className="chip-t" title={`${e.points} points · health ${e.health}% of start`}>
          L{e.level} <em>{e.points}pts</em> <em>{e.health}%</em>
        </span>
      )}
      {(bee.slots ?? 1) > 1 && (
        <span className="chip-t multi" title="Multi-orders: positions held / positions its performance allows">
          POS {used}/{bee.slots}
        </span>
      )}
      {bee.uplR != null && <span className={`chip-t ${bee.uplR >= 0 ? "good" : "bad"}`}>{bee.uplR >= 0 ? "+" : ""}{bee.uplR.toFixed(2)}R</span>}
    </div>
  );
}

/** Every position the bee holds (main first, then multi-order legs), as a compact table. */
function PositionsTable({ bee }: { bee: PublicBee }) {
  const rows = [...(bee.position ? [{ ...bee.position, main: true }] : []), ...(bee.legs ?? []).map((l) => ({ ...l, main: false }))];
  if (rows.length < 2) return null;
  return (
    <table className="pos-table num">
      <thead>
        <tr>
          <th />
          <th>coin</th>
          <th>size</th>
          <th>entry → mark</th>
          <th>stop</th>
          <th>uPnL</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.coin}>
            <td className={`side ${r.side}`}>{r.side === "long" ? "▲" : "▼"}</td>
            <td>
              {r.coin}
              {!r.main && <span className="leg-tag">leg</span>}
            </td>
            <td>{r.sizeUsd !== null ? money(r.sizeUsd, 0) : "–"}</td>
            <td className="dim">
              {px(r.entryPx)} → {px(r.markPx)}
            </td>
            <td className="dim">{px(r.stopPx)}</td>
            <td className={r.uplUsd !== null && r.uplUsd >= 0 ? "good" : "bad"}>{r.uplUsd !== null ? signed(r.uplUsd) : "–"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface Props {
  name: BeeName;
  bee: PublicBee | undefined;
  curve: Curve | undefined;
  baseline: number;
  rank: number;
  gap: number | null;
  flash: FeedState["flashes"][BeeName];
}

export function BeeColumn({ name, bee, curve, baseline, rank, gap, flash }: Props) {
  const meta = beeMeta(name);
  const p = bee?.position ?? null;
  const flashing = flash && Date.now() - flash.at < 2500;
  const cap = bee?.cap ?? null;

  return (
    <section className={`bee ${flashing ? `flash-${flash.kind}` : ""}`} style={{ ["--bee" as string]: meta.color, ["--bee-glow" as string]: meta.glow }}>
      <header className="bee-head">
        <div className="portrait">
          <img src={meta.img} alt={`${meta.title} portrait`} />
        </div>
        <div className="bee-id">
          <div className="bee-name">{meta.title}</div>
          <div className="bee-tag">
            {meta.tagline || meta.styleLabel}
            {meta.coins.length > 0 && <span className="bee-coins"> · {meta.coins.join(" ")}</span>}
            {meta.tagline && <span className="bee-style"> · {meta.styleLabel}</span>}
          </div>
          {meta.rules && (
            <div className="bee-rules" title={meta.rules}>
              {meta.rules}
            </div>
          )}
        </div>
        <div className="rank">
          <div className="rank-n">#{rank}</div>
          {bee?.evo && (
            <div className={`evo-badge ${TIER_INFO[bee.evo.tier].tone}`} title={`${TIER_INFO[bee.evo.tier].label}: health ${bee.evo.health}% of start · ${bee.evo.points} points`}>
              {TIER_INFO[bee.evo.tier].icon} {TIER_INFO[bee.evo.tier].label} · L{bee.evo.level}
            </div>
          )}
          {bee?.watchlist && (
            <div className="watch-badge small" title={`Coins its AI brains chose${bee.watchlist.probation.length ? `; on trial at half size: ${bee.watchlist.probation.join(", ")}` : ""}`}>
              👁 {bee.watchlist.coins.join(" · ")}
            </div>
          )}
          {gap !== null && <div className="rank-gap num">{gap === 0 ? "leading" : `${money(gap)} behind`}</div>}
        </div>
      </header>

      {bee && <TechStrip bee={bee} />}

      <div className="equity">
        <div className="equity-value num">{bee ? money(bee.equityUsd) : "–"}</div>
        {bee && <Delta usd={bee.pnlUsd} pct={bee.pnlPct} />}
      </div>

      {/* In the flow, never over the equity figure. */}
      {cap && (
        <div className="cap-banner" role="status">
          <div className="cap-title">{CAP_LABEL[cap]}</div>
          <div className="cap-detail">{bee?.last?.status}</div>
        </div>
      )}
      <div className={`position ${p ? p.side : "flat"}`}>
        {p ? (
          <>
            <div className="pos-main">
              <span className={`side ${p.side}`}>{p.side === "long" ? "▲ LONG" : "▼ SHORT"}</span>
              <span className="pos-coin">{p.coin}</span>
              {bee?.legs?.length ? <span className="leg-count num">+{bee.legs.length} leg{bee.legs.length > 1 ? "s" : ""}</span> : null}
              <span className="pos-size num">{p.sizeUsd !== null ? money(p.sizeUsd, 0) : ""}</span>
            </div>
            <div className="pos-upl num">
              <Delta usd={p.uplUsd} />
              <span className="dim"> unrealised · {p.minutesHeld}m held</span>
            </div>
            <div className="pos-px num dim">
              entry {px(p.entryPx)} → mark {px(p.markPx)} · stop {px(p.stopPx)}
            </div>
          </>
        ) : (
          <div className="pos-main">
            <span className="side flat">FLAT</span>
            <span className="dim">{bee?.flatMinutes ?? 0}m in cash</span>
          </div>
        )}
      </div>

      {bee && <PositionsTable bee={bee} />}

      <EquityChart curve={curve ?? []} color={meta.color} baseline={baseline} gradientId={`g-${name}`} />

      <div className="last">
        <div className="last-head">
          <span className="eyebrow">Jev’s last call</span>
          {bee?.last?.latencyMs != null && <span className="dim num">{bee.last.latencyMs} ms</span>}
        </div>
        {cap === "trade_cap" || cap === "fee_budget" ? (
          <div className="dim">sitting out while benched: nothing Jev picks could be acted on until 00:00 UTC</div>
        ) : bee?.last?.required ? (
          <div className="required-call">
            <span className="required-choice">{bee.last.choice}</span>
            <span className="dim">required by the rules · Jev not asked</span>
          </div>
        ) : bee?.last?.top3.length ? (
          <ProbBars top3={bee.last.top3} choice={bee.last.choice} color={meta.color} big />
        ) : (
          <div className="dim">waiting…</div>
        )}
        <div className="status">{bee?.last?.status ?? ""}</div>
      </div>

      <div className="meters">
        <Meter label="Trades today" value={bee?.tradesToday ?? 0} max={bee?.maxTradesPerDay ?? 1} text={`${bee?.tradesToday ?? 0} / ${bee?.maxTradesPerDay ?? "–"}`} />
        <Meter label="Fee budget" value={bee?.feesTodayUsd ?? 0} max={bee?.feeBudgetUsd ?? 1} text={`${money(bee?.feesTodayUsd ?? 0)} / ${money(bee?.feeBudgetUsd ?? 0)}`} />
        <Meter
          label="Exposure vs cap"
          value={bee?.exposureUsd ?? 0}
          max={bee?.maxNotionalUsd ?? 1}
          text={`${money(bee?.exposureUsd ?? 0, 0)} / ${money(bee?.maxNotionalUsd ?? 0, 0)}`}
        />
      </div>

      <div className="costs num">
        <div>
          <span className="eyebrow">fees</span>
          {money(bee?.totals.feesUsd ?? 0)}
        </div>
        <div>
          <span className="eyebrow">funding</span>
          {signed(bee?.totals.fundingUsd ?? 0)}
        </div>
        <div>
          <span className="eyebrow">Jev</span>
          {money(bee?.totals.jevUsd ?? 0, 4)}
        </div>
        <div>
          <span className="eyebrow">calls</span>
          {(bee?.totals.decisions ?? 0).toLocaleString()}
        </div>
      </div>

      {flashing && flash.kind === "funding" && <div className="funding-chip num">{flash.text}</div>}
    </section>
  );
}
