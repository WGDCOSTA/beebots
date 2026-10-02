// One chart of a report, drawn as SVG from the data the server computed: candles with the averages, support and resistance,
// volume and RSI panels, and numbered marks the agent pointed at; or the agent's own equity line. The marks' prices are the
// real bars' (the server corrected any other claim), and the legend under the chart says what each mark shows.
import { axisPrice, axisTime, extent, indexAt, linePath, scale, ticks, type ChartData } from "./arenaChart";
import { useI18n } from "./i18n/I18n";

const W = 640;
const L = 8;
const R = 58;
const PW = W - L - R;
const MAIN_H = 230;
const VOL_H = 46;
const RSI_H = 60;
const GAP = 14;
const AXIS_H = 18;

function XAxis({ times, barMs, x, y, locale }: { times: number[]; barMs: number; x: (i: number) => number; y: number; locale: string }) {
  const n = times.length;
  const idx = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * (n - 1))).filter((v, i, a) => a.indexOf(v) === i);
  return (
    <g className="ch-axis">
      {idx.map((i, j) => (
        <text key={i} x={j === 0 ? L : j === idx.length - 1 ? L + PW : x(i)} y={y} textAnchor={j === 0 ? "start" : j === idx.length - 1 ? "end" : "middle"}>
          {axisTime(times[i]!, barMs, locale)}
        </text>
      ))}
    </g>
  );
}

