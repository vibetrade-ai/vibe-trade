import { parse } from "csv-parse/sync";

const CSV_URL = "https://images.dhan.co/api-data/api-scrip-master.csv";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Index constituent CSV sources (niftyindices.com)
const CONSTITUENT_BASE = "https://www.niftyindices.com/IndexConstituent";

// Exceptions where the standard NIFTY* derivation doesn't match the filename
const CONSTITUENT_EXCEPTIONS: Record<string, string> = {
  BANKNIFTY: "ind_niftybanklist.csv",
  FINNIFTY:  "ind_niftyfinancelist.csv",
};

// Derive constituent CSV URL from a normalised index symbol.
// Standard rule: NIFTY{X} → ind_nifty{x}list.csv  (e.g. NIFTYAUTO → ind_niftyautolist.csv)
// Reverse rule:  {X}NIFTY → ind_nifty{x}list.csv  (catches any *NIFTY variants)
function deriveConstituentUrl(normalized: string): string {
  if (CONSTITUENT_EXCEPTIONS[normalized]) {
    return `${CONSTITUENT_BASE}/${CONSTITUENT_EXCEPTIONS[normalized]}`;
  }
  if (normalized.startsWith("NIFTY")) {
    const suffix = normalized.slice(5).toLowerCase();
    return `${CONSTITUENT_BASE}/ind_nifty${suffix}list.csv`;
  }
  if (normalized.endsWith("NIFTY")) {
    const prefix = normalized.slice(0, -5).toLowerCase();
    return `${CONSTITUENT_BASE}/ind_nifty${prefix}list.csv`;
  }
  throw new Error(
    `Cannot derive constituent CSV URL for '${normalized}'. ` +
    `Use the official NSE index name, e.g. NIFTY50, NIFTYAUTO, NIFTYIT, BANKNIFTY.`
  );
}

export interface ConstituentInfo {
  symbol: string;
  name: string;
  industry: string;
}

// Per-index constituent cache (24h TTL) — stores both resolved secIds and display info
const constituentCache = new Map<string, {
  secIds: string[];
  info: ConstituentInfo[];
  fetchedAt: number;
}>();

interface InstrumentRecord {
  symbol: string;
  securityId: string;
  name: string;           // human-readable display name (SEM_CUSTOM_SYMBOL)
  instrumentType: string; // "EQUITY", "ETF", etc. (SEM_INSTRUMENT_NAME)
}

interface InstrumentCache {
  map: Map<string, string>;      // symbol → security_id (NSE equity)
  indexIdMap: Map<string, string>; // normalised index symbol → security_id
  records: InstrumentRecord[];
  fetchedAt: number;
}

let cache: InstrumentCache | null = null;

function normalizeIndexKey(sym: string): string {
  let s = sym.toUpperCase().replace(/[\s\-&.]/g, "");
  if (s === "NIFTYBANK") s = "BANKNIFTY";
  return s;
}

async function fetchInstruments(): Promise<{
  map: Map<string, string>;
  indexIdMap: Map<string, string>;
  records: InstrumentRecord[];
}> {
  console.log("Fetching Dhan instrument master CSV...");
  const res = await fetch(CSV_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch instrument master: ${res.status} ${res.statusText}`);
  }
  const text = await res.text();

  const rows = parse(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];

  const map = new Map<string, string>();
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

    const isIdxI = exchangeId === "IDX_I" || segmentId === "IDX_I";
    // Preserve original NSE equity condition, excluding IDX_I rows
    const isNseEq = !isIdxI && (exchangeId === "NSE" || exchangeId === "NSE_EQ");

    if (isNseEq) {
      map.set(symbol, secId);
      records.push({ symbol, securityId: secId, name: displayName, instrumentType });
    } else if (isIdxI) {
      const normKey = normalizeIndexKey(symbol);
      indexIdMap.set(normKey, secId);
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

export async function getIndexSecurityId(symbol: string): Promise<string | undefined> {
  const { indexIdMap } = await ensureCache();
  return indexIdMap.get(normalizeIndexKey(symbol));
}

async function fetchConstituents(normalised: string): Promise<{ secIds: string[]; info: ConstituentInfo[] }> {
  const url = deriveConstituentUrl(normalised);
  console.log(`Fetching ${normalised} constituent list...`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${normalised} constituents: ${res.status} ${res.statusText}`);
  }
  const text = await res.text();

  const rows = parse(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];

  const { map } = await ensureCache();
  const secIds: string[] = [];
  const info: ConstituentInfo[] = [];

  for (const row of rows) {
    const symbol = (row["Symbol"] || row["symbol"] || "").trim().toUpperCase();
    if (!symbol) continue;
    info.push({
      symbol,
      name: (row["Company Name"] || row["company_name"] || symbol).trim(),
      industry: (row["Industry"] || row["industry"] || "").trim(),
    });
    const secId = map.get(symbol);
    if (secId) secIds.push(secId);
  }

  console.log(`${normalised}: ${info.length} constituents, ${secIds.length} resolved`);
  return { secIds, info };
}

async function ensureConstituents(normalised: string) {
  const now = Date.now();
  const cached = constituentCache.get(normalised);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached;
  const { secIds, info } = await fetchConstituents(normalised);
  const entry = { secIds, info, fetchedAt: now };
  constituentCache.set(normalised, entry);
  return entry;
}

export async function getIndexConstituents(indexName: string): Promise<string[]> {
  const normalised = indexName.toUpperCase().replace(/[\s\-_]/g, "");
  deriveConstituentUrl(normalised); // validate early
  return (await ensureConstituents(normalised)).secIds;
}

export async function getIndexConstituentInfo(indexName: string): Promise<ConstituentInfo[]> {
  const normalised = indexName.toUpperCase().replace(/[\s\-_]/g, "");
  deriveConstituentUrl(normalised); // validate early
  return (await ensureConstituents(normalised)).info;
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
