import { parse } from "csv-parse/sync";

const CSV_URL = "https://images.dhan.co/api-data/api-scrip-master.csv";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface InstrumentCache {
  map: Map<string, string>; // symbol → security_id
  fetchedAt: number;
}

let cache: InstrumentCache | null = null;

async function fetchInstruments(): Promise<Map<string, string>> {
  console.log("Fetching Dhan instrument master CSV...");
  const res = await fetch(CSV_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch instrument master: ${res.status} ${res.statusText}`);
  }
  const text = await res.text();

  const records = parse(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];

  const map = new Map<string, string>();
  for (const row of records) {
    // CSV columns vary; common column names from Dhan master
    const symbol = (row["SEM_TRADING_SYMBOL"] || row["TRADING_SYMBOL"] || row["tradingSymbol"] || "").trim().toUpperCase();
    const secId = (row["SEM_SMST_SECURITY_ID"] || row["SECURITY_ID"] || row["securityId"] || "").trim();
    const segment = (row["SEM_EXM_EXCH_ID"] || row["EXCHANGE"] || row["exchange"] || "").trim().toUpperCase();

    // Only cache NSE equity symbols
    if (symbol && secId && (segment === "NSE" || segment === "NSE_EQ")) {
      map.set(symbol, secId);
    }
  }

  console.log(`Instrument master loaded: ${map.size} NSE equity symbols`);
  return map;
}

export async function getSecurityId(symbol: string): Promise<string> {
  const now = Date.now();

  if (!cache || now - cache.fetchedAt > CACHE_TTL_MS) {
    const map = await fetchInstruments();
    cache = { map, fetchedAt: now };
  }

  const upper = symbol.toUpperCase();
  const secId = cache.map.get(upper);
  if (!secId) {
    throw new Error(`Symbol '${symbol}' not found in NSE instrument master. Check the ticker symbol.`);
  }
  return secId;
}

export async function getSecurityIds(symbols: string[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  await Promise.all(
    symbols.map(async (sym) => {
      result[sym] = await getSecurityId(sym);
    })
  );
  return result;
}
