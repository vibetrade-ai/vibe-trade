import { parse } from "csv-parse/sync";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CONSTITUENT_BASE = "https://www.niftyindices.com/IndexConstituent";

const CONSTITUENT_EXCEPTIONS: Record<string, string> = {
  BANKNIFTY: "ind_niftybanklist.csv",
  FINNIFTY:  "ind_niftyfinancelist.csv",
};

export function deriveConstituentUrl(normalized: string): string {
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

interface ConstituentCacheEntry {
  symbols: string[];
  info: ConstituentInfo[];
  fetchedAt: number;
}

const constituentCache = new Map<string, ConstituentCacheEntry>();

async function fetchConstituentData(normalised: string): Promise<{ symbols: string[]; info: ConstituentInfo[] }> {
  const url = deriveConstituentUrl(normalised);
  console.log(`Fetching ${normalised} constituent list from niftyindices.com...`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${normalised} constituents: ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  const rows = parse(text, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];

  const symbols: string[] = [];
  const info: ConstituentInfo[] = [];
  for (const row of rows) {
    const symbol = (row["Symbol"] || row["symbol"] || "").trim().toUpperCase();
    if (!symbol) continue;
    info.push({
      symbol,
      name: (row["Company Name"] || row["company_name"] || symbol).trim(),
      industry: (row["Industry"] || row["industry"] || "").trim(),
    });
    symbols.push(symbol);
  }

  console.log(`${normalised}: ${info.length} constituents`);
  return { symbols, info };
}

async function ensureConstituents(normalised: string): Promise<ConstituentCacheEntry> {
  const now = Date.now();
  const cached = constituentCache.get(normalised);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached;
  const { symbols, info } = await fetchConstituentData(normalised);
  const entry = { symbols, info, fetchedAt: now };
  constituentCache.set(normalised, entry);
  return entry;
}

export async function getIndexConstituents(indexName: string): Promise<string[]> {
  const normalised = indexName.toUpperCase().replace(/[\s\-_]/g, "");
  deriveConstituentUrl(normalised); // validate early
  return (await ensureConstituents(normalised)).symbols;
}

export async function getIndexConstituentInfo(indexName: string): Promise<ConstituentInfo[]> {
  const normalised = indexName.toUpperCase().replace(/[\s\-_]/g, "");
  deriveConstituentUrl(normalised); // validate early
  return (await ensureConstituents(normalised)).info;
}
