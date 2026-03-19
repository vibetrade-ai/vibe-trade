import { parse } from "csv-parse/sync";

const CSV_URL = "https://images.dhan.co/api-data/api-scrip-master.csv";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface InstrumentRecord {
  symbol: string;
  securityId: string;
  name: string;
  instrumentType: string;
}

interface InstrumentCache {
  map: Map<string, string>;
  indexIdMap: Map<string, string>;
  records: InstrumentRecord[];
  fetchedAt: number;
}

let cache: InstrumentCache | null = null;

function normalizeIndexKey(sym: string): string {
  let s = sym.toUpperCase().replace(/[\s\-&.]/g, "");
  if (s === "NIFTYBANK") s = "BANKNIFTY";
  return s;
}

function instrumentPriority(type: string): number {
  if (type === "EQUITY") return 2;
  if (type === "ETF") return 1;
  return 0;
}

async function fetchInstruments(): Promise<{ map: Map<string, string>; indexIdMap: Map<string, string>; records: InstrumentRecord[] }> {
  console.log("Fetching Dhan instrument master CSV...");
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error(`Failed to fetch instrument master: ${res.status} ${res.statusText}`);
  const text = await res.text();
  const rows = parse(text, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];

  const map = new Map<string, string>();
  const mapInstrumentType = new Map<string, string>();
  const indexIdMap = new Map<string, string>();
  const records: InstrumentRecord[] = [];

  for (const row of rows) {
    const symbol = (row["SEM_TRADING_SYMBOL"] || row["TRADING_SYMBOL"] || row["tradingSymbol"] || "").trim().toUpperCase();
    const secId = (row["SEM_SMST_SECURITY_ID"] || row["SECURITY_ID"] || row["securityId"] || "").trim();
    const exchangeId = (row["SEM_EXM_EXCH_ID"] || row["EXCHANGE"] || row["exchange"] || "").trim().toUpperCase();
    const segmentId = (row["SEM_SEGMENT"] || "").trim().toUpperCase();
    const instrumentType = (row["SEM_INSTRUMENT_NAME"] || "EQUITY").trim().toUpperCase();
    const displayName = (row["SEM_CUSTOM_SYMBOL"] || row["SM_SYMBOL_NAME"] || row["SEM_INSTRUMENT_NAME"] || symbol).trim();

    if (!symbol || !secId) continue;

    const isIdxI = segmentId === "I" || segmentId === "IDX_I" || exchangeId === "IDX_I";
    const isNseEq = !isIdxI && (exchangeId === "NSE" || exchangeId === "NSE_EQ");

    if (isNseEq) {
      const existingPriority = instrumentPriority(mapInstrumentType.get(symbol) ?? "");
      if (instrumentPriority(instrumentType) > existingPriority) {
        map.set(symbol, secId);
        mapInstrumentType.set(symbol, instrumentType);
        const idx = records.findIndex(r => r.symbol === symbol);
        const rec = { symbol, securityId: secId, name: displayName, instrumentType };
        if (idx >= 0) records[idx] = rec; else records.push(rec);
      }
    } else if (isIdxI) {
      indexIdMap.set(normalizeIndexKey(symbol), secId);
    }
  }

  const etfCount = records.filter(r => r.instrumentType === "ETF").length;
  console.log(`Instrument master loaded: ${map.size} NSE (${etfCount} ETFs), ${indexIdMap.size} index symbols`);
  return { map, indexIdMap, records };
}

async function ensureCache(): Promise<InstrumentCache> {
  const now = Date.now();
  if (!cache || now - cache.fetchedAt > CACHE_TTL_MS) {
    const { map, indexIdMap, records } = await fetchInstruments();
    cache = { map, indexIdMap, records, fetchedAt: now };
  }
  return cache;
}

export async function getSecurityId(symbol: string): Promise<string> {
  const { map } = await ensureCache();
  const upper = symbol.toUpperCase();
  const secId = map.get(upper);
  if (!secId) throw new Error(`Symbol '${symbol}' not found in NSE instrument master. Check the ticker symbol.`);
  return secId;
}

export async function getSecurityIds(symbols: string[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  await Promise.all(symbols.map(async (sym) => { result[sym] = await getSecurityId(sym); }));
  return result;
}

export async function getIndexSecurityId(symbol: string): Promise<string | undefined> {
  const { indexIdMap } = await ensureCache();
  return indexIdMap.get(normalizeIndexKey(symbol));
}

export async function searchInstruments(
  query: string,
  limit = 20,
  type: "equity" | "etf" | "all" = "all"
): Promise<{ symbol: string; security_id: string; name: string; instrument_type: string }[]> {
  const { records } = await ensureCache();
  return records
    .filter(r => {
      const q = query.toLowerCase();
      const matchesQuery = r.symbol.toLowerCase().includes(q) || r.name.toLowerCase().includes(q);
      if (!matchesQuery) return false;
      if (type === "etf") return r.instrumentType === "ETF";
      if (type === "equity") return r.instrumentType === "EQUITY";
      return true;
    })
    .slice(0, limit)
    .map(r => ({ symbol: r.symbol, security_id: r.securityId, name: r.name, instrument_type: r.instrumentType }));
}

export async function isEtf(symbol: string): Promise<boolean> {
  const { records } = await ensureCache();
  const record = records.find(r => r.symbol === symbol.toUpperCase());
  return record?.instrumentType === "ETF";
}
