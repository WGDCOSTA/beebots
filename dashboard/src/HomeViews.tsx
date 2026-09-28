// The home page's data views next to the live Overview: Market (every coin the bees can trade, with CoinMarketCap's
// view), Watchlists (the coins each bee's AI brains chose, and why) and Positions (everything open, across bees).
// Read-only: everything comes from the engine's snapshot.
import { useMemo, useState } from "react";
import { money } from "./BeeColumn";
import { ALL_BEES, beeMeta, type BoardCoin, type PublicBee, type Snapshot } from "./types";

export const VIEWS = [
  { id: "overview", label: "Overview" },
  { id: "market", label: "Market" },
  { id: "watchlists", label: "AI watchlists" },
  { id: "positions", label: "Positions" },
] as const;
export type ViewId = (typeof VIEWS)[number]["id"];

type Bees = Record<string, PublicBee | undefined>;

const pct = (x: number | null | undefined, dp = 2) => (x === null || x === undefined ? "–" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toFixed(dp)}%`);
const tone = (x: number | null | undefined) => (x === null || x === undefined || x === 0 ? "" : x > 0 ? "good" : "bad");
/** $1.2B, $340M, $12.4K */
export const compact = (x: number | null | undefined) => {
  if (x === null || x === undefined || !Number.isFinite(x)) return "–";
  const a = Math.abs(x);
  const [d, s] = a >= 1e12 ? [1e12, "T"] : a >= 1e9 ? [1e9, "B"] : a >= 1e6 ? [1e6, "M"] : a >= 1e3 ? [1e3, "K"] : [1, ""];
  return `$${(x / d).toFixed(a >= 1e3 && x / d < 100 ? 1 : 0)}${s}`;
};
const price = (x: number | null | undefined) => {
  if (x === null || x === undefined || !Number.isFinite(x)) return "–";
  const dp = x >= 1000 ? 2 : x >= 1 ? 3 : x >= 0.01 ? 5 : 7;
  return x.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
};
const ago = (ts: number | null | undefined) => {
  if (!ts) return "";
  const m = Math.max(0, Math.round((Date.now() - ts) / 60_000));
  return m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

/** The segmented control above the home page. Counts make each view's content visible before opening it. */
export function ViewTabs({ view, onView, snap, bees }: { view: ViewId; onView: (v: ViewId) => void; snap: Snapshot | null; bees: Bees }) {
  const open = ALL_BEES.reduce((n, b) => n + (bees[b]?.position ? 1 : 0) + (bees[b]?.legs?.length ?? 0), 0);
  const watching = ALL_BEES.filter((b) => bees[b]?.watchlist?.coins.length).length;
  const counts: Record<ViewId, string | null> = {
    overview: `${ALL_BEES.length} bees`,
    market: snap?.market.board ? `${snap.market.board.length} coins` : null,
    watchlists: `${watching}/${ALL_BEES.length}`,
    positions: `${open} open`,
  };
  return (
    <nav className="viewtabs" role="tablist" aria-label="Home views">
      {VIEWS.map((v) => (
        <button key={v.id} role="tab" aria-selected={view === v.id} className={`viewtab ${view === v.id ? "on" : ""}`} onClick={() => onView(v.id)}>
          {v.label}
          {counts[v.id] && <span className="viewtab-n num">{counts[v.id]}</span>}
        </button>
      ))}
    </nav>
  );
}

/** Stat tile: one number, what it is, and a line of context. */
function Tile({ label, value, sub, valueClass, children }: { label: string; value: string; sub?: string; valueClass?: string; children?: React.ReactNode }) {
  return (
    <div className="dv-tile">
      <span className="eyebrow">{label}</span>
      <span className={`dv-tile-value num ${valueClass ?? ""}`}>{value}</span>
      {children}
      {sub && <span className="dim small">{sub}</span>}
    </div>
  );
}

/** Which bees watch / hold each coin, from the snapshot. */
function coinOwners(bees: Bees) {
  const watch = new Map<string, string[]>();
  const held = new Map<string, Array<{ bee: string; side: "long" | "short" }>>();
  for (const b of ALL_BEES) {
    const pb = bees[b];
    for (const c of pb?.watchlist?.coins ?? []) watch.set(c, [...(watch.get(c) ?? []), b]);
    for (const p of [pb?.position, ...(pb?.legs ?? [])])
      if (p) held.set(p.coin.toUpperCase(), [...(held.get(p.coin.toUpperCase()) ?? []), { bee: b, side: p.side }]);
  }
  return { watch, held };
}

function BeeDots({ ids, title }: { ids: string[]; title: string }) {
  if (!ids.length) return <span className="dim">–</span>;
  return (
    <span className="bee-dots" title={`${title}: ${ids.map((b) => beeMeta(b).short).join(", ")}`}>
      {ids.map((b) => (
        <i key={b} style={{ background: beeMeta(b).color }} />
      ))}
    </span>
  );
}

type SortKey = "cmcRank" | "coin" | "px" | "ret1hPct" | "ret24hPct" | "ret7dPct" | "vol24hUsd" | "oiUsd" | "fundingPct" | "spreadBp" | "atrPct" | "rsi";
const COLS: Array<{ key: SortKey; label: string; title?: string }> = [
  { key: "cmcRank", label: "#", title: "CoinMarketCap rank" },
  { key: "coin", label: "Coin" },
  { key: "px", label: "Price" },
  { key: "ret1hPct", label: "1h" },
  { key: "ret24hPct", label: "24h" },
  { key: "ret7dPct", label: "7d" },
  { key: "vol24hUsd", label: "Vol 24h", title: "OKX 24h volume" },
  { key: "oiUsd", label: "Open int.", title: "Open interest" },
  { key: "fundingPct", label: "Funding", title: "Funding rate per period" },
  { key: "spreadBp", label: "Spread", title: "Bid-ask spread in basis points" },
  { key: "atrPct", label: "ATR", title: "15m ATR as % of price" },
  { key: "rsi", label: "RSI", title: "15m RSI(14)" },
];

export function MarketView({ snap, bees }: { snap: Snapshot | null; bees: Bees }) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"all" | "crypto" | "macro">("all");
  const [onlyWatched, setOnlyWatched] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "vol24hUsd", dir: -1 });
  const board = snap?.market.board ?? [];
  const cmc = snap?.system?.cmc ?? null;
  const { watch, held } = useMemo(() => coinOwners(bees), [bees]);

  const rows = useMemo(() => {
    const f = board.filter(
      (c) =>
        (!q || c.coin.includes(q.toUpperCase())) &&
        (kind === "all" || (kind === "crypto" ? c.kind === "crypto" : c.kind !== "crypto")) &&
        (!onlyWatched || watch.has(c.coin) || held.has(c.coin)),
    );
    const v = (c: BoardCoin) => c[sort.key];
    return [...f].sort((a, b) => {
      const x = v(a);
      const y = v(b);
      if (x === null) return 1;
      if (y === null) return -1;
      return (typeof x === "string" ? x.localeCompare(String(y)) : x - (y as number)) * sort.dir;
    });
  }, [board, q, kind, onlyWatched, sort, watch, held]);

  const moves = board.map((c) => c.ret24hPct).filter((x): x is number => x !== null);
  const up = moves.filter((x) => x > 0).length;
  const down = moves.filter((x) => x < 0).length;
  const median = moves.length ? [...moves].sort((a, b) => a - b)[Math.floor(moves.length / 2)]! : null;
  const vol = board.reduce((a, c) => a + c.vol24hUsd, 0);
  const macroCount = board.filter((c) => c.kind !== "crypto").length;

  return (
    <div className="dataview">
      <div className="dv-tiles">
        {cmc?.fearGreed ? (
          <Tile label="Fear & Greed" value={String(cmc.fearGreed.value)} sub={`${cmc.fearGreed.label} · CoinMarketCap`}>
            <span className="fg-meter" role="img" aria-label={`Fear and Greed ${cmc.fearGreed.value} of 100`}>
              <i style={{ left: `${Math.min(100, Math.max(0, cmc.fearGreed.value))}%` }} />
            </span>
            <span className="fg-scale dim small">
              <span>fear</span>
              <span>greed</span>
            </span>
          </Tile>
        ) : (
          <Tile label="Fear & Greed" value="–" sub="Add a CoinMarketCap key (Admin → API keys)" />
        )}
        <Tile label="BTC dominance" value={cmc?.btcDominancePct != null ? `${cmc.btcDominancePct}%` : "–"} sub="share of total crypto market cap" />
        <Tile
          label="Total market cap"
          value={compact(cmc?.totalMcapUsd)}
          valueClass=""
          sub={cmc?.mcapChange24hPct != null ? `${pct(cmc.mcapChange24hPct)} in 24h` : "CoinMarketCap"}
        />
        <Tile label="Breadth 24h" value={`${up} ▲ · ${down} ▼`} sub={`median move ${pct(median)} · ${board.length} coins`}>
          {moves.length > 0 && (
            <span className="breadth" aria-hidden>
              <i className="up" style={{ flexGrow: up }} />
              <i className="down" style={{ flexGrow: down }} />
            </span>
          )}
        </Tile>
        <Tile label="Volume 24h" value={compact(vol)} sub={`OKX perps in the bees' universe${macroCount ? ` · ${macroCount} macro` : ""}`} />
      </div>

      <div className="dv-filters">
        <input className="dv-search" placeholder="Search coin…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search coin" />
        <div className="seg" role="group" aria-label="Market">
          {(["all", "crypto", "macro"] as const).map((k) => (
            <button key={k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>
              {k === "all" ? "All" : k === "crypto" ? "Crypto" : "Stocks & commodities"}
            </button>
          ))}
        </div>
        <label className="dv-check">
          <input type="checkbox" checked={onlyWatched} onChange={(e) => setOnlyWatched(e.target.checked)} /> Watched or held by a bee
        </label>
        <span className="dim small dv-when">prices {snap ? ago(snap.market.refreshedAt) || "now" : "–"}</span>
      </div>

      <div className="dv-table-wrap">
        <table className="dv-table num">
          <thead>
            <tr>
              {COLS.map((c) => (
                <th
                  key={c.key}
                  title={c.title}
                  aria-sort={sort.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
                  className={c.key === "coin" ? "l" : ""}
                >
                  <button
                    onClick={() => setSort({ key: c.key, dir: sort.key === c.key ? (-sort.dir as 1 | -1) : c.key === "coin" || c.key === "cmcRank" ? 1 : -1 })}
                  >
                    {c.label}
                    {sort.key === c.key ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
                  </button>
                </th>
              ))}
              <th className="l">Watched by</th>
              <th className="l">Held</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.coin}>
                <td className="dim">{c.cmcRank ?? "–"}</td>
                <td className="l">
                  <span className="dv-coin">{c.coin}</span>
                  {c.kind !== "crypto" && <span className="dv-kind">{c.kind}</span>}
                  {c.mcapUsd ? <span className="dim small"> {compact(c.mcapUsd)}</span> : null}
                </td>
                <td>{price(c.px)}</td>
                <td className={tone(c.ret1hPct)}>{pct(c.ret1hPct)}</td>
                <td className={tone(c.ret24hPct)}>{pct(c.ret24hPct)}</td>
                <td className={tone(c.ret7dPct)}>{pct(c.ret7dPct, 1)}</td>
                <td>{compact(c.vol24hUsd)}</td>
                <td>{compact(c.oiUsd)}</td>
                <td title="Positive: longs pay shorts">{c.fundingPct === null ? "–" : `${c.fundingPct > 0 ? "+" : ""}${c.fundingPct.toFixed(4)}%`}</td>
                <td>{c.spreadBp === null ? "–" : `${c.spreadBp}bp`}</td>
                <td>{c.atrPct === null ? "–" : `${c.atrPct.toFixed(2)}%`}</td>
                <td className={c.rsi !== null && (c.rsi >= 70 || c.rsi <= 30) ? "strong" : ""}>{c.rsi ?? "–"}</td>
                <td className="l">
                  <BeeDots ids={watch.get(c.coin) ?? []} title="On the AI watchlist of" />
                </td>
                <td className="l">
                  {(held.get(c.coin) ?? []).map((h) => (
                    <span key={h.bee} className={`dv-held ${h.side}`} title={`${beeMeta(h.bee).short}: ${h.side}`}>
                      <i style={{ background: beeMeta(h.bee).color }} />
                      {h.side === "long" ? "▲" : "▼"}
                    </span>
                  ))}
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={COLS.length + 2} className="dim l">
                  {board.length ? "No coin matches these filters." : "The market loads a few seconds after the engine starts."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function WatchlistsView({ snap, bees }: { snap: Snapshot | null; bees: Bees }) {
  const on = snap?.system?.watchlist ?? false;
  const board = new Map((snap?.market.board ?? []).map((c) => [c.coin, c]));
  const coins = [...new Set(ALL_BEES.flatMap((b) => bees[b]?.watchlist?.coins ?? []))].sort(
    (a, b) => (board.get(b)?.vol24hUsd ?? 0) - (board.get(a)?.vol24hUsd ?? 0),
  );
  const item = (b: string, c: string) =>
    bees[b]?.watchlist?.items?.find((i) => i.coin === c) ??
    (bees[b]?.watchlist?.coins.includes(c) ? { coin: c, reason: "", probation: !!bees[b]?.watchlist?.probation.includes(c), addedAt: null } : null);

  return (
    <div className="dataview">
      <p className="dv-intro">
        Each bee's LLM brains choose the coins it trades, from lab backtests, the bee's real record, live liquidity
        {snap?.system?.cmc ? " and CoinMarketCap's rank and volume" : ""}. The council, the coach and survival councils update the list; the engine then offers
        Jev <b>only</b> these coins. A coin marked
        <span className="wl-trial"> trial </span>trades at half size until the coach keeps it.{" "}
        {on ? "" : "AI watchlists are off (BRAIN_WATCHLIST=false): every bee trades its style's normal coins."}
      </p>

      {coins.length > 0 && (
        <div className="dv-table-wrap">
          <table className="dv-table wl-matrix num">
            <thead>
              <tr>
                <th className="l">Coin</th>
                <th>24h</th>
                <th>Vol 24h</th>
                {ALL_BEES.map((b) => (
                  <th key={b} className="wl-bee" title={beeMeta(b).short}>
                    <img src={beeMeta(b).img} alt="" />
                    <span>{beeMeta(b).short}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {coins.map((c) => (
                <tr key={c}>
                  <td className="l">
                    <span className="dv-coin">{c}</span>
                  </td>
                  <td className={tone(board.get(c)?.ret24hPct)}>{pct(board.get(c)?.ret24hPct)}</td>
                  <td>{compact(board.get(c)?.vol24hUsd)}</td>
                  {ALL_BEES.map((b) => {
                    const it = item(b, c);
                    return (
                      <td
                        key={b}
                        className="wl-cell"
                        title={it ? `${beeMeta(b).short}: ${it.reason || "chosen by its brains"}${it.probation ? " (trial, half size)" : ""}` : ""}
                      >
                        {it ? (
                          <span className={`wl-mark ${it.probation ? "trial" : ""}`} style={{ ["--bee" as string]: beeMeta(b).color }}>
                            {it.probation ? "◐" : "●"}
                          </span>
                        ) : (
                          <span className="dim">·</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="wl-cards">
        {ALL_BEES.map((b) => {
          const pb = bees[b];
          const m = beeMeta(b);
          const items =
            pb?.watchlist?.items ??
            pb?.watchlist?.coins.map((c) => ({ coin: c, reason: "", probation: pb.watchlist!.probation.includes(c), addedAt: null })) ??
            [];
          return (
            <section key={b} className="wl-card" style={{ ["--bee" as string]: m.color }}>
              <header>
                <img src={m.img} alt="" />
                <div>
                  <strong>{m.short}</strong>
                  <span className="dim small">
                    {pb?.brain ? `brain: ${pb.brain.id}${pb.brain.online ? "" : " (offline: rules pick)"}` : ""}
                    {pb?.method ? ` · method ${pb.method.kind === "own" ? pb.method.id : (pb.method.name ?? pb.method.id)}` : ""}
                  </span>
                </div>
                <span className="wl-count num">{items.length ? `${items.length} coins` : "style default"}</span>
              </header>
              {items.length ? (
                <ul>
                  {items.map((i) => (
                    <li key={i.coin}>
                      <span className="dv-coin">{i.coin}</span>
                      {i.probation && <span className="wl-trial">trial</span>}
                      <span className="wl-reason">{i.reason || "chosen by its brains"}</span>
                      {i.addedAt ? <span className="dim small num">{ago(i.addedAt)}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="dim small">
                  {m.coins.length
                    ? `Trades the owner's coins: ${m.coins.join(", ")}.`
                    : "No AI watchlist yet: it trades its style's normal coins until a council picks some."}
                </p>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

export function PositionsView({ bees }: { bees: Bees }) {
  const rows = ALL_BEES.flatMap((b) => {
    const pb = bees[b];
    if (!pb) return [];
    const main = pb.position ? [{ bee: b, leg: false, ...pb.position, uplUsd: pb.position.uplUsd as number | null, r: pb.uplR ?? null }] : [];
    const legs = (pb.legs ?? []).map((l) => ({ bee: b, leg: true, ...l, r: null as number | null }));
    return [...main, ...legs];
  });
  const gross = rows.reduce((a, r) => a + (r.sizeUsd ?? 0), 0);
  const upl = rows.reduce((a, r) => a + (r.uplUsd ?? 0), 0);
  const longUsd = rows.filter((r) => r.side === "long").reduce((a, r) => a + (r.sizeUsd ?? 0), 0);
  const inPos = new Set(rows.map((r) => r.bee)).size;
  const toStop = (r: (typeof rows)[number]) =>
    r.stopPx && r.markPx ? ((r.side === "long" ? r.markPx - r.stopPx : r.stopPx - r.markPx) / r.markPx) * 100 : null;

  return (
    <div className="dataview">
      <div className="dv-tiles">
        <Tile label="Open positions" value={String(rows.length)} sub={`${inPos} of ${ALL_BEES.length} bees in the market`} />
        <Tile
          label="Gross exposure"
          value={money(gross, 0)}
          sub={gross ? `${Math.round((longUsd / gross) * 100)}% long · ${Math.round(((gross - longUsd) / gross) * 100)}% short` : "all flat"}
        />
        <Tile label="Unrealised P&L" value={`${upl >= 0 ? "+" : "−"}${money(Math.abs(upl))}`} valueClass={tone(upl)} sub="marked at the mid" />
      </div>

      <div className="dv-table-wrap">
        <table className="dv-table num">
          <thead>
            <tr>
              <th className="l">Bee</th>
              <th className="l">Coin</th>
              <th className="l">Side</th>
              <th>Size</th>
              <th>Entry</th>
              <th>Mark</th>
              <th>Stop</th>
              <th title="How far the price is from the stop">To stop</th>
              <th>uP&amp;L</th>
              <th title="Unrealised P&L in units of the risk taken at entry">R</th>
              <th>Held</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.bee}-${r.coin}-${r.leg}`}>
                <td className="l">
                  <span className="dv-beename" style={{ ["--bee" as string]: beeMeta(r.bee).color }}>
                    <i />
                    {beeMeta(r.bee).short}
                  </span>
                </td>
                <td className="l">
                  <span className="dv-coin">{r.coin}</span>
                  {r.leg && <span className="dv-kind">leg</span>}
                </td>
                <td className={`l ${r.side === "long" ? "good" : "bad"}`}>{r.side === "long" ? "▲ long" : "▼ short"}</td>
                <td>{r.sizeUsd === null ? "–" : money(r.sizeUsd, 0)}</td>
                <td>{price(r.entryPx)}</td>
                <td>{price(r.markPx)}</td>
                <td>{price(r.stopPx)}</td>
                <td>{toStop(r) === null ? "–" : `${toStop(r)!.toFixed(2)}%`}</td>
                <td className={tone(r.uplUsd)}>{r.uplUsd === null ? "–" : `${r.uplUsd >= 0 ? "+" : "−"}${money(Math.abs(r.uplUsd))}`}</td>
                <td className={tone(r.r)}>{r.r === null ? "–" : `${r.r > 0 ? "+" : ""}${r.r.toFixed(2)}R`}</td>
                <td className="dim">{r.minutesHeld < 60 ? `${r.minutesHeld}m` : `${(r.minutesHeld / 60).toFixed(1)}h`}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={11} className="dim l">
                  Every bee is flat right now.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h3 className="dv-h">Exposure vs cap</h3>
      <div className="dv-exposure">
        {ALL_BEES.map((b) => {
          const pb = bees[b];
          const e = pb?.exposureUsd ?? 0;
          const cap = pb?.maxNotionalUsd ?? 0;
          const w = cap > 0 ? Math.min(100, (e / cap) * 100) : 0;
          return (
            <div key={b} className="dv-exp-row" style={{ ["--bee" as string]: beeMeta(b).color }}>
              <span className="dv-beename">
                <i />
                {beeMeta(b).short}
              </span>
              <span className="dv-exp-bar" role="img" aria-label={`${Math.round(w)}% of cap`}>
                <span style={{ width: `${w}%` }} />
              </span>
              <span className="num">
                {money(e, 0)} <span className="dim">/ {money(cap, 0)}</span>
              </span>
              <span className="dim num small">{pb?.slots && pb.slots > 1 ? `${(pb.position ? 1 : 0) + (pb.legs?.length ?? 0)}/${pb.slots} slots` : ""}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
