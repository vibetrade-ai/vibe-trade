import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../dhan/instruments.js', () => ({
  getSecurityId: vi.fn().mockResolvedValue('500325'),
  getIndexSecurityId: vi.fn().mockResolvedValue(undefined),
}));

import { parseDhanCandles, dateRange, resolveInstrument, fetchCandles } from '../../dhan/candles.js';
import { getSecurityId, getIndexSecurityId } from '../../dhan/instruments.js';

describe('parseDhanCandles', () => {
  it('maps parallel arrays into Candle objects', () => {
    const raw = {
      timestamp: [1700000000, 1700000060],
      open:      [100, 102],
      high:      [105, 107],
      low:       [98,  101],
      close:     [103, 106],
      volume:    [5000, 6000],
    };

    const candles = parseDhanCandles(raw);

    expect(candles).toHaveLength(2);
    expect(candles[0]).toEqual({ timestamp: 1700000000, open: 100, high: 105, low: 98, close: 103, volume: 5000 });
    expect(candles[1]).toEqual({ timestamp: 1700000060, open: 102, high: 107, low: 101, close: 106, volume: 6000 });
  });

  it('returns empty array when data has no timestamps', () => {
    expect(parseDhanCandles({})).toHaveLength(0);
    expect(parseDhanCandles({ timestamp: [] })).toHaveLength(0);
  });

  it('fills missing OHLCV fields with 0', () => {
    const raw = { timestamp: [1700000000] };
    const [c] = parseDhanCandles(raw);
    expect(c.open).toBe(0);
    expect(c.high).toBe(0);
    expect(c.low).toBe(0);
    expect(c.close).toBe(0);
    expect(c.volume).toBe(0);
  });

  it('handles a string body (non-object) without crashing', () => {
    // parseDhanCandles casts to Record — a string has no "timestamp" key, ?? [] gives empty array
    expect(parseDhanCandles('bad')).toHaveLength(0);
  });
});

describe('dateRange', () => {
  it('returns ISO date strings', () => {
    const { fromDate, toDate } = dateRange(7);
    expect(fromDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(toDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('fromDate is earlier than toDate', () => {
    const { fromDate, toDate } = dateRange(30);
    expect(new Date(fromDate).getTime()).toBeLessThan(new Date(toDate).getTime());
  });

  it('difference is approximately the requested number of days', () => {
    const { fromDate, toDate } = dateRange(10);
    const diffDays = (new Date(toDate).getTime() - new Date(fromDate).getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeCloseTo(10, 0);
  });
});

describe('resolveInstrument', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getIndexSecurityId).mockResolvedValue(undefined);
    vi.mocked(getSecurityId).mockResolvedValue('500325');
  });

  it('resolves an equity symbol to NSE_EQ / EQUITY', async () => {
    const result = await resolveInstrument('RELIANCE');
    expect(result).toEqual({ securityId: '500325', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' });
    expect(getSecurityId).toHaveBeenCalledWith('RELIANCE');
  });

  it('resolves an index symbol to IDX_I / INDEX when found in indexIdMap', async () => {
    vi.mocked(getIndexSecurityId).mockResolvedValue('13');

    const result = await resolveInstrument('NIFTY50');
    expect(result).toEqual({ securityId: '13', exchangeSegment: 'IDX_I', instrument: 'INDEX' });
    expect(getSecurityId).not.toHaveBeenCalled();
  });

  it('falls back to FALLBACK_INDEX_IDS for known indices not in cache', async () => {
    vi.mocked(getIndexSecurityId).mockResolvedValue(undefined);

    const result = await resolveInstrument('NIFTY50');
    expect(result).toEqual({ securityId: '13', exchangeSegment: 'IDX_I', instrument: 'INDEX' });
  });

  it('normalises NIFTYBANK → BANKNIFTY before index lookup', async () => {
    vi.mocked(getIndexSecurityId).mockImplementation(async (sym) =>
      sym === 'BANKNIFTY' ? '25' : undefined
    );

    const result = await resolveInstrument('NIFTYBANK');
    expect(result).toEqual({ securityId: '25', exchangeSegment: 'IDX_I', instrument: 'INDEX' });
  });

  it('normalises NIFTY → NIFTY50 before index lookup', async () => {
    vi.mocked(getIndexSecurityId).mockImplementation(async (sym) =>
      sym === 'NIFTY50' ? '13' : undefined
    );

    const result = await resolveInstrument('nifty');
    expect(result.securityId).toBe('13');
    expect(result.instrument).toBe('INDEX');
  });
});

describe('fetchCandles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getIndexSecurityId).mockResolvedValue(undefined);
    vi.mocked(getSecurityId).mockResolvedValue('500325');
  });

  it('resolves symbol, calls client.getHistory, and parses result', async () => {
    const raw = {
      timestamp: [1700000000],
      open: [100], high: [105], low: [98], close: [103], volume: [5000],
    };
    const mockClient = { getHistory: vi.fn().mockResolvedValue(raw) } as any;

    const candles = await fetchCandles('RELIANCE', '1', 5, mockClient);

    expect(mockClient.getHistory).toHaveBeenCalledWith(
      '500325', '1',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      'NSE_EQ', 'EQUITY'
    );
    expect(candles).toHaveLength(1);
    expect(candles[0].close).toBe(103);
  });

  it('uses IDX_I segment for index symbols', async () => {
    vi.mocked(getIndexSecurityId).mockResolvedValue('13');
    const mockClient = { getHistory: vi.fn().mockResolvedValue({ timestamp: [] }) } as any;

    await fetchCandles('NIFTY50', 'D', 30, mockClient);

    expect(mockClient.getHistory).toHaveBeenCalledWith(
      '13', 'D',
      expect.any(String), expect.any(String),
      'IDX_I', 'INDEX'
    );
  });
});
