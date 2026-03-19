import { describe, it, expect, vi } from 'vitest';
import { createBrokerAdapter } from '../index.js';

// Prevent real CSV fetch on DhanAdapter instantiation
vi.mock('../dhan/instruments.js', () => ({
  getSecurityId: vi.fn(),
  getSecurityIds: vi.fn(),
  getIndexSecurityId: vi.fn(),
  searchInstruments: vi.fn().mockResolvedValue([]),
  isEtf: vi.fn().mockReturnValue(false),
}));

// Prevent real HTTP requests from DhanClient
vi.mock('../dhan/client.js', () => ({
  // Must use regular function (not arrow) so it can be called with `new`
  DhanClient: vi.fn(function (this: any) {
    this.getQuote = vi.fn();
    this.getPositions = vi.fn();
    this.getFunds = vi.fn();
    this.getOrders = vi.fn();
    this.placeOrder = vi.fn();
    this.cancelOrder = vi.fn();
    this.getOrderById = vi.fn();
    this.getHistory = vi.fn();
    this.getMarketDepth = vi.fn();
    this.getTradebook = vi.fn();
  }),
}));

describe('createBrokerAdapter', () => {
  it('returns a BrokerAdapter for dhan', () => {
    const adapter = createBrokerAdapter('dhan', {
      DHAN_ACCESS_TOKEN: 'test-token',
      DHAN_CLIENT_ID: 'test-id',
    });
    expect(adapter.capabilities.name).toBe('Dhan');
    expect(adapter.capabilities.supportsHistoricalData).toBe(true);
    expect(adapter.capabilities.supportsMarketDepth).toBe(true);
  });

  it('includes NSE in dhan markets', () => {
    const adapter = createBrokerAdapter('dhan', {
      DHAN_ACCESS_TOKEN: 'test-token',
      DHAN_CLIENT_ID: 'test-id',
    });
    expect(adapter.capabilities.markets).toContain('NSE');
  });

  it('throws for unknown broker', () => {
    expect(() =>
      createBrokerAdapter('groww', {})
    ).toThrow(/Unknown broker/);
  });

  it('throws for empty broker string', () => {
    expect(() =>
      createBrokerAdapter('', {})
    ).toThrow();
  });
});
