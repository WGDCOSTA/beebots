import type { WatchItem } from "./panelTypes";

/** The coins a bee's brains chose, as chips (reason on hover, probation marked). */
export function WatchChips({ items }: { items: WatchItem[] }) {
  return (
    <div className="chips watch-chips">
      {items.map((w) => (
        <span key={w.coin} className={`chip on${w.probation ? " probation" : ""}`} title={`${w.reason}${w.probation ? " (on probation: half size until the coach keeps it)" : ""}`}>
          {w.coin}
          {w.probation && <span className="small"> · trial</span>}
        </span>
      ))}
    </div>
  );
}
