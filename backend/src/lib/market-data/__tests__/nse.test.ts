import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Import after stubbing fetch so module-level side effects use our mock
import { getIndexConstituents, getIndexConstituentInfo, deriveConstituentUrl } from '../nse.js';

// The nse.ts module keeps a constituentCache Map that persists within a test file.
// Each test therefore uses a UNIQUE index name so tests don't share cached state.

function makeCsv(rows: { name: string; industry: string; symbol: string }[]): string {
  const header = 'Company Name,Industry,Symbol,Series,ISIN Code';
  const lines = rows.map(r => `${r.name},${r.industry},${r.symbol},EQ,INE000000000`);
  return [header, ...lines].join('\n');
}

describe('deriveConstituentUrl', () => {
  it('derives URL for NIFTY50', () => {
    expect(deriveConstituentUrl('NIFTY50')).toContain('ind_nifty50list.csv');
  });

  it('derives URL for NIFTYIT', () => {
    expect(deriveConstituentUrl('NIFTYIT')).toContain('ind_niftyitlist.csv');
  });

  it('handles BANKNIFTY exception', () => {
    expect(deriveConstituentUrl('BANKNIFTY')).toContain('ind_niftybanklist.csv');
  });

  it('handles FINNIFTY exception', () => {
    expect(deriveConstituentUrl('FINNIFTY')).toContain('ind_niftyfinancelist.csv');
  });

  it('throws for unrecognised index', () => {
    expect(() => deriveConstituentUrl('SENSEX')).toThrow();
  });
});

describe('getIndexConstituents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses CSV and returns symbol strings (NIFTYIT)', async () => {
    // NIFTYIT is fresh — not cached yet
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(makeCsv([
        { name: 'Infosys Limited', industry: 'IT', symbol: 'INFY' },
        { name: 'TCS', industry: 'IT', symbol: 'TCS' },
        { name: 'Wipro', industry: 'IT', symbol: 'WIPRO' },
      ])),
    });

    const result = await getIndexConstituents('NIFTYIT');

    expect(result).toContain('INFY');
    expect(result).toContain('TCS');
    expect(result).toContain('WIPRO');
    expect(result).toHaveLength(3);
  });

  it('returns cached result on second call within TTL (NIFTY100)', async () => {
    // NIFTY100 is fresh — will be fetched once then cached
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(makeCsv([
        { name: 'Reliance Industries', industry: 'Energy', symbol: 'RELIANCE' },
      ])),
    });

    await getIndexConstituents('NIFTY100');
    await getIndexConstituents('NIFTY100');

    // Second call should use cache — fetch called only once total
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('normalises index name to uppercase and strips separators (nifty-auto → NIFTYAUTO)', async () => {
    // NIFTYAUTO is fresh
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(makeCsv([
        { name: 'Maruti Suzuki', industry: 'Automobile', symbol: 'MARUTI' },
      ])),
    });

    const result = await getIndexConstituents('nifty-auto');
    expect(result).toContain('MARUTI');
  });

  it('uses separate cache entries for different indices (NIFTYMIDCAP100 + NIFTYSMALLCAP100)', async () => {
    // Both indices are fresh
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(makeCsv([{ name: 'Stock A', industry: 'Finance', symbol: 'STOCKA' }])),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(makeCsv([{ name: 'Stock B', industry: 'Tech', symbol: 'STOCKB' }])),
      });

    const mid = await getIndexConstituents('NIFTYMIDCAP100');
    const small = await getIndexConstituents('NIFTYSMALLCAP100');

    expect(mid).toContain('STOCKA');
    expect(small).toContain('STOCKB');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('throws when fetch fails (NIFTYFMCG — fresh, mocked to 404)', async () => {
    // NIFTYFMCG is fresh, but fetch will fail
    mockFetch.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });

    await expect(getIndexConstituents('NIFTYFMCG')).rejects.toThrow();
  });
});

describe('getIndexConstituentInfo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns full constituent info with name and industry (NIFTYAUTO)', async () => {
    // NIFTYAUTO was cached by the normalisation test — reuse it
    // (no mockFetch setup needed since it's cached)
    const result = await getIndexConstituentInfo('NIFTYAUTO');

    expect(result[0]).toMatchObject({
      symbol: 'MARUTI',
      name: 'Maruti Suzuki',
      industry: 'Automobile',
    });
  });
});
