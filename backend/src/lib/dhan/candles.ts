import type { DhanClient } from "./client.js";
import type { Candle } from "../indicators.js";
import { getSecurityId, getIndexSecurityId } from "./instruments.js";

export function parseDhanCandles(data: unknown): Candle[] {
  const d = data as Record<string, unknown>;
  const timestamps = (d["timestamp"] as number[]) ?? [];
  const opens = (d["open"] as number[]) ?? [];
  const highs = (d["high"] as number[]) ?? [];
  const lows = (d["low"] as number[]) ?? [];
  const closes = (d["close"] as number[]) ?? [];
  const volumes = (d["volume"] as number[]) ?? [];
  return timestamps.map((ts, i) => ({
    timestamp: ts,
    open: opens[i] ?? 0,
    high: highs[i] ?? 0,
    low: lows[i] ?? 0,
    close: closes[i] ?? 0,
    volume: volumes[i] ?? 0,
  }));
}

export function dateRange(days: number): { fromDate: string; toDate: string } {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - days);
  const fmt = (d: Date) => d.toISOString().split("T")[0];
  return { fromDate: fmt(from), toDate: fmt(to) };
}

const FALLBACK_INDEX_IDS: Record<string, string> = {
  NIFTY50:   "13",
  BANKNIFTY: "25",
  FINNIFTY:  "27",
};

export async function resolveInstrument(symbol: string): Promise<{
  securityId: string;
  exchangeSegment: "NSE_EQ" | "IDX_I";
  instrument: "EQUITY" | "INDEX";
}> {
  let normalized = symbol.toUpperCase().replace(/[\s\-_]/g, "");
  if (normalized === "NIFTYBANK") normalized = "BANKNIFTY";
  if (normalized === "NIFTY") normalized = "NIFTY50";

  let securityId = await getIndexSecurityId(normalized);
  if (!securityId) securityId = FALLBACK_INDEX_IDS[normalized];

  if (securityId) {
    return { securityId, exchangeSegment: "IDX_I", instrument: "INDEX" };
  }

  const equityId = await getSecurityId(symbol);
  return { securityId: equityId, exchangeSegment: "NSE_EQ", instrument: "EQUITY" };
}

export async function fetchCandles(
  symbol: string,
  interval: "1" | "5" | "15" | "25" | "60" | "D",
  days: number,
  client: DhanClient
): Promise<Candle[]> {
  const { securityId, exchangeSegment, instrument } = await resolveInstrument(symbol);
  const { fromDate, toDate } = dateRange(days);
  const raw = await client.getHistory(securityId, interval, fromDate, toDate, exchangeSegment, instrument);
  return parseDhanCandles(raw);
}
