import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DhanAdapter } from '../../dhan/index.js';
import { getSecurityId, getIndexSecurityId } from '../../dhan/instruments.js';

vi.mock('../../dhan/client.js', () => ({
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

vi.mock('../../dhan/instruments.js', () => ({
  getSecurityId: vi.fn().mockResolvedValue('12345'),
  getIndexSecurityId: vi.fn().mockResolvedValue(undefined),
  searchInstruments: vi.fn().mockResolvedValue([]),
  isEtf: vi.fn().mockReturnValue(false),
}));

describe('DhanAdapter', () => {
  let adapter: DhanAdapter;
  let mockClient: any;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new DhanAdapter('test-token', 'test-client-id');
    mockClient = (adapter as any).client;
  });

  describe('capabilities', () => {
    it('exposes correct capabilities', () => {
      expect(adapter.capabilities.name).toBe('Dhan');
      expect(adapter.capabilities.markets).toContain('NSE');
      expect(adapter.capabilities.availableIndices).toContain('NIFTY50');
      expect(adapter.capabilities.supportsHistoricalData).toBe(true);
      expect(adapter.capabilities.supportsMarketDepth).toBe(true);
      expect(adapter.capabilities.supportsStreaming).toBe(false);
    });
  });

  describe('getQuote', () => {
    it('maps equity quote response to normalized Quote', async () => {
      mockClient.getQuote.mockResolvedValue({
        data: {
          NSE_EQ: {
            '12345': {
              last_price: 1500,
              ohlc: { open: 1490, high: 1510, low: 1480, close: 1495 },
              volume: 100000,
            },
          },
        },
      });

      const quotes = await adapter.getQuote(['RELIANCE']);
      expect(quotes).toHaveLength(1);
      expect(quotes[0].symbol).toBe('RELIANCE');
      expect(quotes[0].lastPrice).toBe(1500);
      expect(quotes[0].open).toBe(1490);
      expect(quotes[0].high).toBe(1510);
      expect(quotes[0].low).toBe(1480);
      expect(quotes[0].previousClose).toBe(1495);
      expect(quotes[0].volume).toBe(100000);
    });

    it('computes change and changePercent correctly', async () => {
      mockClient.getQuote.mockResolvedValue({
        data: {
          NSE_EQ: {
            '12345': {
              last_price: 1100,
              ohlc: { open: 1000, high: 1110, low: 990, close: 1000 },
              volume: 5000,
            },
          },
        },
      });

      const quotes = await adapter.getQuote(['TCS']);
      expect(quotes[0].change).toBe(100);
      expect(quotes[0].changePercent).toBe(10);
    });

    it('returns empty array for empty symbols input', async () => {
      const quotes = await adapter.getQuote([]);
      expect(quotes).toHaveLength(0);
      expect(mockClient.getQuote).not.toHaveBeenCalled();
    });

    it('batches requests in groups of 25', async () => {
      // Override getSecurityId to return unique IDs
      const { getSecurityId } = await import('../../dhan/instruments.js');
      vi.mocked(getSecurityId).mockImplementation(async (sym) => `id_${sym}`);

      mockClient.getQuote.mockResolvedValue({ data: { NSE_EQ: {} } });

      const symbols = Array.from({ length: 30 }, (_, i) => `STOCK${i}`);
      await adapter.getQuote(symbols);

      // 30 symbols: first batch of 25, second batch of 5 → 2 calls
      expect(mockClient.getQuote).toHaveBeenCalledTimes(2);
    });
  });

  describe('getFunds', () => {
    it('maps available balance and utilized amount', async () => {
      mockClient.getFunds.mockResolvedValue({
        availabelBalance: 50000,
        utilizedAmount: 10000,
      });

      const funds = await adapter.getFunds();
      expect(funds.currency).toBe('INR');
      expect(funds.cash.available).toBe(50000);
      expect(funds.cash.used).toBe(10000);
    });
  });

  describe('getPositions', () => {
    it('maps non-zero positions', async () => {
      mockClient.getPositions.mockResolvedValue([
        { tradingSymbol: 'RELIANCE', netQty: 10, costPrice: 1400, lastTradedPrice: 1500, productType: 'CNC' },
        { tradingSymbol: 'TCS', netQty: 0, costPrice: 3000, lastTradedPrice: 3100, productType: 'INTRADAY' },
      ]);

      const positions = await adapter.getPositions();
      expect(positions).toHaveLength(1);
      expect(positions[0].symbol).toBe('RELIANCE');
      expect(positions[0].side).toBe('LONG');
      expect(positions[0].quantity).toBe(10);
      expect(positions[0].productType).toBe('DELIVERY');
    });

    it('treats negative quantity as SHORT position', async () => {
      mockClient.getPositions.mockResolvedValue([
        { tradingSymbol: 'NIFTY', netQty: -5, costPrice: 18000, lastTradedPrice: 17800, productType: 'INTRADAY' },
      ]);

      const positions = await adapter.getPositions();
      expect(positions[0].side).toBe('SHORT');
      expect(positions[0].quantity).toBe(5);
    });
  });

  describe('placeOrder', () => {
    it('translates OrderParams and returns OrderResult', async () => {
      mockClient.placeOrder.mockResolvedValue({ orderId: 'ORD001' });

      const result = await adapter.placeOrder({
        symbol: 'RELIANCE',
        side: 'BUY',
        quantity: 10,
        orderType: 'MARKET',
        productType: 'DELIVERY',
      });

      expect(result.orderId).toBe('ORD001');
      expect(result.status).toBe('PENDING');
      expect(mockClient.placeOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          symbol: 'RELIANCE',
          transactionType: 'BUY',
          quantity: 10,
          orderType: 'MARKET',
          productType: 'CNC',
        })
      );
    });
  });

  describe('getOrders', () => {
    it('maps order list with normalized statuses', async () => {
      mockClient.getOrders.mockResolvedValue([
        {
          orderId: 'ORD1',
          tradingSymbol: 'RELIANCE',
          transactionType: 'BUY',
          quantity: 5,
          filledQty: 5,
          orderType: 'MARKET',
          productType: 'CNC',
          orderStatus: 'TRADED',
          createTime: '2024-01-01T10:00:00',
          updateTime: '2024-01-01T10:01:00',
        },
      ]);

      const orders = await adapter.getOrders();
      expect(orders).toHaveLength(1);
      expect(orders[0].orderId).toBe('ORD1');
      expect(orders[0].status).toBe('FILLED');
      expect(orders[0].productType).toBe('DELIVERY');
    });
  });

  describe('getHistory', () => {
    beforeEach(() => {
      // Restore defaults after the "batches in groups of 25" test overrides getSecurityId
      vi.mocked(getSecurityId).mockResolvedValue('12345');
      vi.mocked(getIndexSecurityId).mockResolvedValue(undefined);
    });

    it('calls client.getHistory with correct segment for equity', async () => {
      mockClient.getHistory.mockResolvedValue({
        timestamp: [1700000000], open: [100], high: [105], low: [98], close: [103], volume: [5000],
      });

      const candles = await adapter.getHistory('RELIANCE', '1d', new Date('2024-01-01'), new Date('2024-01-31'));

      expect(mockClient.getHistory).toHaveBeenCalledWith(
        '12345', 'D', '2024-01-01', '2024-01-31', 'NSE_EQ', 'EQUITY'
      );
      expect(candles).toHaveLength(1);
      expect(candles[0].close).toBe(103);
    });

    it('uses IDX_I segment for index symbols', async () => {
      vi.mocked(getIndexSecurityId).mockResolvedValue('13');
      mockClient.getHistory.mockResolvedValue({ timestamp: [], open: [], high: [], low: [], close: [], volume: [] });

      await adapter.getHistory('NIFTY50', '5m', new Date('2024-01-01'), new Date('2024-01-02'));

      expect(mockClient.getHistory).toHaveBeenCalledWith(
        '13', '5', expect.any(String), expect.any(String), 'IDX_I', 'INDEX'
      );
    });
  });

  describe('getMarketDepth', () => {
    it('maps depth response to OrderBook', async () => {
      mockClient.getMarketDepth.mockResolvedValue({
        data: {
          NSE_EQ: {
            '12345': {
              depth: {
                buy:  [{ price: 1499, quantity: 100 }, { price: 1498, quantity: 200 }],
                sell: [{ price: 1501, quantity: 50 }],
              },
            },
          },
        },
      });

      const book = await adapter.getMarketDepth('RELIANCE');

      expect(book.symbol).toBe('RELIANCE');
      expect(book.bids).toHaveLength(2);
      expect(book.bids[0]).toEqual({ price: 1499, quantity: 100 });
      expect(book.asks).toHaveLength(1);
      expect(book.asks[0]).toEqual({ price: 1501, quantity: 50 });
      expect(book.timestamp).toBeInstanceOf(Date);
    });
  });

  describe('getOrderById', () => {
    it('returns a single Order with normalized status', async () => {
      mockClient.getOrderById.mockResolvedValue({
        orderId: 'ORD42',
        tradingSymbol: 'TCS',
        transactionType: 'SELL',
        quantity: 3,
        filledQty: 3,
        orderType: 'LIMIT',
        productType: 'CNC',
        orderStatus: 'TRADED',
        tradedPrice: 3200,
        createTime: '2024-01-10T09:30:00',
        updateTime: '2024-01-10T09:31:00',
      });

      const order = await adapter.getOrderById('ORD42');

      expect(order.orderId).toBe('ORD42');
      expect(order.symbol).toBe('TCS');
      expect(order.status).toBe('FILLED');
      expect(order.productType).toBe('DELIVERY');
      expect(order.price).toBe(3200);
    });
  });

  describe('cancelOrder', () => {
    it('delegates to client.cancelOrder', async () => {
      mockClient.cancelOrder.mockResolvedValue({});

      await adapter.cancelOrder('ORD99');

      expect(mockClient.cancelOrder).toHaveBeenCalledWith('ORD99');
    });
  });

  describe('getTradebook', () => {
    it('maps tradebook entries to Trade objects', async () => {
      mockClient.getTradebook.mockResolvedValue([
        {
          exchangeTradeId: 'TRD001',
          orderId: 'ORD001',
          tradingSymbol: 'RELIANCE',
          transactionType: 'BUY',
          tradedQuantity: 10,
          tradedPrice: 1500,
          productType: 'CNC',
          updateTime: '2024-01-01T10:00:00',
        },
      ]);

      const trades = await adapter.getTradebook();
      expect(trades).toHaveLength(1);
      expect(trades[0].tradeId).toBe('TRD001');
      expect(trades[0].orderId).toBe('ORD001');
      expect(trades[0].symbol).toBe('RELIANCE');
      expect(trades[0].price).toBe(1500);
      expect(trades[0].productType).toBe('DELIVERY');
    });
  });
});
