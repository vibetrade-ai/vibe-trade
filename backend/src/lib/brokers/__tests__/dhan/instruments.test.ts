import { describe, it, expect, vi, beforeAll } from 'vitest';

// Mock fetch before module import so the cache is populated with test data
const MOCK_CSV = [
  'SEM_TRADING_SYMBOL,SEM_SMST_SECURITY_ID,SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_INSTRUMENT_NAME,SEM_CUSTOM_SYMBOL',
  'RELIANCE,500325,NSE,EQ,EQUITY,Reliance Industries Ltd',
  'TCS,532540,NSE,EQ,EQUITY,Tata Consultancy Services',
  'NIFTYBEES,12345,NSE,EQ,ETF,Nippon India ETF Nifty BeES',
  'NIFTY50,13,IDX_I,I,INDEX,NIFTY 50',
  'BANKNIFTY,25,IDX_I,I,INDEX,NIFTY BANK',
].join('\n');

const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  text: () => Promise.resolve(MOCK_CSV),
});
vi.stubGlobal('fetch', mockFetch);

// Import after stubbing fetch
import { getSecurityId, getIndexSecurityId, searchInstruments, isEtf } from '../../dhan/instruments.js';

describe('getSecurityId', () => {
  it('resolves a known equity symbol', async () => {
    const secId = await getSecurityId('RELIANCE');
    expect(secId).toBe('500325');
  });

  it('is case-insensitive', async () => {
    const secId = await getSecurityId('tcs');
    expect(secId).toBe('532540');
  });

  it('throws for unknown symbol', async () => {
    await expect(getSecurityId('UNKNOWN_XYZ')).rejects.toThrow(/not found/i);
  });
});

describe('getIndexSecurityId', () => {
  it('resolves a known index', async () => {
    const secId = await getIndexSecurityId('NIFTY50');
    expect(secId).toBe('13');
  });

  it('resolves BANKNIFTY', async () => {
    const secId = await getIndexSecurityId('BANKNIFTY');
    expect(secId).toBe('25');
  });

  it('returns undefined for unknown index', async () => {
    const secId = await getIndexSecurityId('UNKNOWNINDEX');
    expect(secId).toBeUndefined();
  });
});

describe('searchInstruments', () => {
  it('returns matching equity results', async () => {
    const results = await searchInstruments('reliance', 10, 'equity');
    expect(results).toHaveLength(1);
    expect(results[0].symbol).toBe('RELIANCE');
    expect(results[0].security_id).toBe('500325');
    expect(results[0].instrument_type).toBe('EQUITY');
  });

  it('filters by etf type', async () => {
    const results = await searchInstruments('nifty', 10, 'etf');
    expect(results.every(r => r.instrument_type === 'ETF')).toBe(true);
    expect(results.some(r => r.symbol === 'NIFTYBEES')).toBe(true);
  });

  it('returns all types when type is all', async () => {
    const results = await searchInstruments('nifty', 20, 'all');
    const types = new Set(results.map(r => r.instrument_type));
    expect(types.size).toBeGreaterThanOrEqual(1);
  });

  it('respects the limit parameter', async () => {
    const results = await searchInstruments('', 2, 'all');
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('returns empty array when no match', async () => {
    const results = await searchInstruments('zzznomatch999');
    expect(results).toHaveLength(0);
  });
});

describe('isEtf', () => {
  it('returns true for ETF symbol', async () => {
    expect(await isEtf('NIFTYBEES')).toBe(true);
  });

  it('returns false for equity symbol', async () => {
    expect(await isEtf('RELIANCE')).toBe(false);
  });

  it('returns false for unknown symbol', async () => {
    expect(await isEtf('UNKNOWN')).toBe(false);
  });
});

describe('caching', () => {
  it('fetches CSV only once across multiple calls', async () => {
    // Multiple calls — all should hit the in-memory cache
    await getSecurityId('RELIANCE');
    await getSecurityId('TCS');
    await getIndexSecurityId('NIFTY50');

    // fetch should have been called exactly once (during the first call in the file)
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