export function ArenaChart({ chart }: { chart: ChartData }) {
  const { t, locale } = useI18n();
  const s = chart.series;
  const eq = chart.equity;
  const times = s ? s.bars.map((b) => b[0]) : (eq ?? []).map((p) => p[0]);
  const n = times.length;
  if (n < 2) return null;
  const showVol = !!s && chart.panels.includes("volume");
  const showRsi = !!s && chart.panels.includes("rsi");
  const mainTop = 8;
  const volTop = mainTop + MAIN_H + GAP;
  const rsiTop = volTop + (showVol ? VOL_H + GAP : 0);
  const bottom = rsiTop + (showRsi ? RSI_H : 0) + (showVol || showRsi ? 0 : 0);
  const totalH = (showRsi ? bottom : showVol ? volTop + VOL_H : mainTop + MAIN_H) + AXIS_H + 6;
  const step = PW / n;
  const x = (i: number) => L + step * (i + 0.5);

  const highs = s ? s.bars.map((b) => b[2]) : [];
  const lows = s ? s.bars.map((b) => b[3]) : [];
  const levelVals = s && chart.overlays.includes("levels") ? chart.levels.map((l) => l.px) : [];
  const [lo, hi] = s ? extent([...highs, ...lows, ...levelVals], 0.05) : extent((eq ?? []).map((p) => p[1]), 0.08);
  const y = scale(lo, hi, mainTop + MAIN_H, mainTop);
  const grid = ticks(lo, hi, 4);

  const marks = chart.marks.map((m, k) => {
    const i = indexAt(times, m.ts);
    // a high is pointed at from above and a low from below, so the marker never sits on the candle
    const dy = m.kind === "high" ? -14 : m.kind === "low" ? 14 : -14;
    const py = Math.max(mainTop + 10, Math.min(mainTop + MAIN_H - 10, y(m.px) + dy));
    return { k, m, i, cx: x(i), cy: py, ay: y(m.px) };
  });

  return (
    <figure className="ch-fig">
      <figcaption className="ch-title">
        <strong>{chart.title}</strong>
        {chart.symbol && <span className="dim small"> · {chart.symbol}</span>}
      </figcaption>
      <svg className="ch" viewBox={`0 0 ${W} ${totalH}`} role="img" aria-label={`${chart.title}. ${chart.caption}`}>
        {grid.map((g) => (
          <g key={g}>
            <line className="ch-grid" x1={L} x2={L + PW} y1={y(g)} y2={y(g)} />
            <text className="ch-axis" x={W - R + 6} y={y(g) + 4}>
              {axisPrice(g, locale)}
            </text>
          </g>
        ))}
        {s && (
          <>
            {s.bars.map((b, i) => {
              const up = b[4] >= b[1];
              return (
                <g key={b[0]} className={up ? "ch-up" : "ch-dn"}>
                  <line x1={x(i)} x2={x(i)} y1={y(b[2])} y2={y(b[3])} />
                  <rect x={x(i) - Math.max(step * 0.34, 0.6)} width={Math.max(step * 0.68, 1.2)} y={Math.min(y(b[1]), y(b[4]))} height={Math.max(Math.abs(y(b[1]) - y(b[4])), 1)} />
                </g>
              );
            })}
            {chart.overlays.includes("sma20") && <path className="ch-sma20" d={linePath(s.sma20, x, y)} />}
            {chart.overlays.includes("sma50") && <path className="ch-sma50" d={linePath(s.sma50, x, y)} />}
            {chart.overlays.includes("levels") &&
              chart.levels.map((l) => (
                <g key={`${l.kind}${l.px}`} className={`ch-level ${l.kind}`}>
                  <line x1={L} x2={L + PW} y1={y(l.px)} y2={y(l.px)} />
                  <text x={L + 4} y={y(l.px) - 3}>
                    {t(l.kind === "support" ? "rep.support" : "rep.resistance")} {axisPrice(l.px, locale)}
                  </text>
                </g>
              ))}
          </>
        )}
        {eq && (
          <>
            <path className="ch-eq-area" d={`${linePath(eq.map((p) => p[1]), x, y)}L${x(n - 1).toFixed(1)} ${mainTop + MAIN_H}L${x(0).toFixed(1)} ${mainTop + MAIN_H}Z`} />
            <path className="ch-eq" d={linePath(eq.map((p) => p[1]), x, y)} />
          </>
        )}
        {showVol && s && (
          <g>
            <text className="ch-axis" x={L + 2} y={volTop + 9}>
              {t("rep.volume")}
            </text>
            {(() => {
              const top = Math.max(...s.bars.map((b) => b[5]), 1);
              return s.bars.map((b, i) => {
                const h = (b[5] / top) * (VOL_H - 2);
                return <rect key={b[0]} className={b[4] >= b[1] ? "ch-vol-up" : "ch-vol-dn"} x={x(i) - Math.max(step * 0.34, 0.6)} width={Math.max(step * 0.68, 1.2)} y={volTop + VOL_H - h} height={Math.max(h, 0.5)} />;
              });
            })()}
          </g>
        )}
        {showRsi && s && (
          <g>
            <text className="ch-axis" x={L + 2} y={rsiTop + 9}>
              {t("rep.rsi")}
            </text>
            {[30, 70].map((v) => (
              <g key={v}>
                <line className="ch-grid dash" x1={L} x2={L + PW} y1={rsiTop + RSI_H - (v / 100) * RSI_H} y2={rsiTop + RSI_H - (v / 100) * RSI_H} />
                <text className="ch-axis" x={W - R + 6} y={rsiTop + RSI_H - (v / 100) * RSI_H + 4}>
                  {v}
                </text>
              </g>
            ))}
            <path className="ch-rsi" d={linePath(s.rsi, x, (v) => rsiTop + RSI_H - (v / 100) * RSI_H)} />
          </g>
        )}
        {marks.map(({ k, m, cx, cy, ay }) => (
          <g key={k} className={`ch-mark ${m.kind}`}>
            <line x1={cx} x2={cx} y1={cy + (cy < ay ? 8 : -8)} y2={ay} />
            <circle cx={cx} cy={cy} r="9" />
            <text x={cx} y={cy + 4} textAnchor="middle">
              {k + 1}
            </text>
          </g>
        ))}
        <XAxis times={times} barMs={chart.barMs || (times[1]! - times[0]!)} x={x} y={totalH - 4} locale={locale} />
      </svg>
      {chart.caption && <p className="ch-cap small">{chart.caption}</p>}
      {marks.length > 0 && (
        <ol className="ch-legend">
          {marks.map(({ k, m }) => (
            <li key={k}>
              <span className={`ch-n ${m.kind}`}>{k + 1}</span>
              <span>
                <strong>{m.label}</strong> <span className="num">{axisPrice(m.px, locale)}</span>
                {m.corrected && (
                  <span className="ch-fix" title={t("rep.correctedHelp")}>
                    {" "}
                    {t("rep.corrected")}
                  </span>
                )}
                {m.note && <span className="dim small"> — {m.note}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </figure>
  );
}
