// One market feed for every bunny the Arena runs. Each engine asks for a refresh on its own clock; left alone, a hundred
// engines would hit the exchange a hundred times a minute. This wraps the real feed so concurrent asks share one call and
// an ask inside the minimum gap is answered from what is already loaded.
import type { MarketFeed } from "../market/data.js";

export function sharedFeed(feed: MarketFeed, minGapMs = 15_000, tickerGapMs = 2_000): MarketFeed {
  let inflight: Promise<void> | null = null;
  let tickersInflight: Promise<void> | null = null;
  let lastStart = Number.NEGATIVE_INFINITY;
  let lastTickers = Number.NEGATIVE_INFINITY;
  const shared = {
    get lastRefreshAt() {
      return feed.lastRefreshAt;
    },
    view: () => feed.view(),
    candles1h: (i: string) => feed.candles1h(i),
    candles1m: (i: string) => feed.candles1m(i),
    instIdForCoin: (c: string) => feed.instIdForCoin(c),
    refresh(now = Date.now()): Promise<void> {
      if (inflight) return inflight;
      if (feed.lastRefreshAt > 0 && now - lastStart < minGapMs) return Promise.resolve();
      lastStart = now;
      inflight = feed.refresh(now).finally(() => {
        inflight = null;
      });
      return inflight;
    },
    refreshTickers(): Promise<void> {
      if (tickersInflight) return tickersInflight;
      const now = Date.now();
      if (now - lastTickers < tickerGapMs) return Promise.resolve();
      lastTickers = now;
      tickersInflight = feed.refreshTickers().finally(() => {
        tickersInflight = null;
      });
      return tickersInflight;
    },
    refreshScalp: () => Promise.resolve(),
  };
  return shared as unknown as MarketFeed;
}
