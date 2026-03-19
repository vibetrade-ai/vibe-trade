import type { BrokerAdapter } from "../brokers/types.js";
import type { Trigger, SystemSnapshot, QuoteEntry, PositionEntry } from "./types.js";
import { getMarketStatus } from "../market-calendar.js";

export async function buildSnapshot(broker: BrokerAdapter, triggers: Trigger[]): Promise<SystemSnapshot> {
  const status = getMarketStatus();
  const capturedAt = new Date().toISOString();
  const isMarketActive = status.session === "pre_market"
    || status.session === "open"
    || status.session === "post_market";

  // Build watchlist (equity symbols only for getQuote)
  const watchSymbols = new Set<string>(triggers.flatMap(t => t.watchSymbols));
  // Remove index names and wildcards from equity watchlist
  const indexNames = new Set(["NIFTY50", "BANKNIFTY", "NIFTY", "NIFTYBANK"]);
  const equitySymbols = [...watchSymbols].filter(s => s !== "*" && !indexNames.has(s.toUpperCase()));

  // Always fetch NIFTY50 and BANKNIFTY as index symbols
  const allSymbolsToFetch = isMarketActive
    ? [...equitySymbols, "NIFTY50", "BANKNIFTY"]
    : [];

  const [positionsSettled, fundsSettled, quotesSettled] = await Promise.allSettled([
    broker.getPositions(),
    broker.getFunds(),
    allSymbolsToFetch.length > 0
      ? broker.getQuote(allSymbolsToFetch)
      : Promise.resolve([]),
  ]);

  // Parse quotes
  const quotes: Record<string, QuoteEntry> = {};
  let nifty50: QuoteEntry | null = null;
  let banknifty: QuoteEntry | null = null;

  if (quotesSettled.status === "fulfilled") {
    for (const q of quotesSettled.value) {
      const entry: QuoteEntry = {
        symbol: q.symbol.toUpperCase(),
        securityId: "",
        lastPrice: q.lastPrice,
        previousClose: q.previousClose,
        changePercent: q.changePercent,
        open: q.open,
        high: q.high,
        low: q.low,
      };
      quotes[entry.symbol] = entry;
      if (entry.symbol === "NIFTY50") nifty50 = entry;
      else if (entry.symbol === "BANKNIFTY") banknifty = entry;
    }
  }

  // Parse positions
  const positions: PositionEntry[] = [];
  if (positionsSettled.status === "fulfilled") {
    for (const p of positionsSettled.value) {
      positions.push({
        symbol: p.symbol,
        quantity: p.quantity,
        avgCostPrice: p.avgEntryPrice,
        lastPrice: p.lastPrice,
        unrealizedPnl: p.unrealizedPnl,
        pnlPercent: p.avgEntryPrice
          ? +((p.lastPrice - p.avgEntryPrice) / p.avgEntryPrice * 100).toFixed(2)
          : 0,
      });
    }
  }

  // Parse funds
  let funds: { availableBalance: number; usedMargin: number } | null = null;
  if (fundsSettled.status === "fulfilled") {
    funds = {
      availableBalance: fundsSettled.value.cash.available,
      usedMargin: fundsSettled.value.cash.used,
    };
  }

  return {
    capturedAt,
    marketStatus: { phase: status.session, istTime: status.time_ist },
    quotes,
    positions,
    funds,
    nifty50,
    banknifty,
  };
}
