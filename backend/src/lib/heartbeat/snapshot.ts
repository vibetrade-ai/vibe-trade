import type { DhanClient } from "../dhan/client.js";
import type { Trigger, SystemSnapshot, QuoteEntry, PositionEntry } from "./types.js";
import { getMarketStatus } from "../market-calendar.js";
import { getSecurityId } from "../dhan/instruments.js";

export async function buildSnapshot(dhan: DhanClient, triggers: Trigger[]): Promise<SystemSnapshot> {
  const status = getMarketStatus();
  const capturedAt = new Date().toISOString();
  const isMarketActive = status.session === "pre_market"
    || status.session === "open"
    || status.session === "post_market";

  // Build watchlist (equity symbols only for getQuote)
  const watchSymbols = new Set<string>(triggers.flatMap(t => t.watchSymbols));
  // Remove index names from equity watchlist
  const indexNames = new Set(["NIFTY50", "BANKNIFTY", "NIFTY", "NIFTYBANK"]);
  const equitySymbols = [...watchSymbols].filter(s => !indexNames.has(s.toUpperCase()));

  // When market is closed, skip live quote fetches — they return stale/zero data.
  // Positions and funds are account data and are always worth fetching.
  const [positionsRaw, fundsRaw, equityQuotesRaw, indexQuotesRaw] = await Promise.allSettled([
    dhan.getPositions(),
    dhan.getFunds(),
    isMarketActive && equitySymbols.length > 0
      ? (async () => {
          // Resolve security IDs for equity symbols
          const secIdMap: Record<string, string> = {};
          await Promise.all(equitySymbols.map(async (sym) => {
            try { secIdMap[sym] = await getSecurityId(sym); } catch {}
          }));
          const ids = Object.values(secIdMap).filter(Boolean);
          if (ids.length === 0) return null;
          return { result: await dhan.getQuote(ids, "NSE_EQ"), secIdMap };
        })()
      : Promise.resolve(null),
    isMarketActive ? dhan.getQuote(["13", "25"], "IDX_I") : Promise.resolve(null),
  ]);

  // Parse quotes
  const quotes: Record<string, QuoteEntry> = {};

  if (equityQuotesRaw.status === "fulfilled" && equityQuotesRaw.value) {
    const { result, secIdMap } = equityQuotesRaw.value as { result: unknown; secIdMap: Record<string, string> };
    const nseEq = (result as Record<string, unknown>)["NSE_EQ"];
    if (Array.isArray(nseEq)) {
      const reverseMap: Record<string, string> = {};
      for (const [sym, id] of Object.entries(secIdMap)) reverseMap[id] = sym;
      for (const q of nseEq as Array<Record<string, unknown>>) {
        const secId = String(q["securityId"] ?? "");
        const symbol = (q["tradingSymbol"] as string) ?? reverseMap[secId] ?? secId;
        const lp = (q["lastPrice"] as number) ?? 0;
        const pc = (q["previousClose"] as number) ?? 0;
        quotes[symbol.toUpperCase()] = {
          symbol: symbol.toUpperCase(),
          securityId: secId,
          lastPrice: lp,
          previousClose: pc,
          changePercent: pc ? +((lp - pc) / pc * 100).toFixed(2) : 0,
          open: (q["open"] as number) ?? 0,
          high: (q["high"] as number) ?? 0,
          low: (q["low"] as number) ?? 0,
        };
      }
    }
  }

  // Parse index quotes for NIFTY50 / BANKNIFTY
  let nifty50: QuoteEntry | null = null;
  let banknifty: QuoteEntry | null = null;
  if (indexQuotesRaw.status === "fulfilled") {
    const idxData = (indexQuotesRaw.value as Record<string, unknown>)["IDX_I"];
    if (Array.isArray(idxData)) {
      for (const q of idxData as Array<Record<string, unknown>>) {
        const secId = String(q["securityId"] ?? "");
        const lp = (q["lastPrice"] as number) ?? 0;
        const pc = (q["previousClose"] as number) ?? 0;
        const entry: QuoteEntry = {
          symbol: secId === "13" ? "NIFTY50" : "BANKNIFTY",
          securityId: secId,
          lastPrice: lp,
          previousClose: pc,
          changePercent: pc ? +((lp - pc) / pc * 100).toFixed(2) : 0,
          open: (q["open"] as number) ?? 0,
          high: (q["high"] as number) ?? 0,
          low: (q["low"] as number) ?? 0,
        };
        if (secId === "13") nifty50 = entry;
        else if (secId === "25") banknifty = entry;
      }
    }
  }

  // Parse positions
  const positions: PositionEntry[] = [];
  if (positionsRaw.status === "fulfilled") {
    const posData = positionsRaw.value as Array<Record<string, unknown>>;
    if (Array.isArray(posData)) {
      for (const p of posData) {
        const qty = (p["netQty"] as number) ?? 0;
        if (qty === 0) continue;
        const avg = (p["costPrice"] as number) ?? (p["avgCostPrice"] as number) ?? 0;
        const lp = (p["lastTradedPrice"] as number) ?? (p["ltp"] as number) ?? 0;
        const pnl = (lp - avg) * qty;
        positions.push({
          symbol: (p["tradingSymbol"] as string) ?? "",
          quantity: qty,
          avgCostPrice: avg,
          lastPrice: lp,
          unrealizedPnl: +pnl.toFixed(2),
          pnlPercent: avg ? +((lp - avg) / avg * 100).toFixed(2) : 0,
        });
      }
    }
  }

  // Parse funds
  let funds: { availableBalance: number; usedMargin: number } | null = null;
  if (fundsRaw.status === "fulfilled" && fundsRaw.value) {
    const f = fundsRaw.value as Record<string, unknown>;
    funds = {
      availableBalance: (f["availabelBalance"] as number) ?? (f["availableBalance"] as number) ?? 0,
      usedMargin: (f["utilizedAmount"] as number) ?? (f["usedMargin"] as number) ?? 0,
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
