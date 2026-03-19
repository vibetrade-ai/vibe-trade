import { describe, it, expect, vi } from 'vitest';

// Mock network-dependent modules — we only test capability filtering logic, not handlers
vi.mock('../brokers/dhan/instruments.js', () => ({
  searchInstruments: vi.fn(),
  isEtf: vi.fn(),
  getSecurityId: vi.fn(),
  getIndexSecurityId: vi.fn(),
}));
vi.mock('../market-data/nse.js', () => ({
  getIndexConstituents: vi.fn(),
  getIndexConstituentInfo: vi.fn(),
  deriveConstituentUrl: vi.fn(),
}));
vi.mock('../yahoo.js', () => ({
  getFundamentals: vi.fn(),
  getEtfInfo: vi.fn(),
}));
vi.mock('../news.js', () => ({
  fetchNews: vi.fn(),
}));
vi.mock('../indicators.js', () => ({
  computeIndicators: vi.fn(),
}));
vi.mock('../brokers/dhan/order-sync.js', () => ({
  syncOrders: vi.fn(),
}));

import { getAllToolDefinitions } from '../tools.js';
import type { BrokerAdapter, BrokerCapabilities } from '../brokers/types.js';

function makeCapabilities(overrides: Partial<BrokerCapabilities> = {}): BrokerCapabilities {
  return {
    name: 'TestBroker',
    markets: ['NSE'],
    assetClasses: ['EQUITY'],
    supportsHistoricalData: true,
    supportsMarketDepth: true,
    supportsStreaming: false,
    supportsFractionalQuantity: false,
    availableIndices: ['NIFTY50'],
    ...overrides,
  };
}

function makeBroker(caps: BrokerCapabilities): BrokerAdapter {
  return { capabilities: caps } as any;
}

describe('getAllToolDefinitions', () => {
  it('returns all tools when no broker is provided', () => {
    const tools = getAllToolDefinitions();
    expect(tools.length).toBeGreaterThanOrEqual(20);
  });

  it('returns Anthropic.Tool objects (each has name and input_schema)', () => {
    const tools = getAllToolDefinitions();
    for (const tool of tools) {
      expect(tool).toHaveProperty('name');
      expect(tool).toHaveProperty('input_schema');
    }
  });

  it('includes extra tool definitions passed as first argument', () => {
    const extra = [{
      definition: { name: 'custom_tool', description: 'A custom tool', input_schema: { type: 'object' as const, properties: {} } },
      requiresApproval: false,
      handler: async () => 'ok',
    }];
    const tools = getAllToolDefinitions(extra);
    expect(tools.map(t => t.name)).toContain('custom_tool');
  });

  describe('capability filtering', () => {
    it('includes historical data tools when supportsHistoricalData is true', () => {
      const tools = getAllToolDefinitions([], makeBroker(makeCapabilities({ supportsHistoricalData: true })));
      const names = tools.map(t => t.name);
      expect(names).toContain('get_historical_data');
      expect(names).toContain('compute_indicators');
    });

    it('excludes historical data tools when supportsHistoricalData is false', () => {
      const tools = getAllToolDefinitions([], makeBroker(makeCapabilities({ supportsHistoricalData: false })));
      const names = tools.map(t => t.name);
      expect(names).not.toContain('get_historical_data');
      expect(names).not.toContain('compute_indicators');
    });

    it('includes get_market_depth when supportsMarketDepth is true', () => {
      const tools = getAllToolDefinitions([], makeBroker(makeCapabilities({ supportsMarketDepth: true })));
      expect(tools.map(t => t.name)).toContain('get_market_depth');
    });

    it('excludes get_market_depth when supportsMarketDepth is false', () => {
      const tools = getAllToolDefinitions([], makeBroker(makeCapabilities({ supportsMarketDepth: false })));
      expect(tools.map(t => t.name)).not.toContain('get_market_depth');
    });

    it('includes get_top_movers when availableIndices is non-empty', () => {
      const tools = getAllToolDefinitions([], makeBroker(makeCapabilities({ availableIndices: ['NIFTY50'] })));
      expect(tools.map(t => t.name)).toContain('get_top_movers');
    });

    it('excludes get_top_movers when availableIndices is empty', () => {
      const tools = getAllToolDefinitions([], makeBroker(makeCapabilities({ availableIndices: [] })));
      expect(tools.map(t => t.name)).not.toContain('get_top_movers');
    });

    it('includes tools without requiresCapability regardless of broker', () => {
      // get_quote, get_positions, get_funds etc. have no requiresCapability constraint
      const tools = getAllToolDefinitions([], makeBroker(makeCapabilities({
        supportsHistoricalData: false,
        supportsMarketDepth: false,
        availableIndices: [],
      })));
      const names = tools.map(t => t.name);
      expect(names).toContain('get_quote');
      expect(names).toContain('get_positions');
      expect(names).toContain('get_funds');
    });
  });
});
