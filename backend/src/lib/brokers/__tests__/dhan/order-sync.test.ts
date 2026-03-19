import { describe, it, expect, vi } from 'vitest';
import { syncOrders } from '../../dhan/order-sync.js';
import type { BrokerAdapter, Order, Trade } from '../../types.js';
import type { TradeStore, TradeRecord } from '../../../storage/types.js';

function makeAdapter(overrides: Partial<BrokerAdapter> = {}): BrokerAdapter {
  return {
    capabilities: {} as any,
    getOrders: vi.fn().mockResolvedValue([]),
    getTradebook: vi.fn().mockResolvedValue([]),
    getQuote: vi.fn(),
    getHistory: vi.fn(),
    getMarketDepth: vi.fn(),
    getPositions: vi.fn(),
    getFunds: vi.fn(),
    getOrderById: vi.fn(),
    placeOrder: vi.fn(),
    cancelOrder: vi.fn(),
    searchInstruments: vi.fn(),
    ...overrides,
  } as any;
}

function makeStore(overrides: Partial<TradeStore> = {}): TradeStore {
  return {
    append: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn(),
    update: vi.fn(),
    ...overrides,
  } as any;
}

function makePendingTrade(partial: Partial<TradeRecord> = {}): TradeRecord {
  return {
    id: 'trade-1',
    orderId: 'order-1',
    symbol: 'RELIANCE',
    securityId: '500325',
    transactionType: 'BUY',
    quantity: 10,
    orderType: 'MARKET',
    status: 'pending',
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

describe('syncOrders', () => {
  it('returns immediately without API calls when no pending trades', async () => {
    const store = makeStore({ list: vi.fn().mockResolvedValue([]) });
    const broker = makeAdapter();

    const result = await syncOrders(broker, store);

    expect(result).toEqual({ fillsUpdated: 0, rejectedOrCancelled: 0 });
    expect(broker.getTradebook).not.toHaveBeenCalled();
    expect(broker.getOrders).not.toHaveBeenCalled();
  });

  it('marks pending trade as filled when found in tradebook', async () => {
    const pendingTrade = makePendingTrade({ orderId: 'order-1' });
    const tradebookEntry: Trade = {
      tradeId: 'trd-1',
      orderId: 'order-1',
      symbol: 'RELIANCE',
      side: 'BUY',
      quantity: 10,
      price: 1500,
      productType: 'DELIVERY',
      tradedAt: new Date('2024-01-01T10:00:00'),
    };

    const store = makeStore({
      list: vi.fn()
        .mockResolvedValueOnce([pendingTrade])   // initial pending list
        .mockResolvedValueOnce([])                // stillPending after pass 1
        .mockResolvedValue([]),
    });
    const broker = makeAdapter({
      getTradebook: vi.fn().mockResolvedValue([tradebookEntry]),
      getOrders: vi.fn().mockResolvedValue([]),
    });

    const result = await syncOrders(broker, store);

    expect(result.fillsUpdated).toBe(1);
    expect(store.update).toHaveBeenCalledWith(
      'trade-1',
      expect.objectContaining({ status: 'filled', executedPrice: 1500 })
    );
  });

  it('marks pending trade as rejected when found in orders with REJECTED status', async () => {
    const pendingTrade = makePendingTrade({ orderId: 'order-2' });
    const rejectedOrder: Order = {
      orderId: 'order-2',
      symbol: 'TCS',
      side: 'BUY',
      quantity: 5,
      filledQuantity: 0,
      orderType: 'LIMIT',
      productType: 'INTRADAY',
      status: 'REJECTED',
      statusMessage: 'Insufficient funds',
      placedAt: new Date(),
      updatedAt: new Date(),
    };

    const store = makeStore({
      list: vi.fn()
        .mockResolvedValueOnce([pendingTrade])  // initial pending
        .mockResolvedValueOnce([pendingTrade])  // stillPending after pass 1 (not filled yet)
        .mockResolvedValue([]),
    });
    const broker = makeAdapter({
      getTradebook: vi.fn().mockResolvedValue([]),
      getOrders: vi.fn().mockResolvedValue([rejectedOrder]),
    });

    const result = await syncOrders(broker, store);

    expect(result.rejectedOrCancelled).toBe(1);
    expect(store.update).toHaveBeenCalledWith(
      'trade-1',
      expect.objectContaining({ status: 'rejected', rejectionReason: 'Insufficient funds' })
    );
  });

  it('marks pending trade as cancelled when order is CANCELLED', async () => {
    const pendingTrade = makePendingTrade({ orderId: 'order-3' });
    const cancelledOrder: Order = {
      orderId: 'order-3',
      symbol: 'INFY',
      side: 'SELL',
      quantity: 2,
      filledQuantity: 0,
      orderType: 'MARKET',
      productType: 'INTRADAY',
      status: 'CANCELLED',
      placedAt: new Date(),
      updatedAt: new Date(),
    };

    const store = makeStore({
      list: vi.fn()
        .mockResolvedValueOnce([pendingTrade])
        .mockResolvedValueOnce([pendingTrade])
        .mockResolvedValue([]),
    });
    const broker = makeAdapter({
      getTradebook: vi.fn().mockResolvedValue([]),
      getOrders: vi.fn().mockResolvedValue([cancelledOrder]),
    });

    const result = await syncOrders(broker, store);

    expect(result.rejectedOrCancelled).toBe(1);
    expect(store.update).toHaveBeenCalledWith(
      'trade-1',
      expect.objectContaining({ status: 'cancelled' })
    );
  });

  it('skips trades with no matching tradebook or order entry', async () => {
    const pendingTrade = makePendingTrade({ orderId: 'order-999' });

    const store = makeStore({
      list: vi.fn()
        .mockResolvedValueOnce([pendingTrade])
        .mockResolvedValueOnce([pendingTrade])
        .mockResolvedValue([]),
    });
    const broker = makeAdapter({
      getTradebook: vi.fn().mockResolvedValue([]),
      getOrders: vi.fn().mockResolvedValue([]),
    });

    const result = await syncOrders(broker, store);

    expect(result.fillsUpdated).toBe(0);
    expect(result.rejectedOrCancelled).toBe(0);
    expect(store.update).not.toHaveBeenCalled();
  });

  it('computes realizedPnl for a SELL trade filled via tradebook (pass 1)', async () => {
    // Sell 10 shares @ 1600; prior BUY fill was 10 shares @ 1400 → pnl = (1600-1400)*10 = 2000
    const sellTrade = makePendingTrade({
      id: 'sell-1',
      orderId: 'order-sell-1',
      transactionType: 'SELL',
      quantity: 10,
    });
    const priorBuy: TradeRecord = {
      ...makePendingTrade({ id: 'buy-1', orderId: 'order-buy-1', transactionType: 'BUY' }),
      status: 'filled',
      executedPrice: 1400,
      quantity: 10,
    };
    const tradebookEntry: Trade = {
      tradeId: 'trd-sell-1',
      orderId: 'order-sell-1',
      symbol: 'RELIANCE',
      side: 'SELL',
      quantity: 10,
      price: 1600,
      productType: 'DELIVERY',
      tradedAt: new Date('2024-01-02T10:00:00'),
    };

    const store = makeStore({
      list: vi.fn()
        .mockResolvedValueOnce([sellTrade])   // initial pending
        .mockResolvedValueOnce([priorBuy])    // prior BUY fills lookup
        .mockResolvedValueOnce([])            // stillPending after pass 1
        .mockResolvedValue([]),
    });
    const broker = makeAdapter({
      getTradebook: vi.fn().mockResolvedValue([tradebookEntry]),
      getOrders: vi.fn().mockResolvedValue([]),
    });

    const result = await syncOrders(broker, store);

    expect(result.fillsUpdated).toBe(1);
    expect(store.update).toHaveBeenCalledWith(
      'sell-1',
      expect.objectContaining({
        status: 'filled',
        executedPrice: 1600,
        realizedPnl: 2000,
      })
    );
  });

  it('computes realizedPnl for a SELL trade filled via orders list (pass 2)', async () => {
    // Sell 5 shares @ 1500; prior BUY fill was 5 shares @ 1200 → pnl = (1500-1200)*5 = 1500
    const sellTrade = makePendingTrade({
      id: 'sell-2',
      orderId: 'order-sell-2',
      transactionType: 'SELL',
      quantity: 5,
    });
    const priorBuy: TradeRecord = {
      ...makePendingTrade({ id: 'buy-2', orderId: 'order-buy-2', transactionType: 'BUY' }),
      status: 'filled',
      executedPrice: 1200,
      quantity: 5,
    };
    const filledOrder: Order = {
      orderId: 'order-sell-2',
      symbol: 'RELIANCE',
      side: 'SELL',
      quantity: 5,
      filledQuantity: 5,
      orderType: 'MARKET',
      productType: 'INTRADAY',
      price: 1500,
      status: 'FILLED',
      placedAt: new Date(),
      updatedAt: new Date('2024-01-03T11:00:00'),
    };

    const store = makeStore({
      list: vi.fn()
        .mockResolvedValueOnce([sellTrade])   // initial pending
        .mockResolvedValueOnce([sellTrade])   // stillPending after pass 1
        .mockResolvedValueOnce([priorBuy])    // prior BUY fills lookup in pass 2
        .mockResolvedValue([]),
    });
    const broker = makeAdapter({
      getTradebook: vi.fn().mockResolvedValue([]),
      getOrders: vi.fn().mockResolvedValue([filledOrder]),
    });

    const result = await syncOrders(broker, store);

    expect(result.fillsUpdated).toBe(1);
    expect(store.update).toHaveBeenCalledWith(
      'sell-2',
      expect.objectContaining({
        status: 'filled',
        executedPrice: 1500,
        realizedPnl: 1500,
      })
    );
  });

  it('omits realizedPnl when there are no prior BUY fills', async () => {
    const sellTrade = makePendingTrade({
      id: 'sell-3',
      orderId: 'order-sell-3',
      transactionType: 'SELL',
      quantity: 5,
    });
    const tradebookEntry: Trade = {
      tradeId: 'trd-sell-3',
      orderId: 'order-sell-3',
      symbol: 'RELIANCE',
      side: 'SELL',
      quantity: 5,
      price: 1500,
      productType: 'INTRADAY',
      tradedAt: new Date(),
    };

    const store = makeStore({
      list: vi.fn()
        .mockResolvedValueOnce([sellTrade])  // initial pending
        .mockResolvedValueOnce([])           // no prior BUY fills
        .mockResolvedValueOnce([])           // stillPending
        .mockResolvedValue([]),
    });
    const broker = makeAdapter({
      getTradebook: vi.fn().mockResolvedValue([tradebookEntry]),
      getOrders: vi.fn().mockResolvedValue([]),
    });

    await syncOrders(broker, store);

    const patch = vi.mocked(store.update).mock.calls[0][1];
    expect(patch).not.toHaveProperty('realizedPnl');
  });

  it('returns zeros and does not throw when broker call fails', async () => {
    const pendingTrade = makePendingTrade();
    const store = makeStore({ list: vi.fn().mockResolvedValue([pendingTrade]) });
    const broker = makeAdapter({
      getTradebook: vi.fn().mockRejectedValue(new Error('Network error')),
    });

    const result = await syncOrders(broker, store);

    expect(result).toEqual({ fillsUpdated: 0, rejectedOrCancelled: 0 });
  });
});
