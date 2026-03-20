import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DhanClient } from '../../dhan/client.js';
import { BrokerAuthError } from '../../errors.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { get: (key: string) => headers[key] ?? null },
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

describe('DhanClient constructor', () => {
  it('throws when accessToken is missing', () => {
    expect(() => new DhanClient('', 'client-id')).toThrow('Missing Dhan credentials');
  });

  it('throws when clientId is missing', () => {
    expect(() => new DhanClient('token', '')).toThrow('Missing Dhan credentials');
  });

  it('constructs successfully with valid credentials', () => {
    expect(() => new DhanClient('token', 'client-id')).not.toThrow();
  });
});

describe('DhanClient HTTP layer', () => {
  let client: DhanClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new DhanClient('test-token', 'test-client-id');
  });

  it('sends correct auth headers', async () => {
    mockFetch.mockResolvedValue(makeResponse({ ok: true }));

    await client.getPositions();

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.dhan.co/v2/positions',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'access-token': 'test-token',
          'client-id': 'test-client-id',
          'Content-Type': 'application/json',
        }),
      })
    );
  });

  it('serialises body as JSON for POST requests', async () => {
    mockFetch.mockResolvedValue(makeResponse({ orderId: '123' }));

    await client.placeOrder({ symbol: 'RELIANCE', securityId: '500325', transactionType: 'BUY', quantity: 5, orderType: 'MARKET' });

    const call = mockFetch.mock.calls[0][1];
    expect(JSON.parse(call.body)).toMatchObject({ tradingSymbol: 'RELIANCE', quantity: 5 });
  });

  it('returns parsed JSON on success', async () => {
    mockFetch.mockResolvedValue(makeResponse([{ orderId: 'ORD001' }]));

    const result = await client.getOrders();
    expect(result).toEqual([{ orderId: 'ORD001' }]);
  });

  it('throws BrokerAuthError when DH-901 error code is returned', async () => {
    mockFetch.mockResolvedValue(makeResponse({ errorCode: 'DH-901', errorMessage: 'Expired' }, 401));

    await expect(client.getPositions()).rejects.toThrow(BrokerAuthError);
  });

  it('throws generic Error with message for non-auth API errors', async () => {
    mockFetch.mockResolvedValue(makeResponse(
      { errorCode: 'DH-500', errorMessage: 'Bad symbol' }, 400
    ));

    await expect(client.getOrders()).rejects.toThrow(/Bad symbol/);
  });

  it('formats "status: failed" error response with field details', async () => {
    mockFetch.mockResolvedValue(makeResponse(
      { status: 'failed', data: { '600': 'Quantity must be positive' } }, 400
    ));

    await expect(client.getOrders()).rejects.toMatchObject({
      message: expect.stringMatching(/Quantity must be positive/),
    });
    await expect(client.getOrders()).rejects.toMatchObject({
      message: expect.stringMatching(/code 600/),
    });
  });

  it('throws on non-ok response with plain text body', async () => {
    mockFetch.mockResolvedValue(makeResponse('Service Unavailable', 503));

    await expect(client.getPositions()).rejects.toThrow(/503/);
  });

  describe('429 retry logic', () => {
    it('retries on 429 and succeeds on subsequent attempt', async () => {
      mockFetch
        .mockResolvedValueOnce(makeResponse('', 429, { 'Retry-After': '0' }))
        .mockResolvedValueOnce(makeResponse({ ok: true }));

      const result = await client.getPositions();
      expect(result).toEqual({ ok: true });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('throws after exhausting all retries on persistent 429', async () => {
      // After 3 retries the final attempt falls through the retry guard and throws a 429 error
      mockFetch.mockResolvedValue(makeResponse('', 429, { 'Retry-After': '0' }));

      await expect(client.getPositions()).rejects.toThrow(/429/);
      expect(mockFetch).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    });

    it('uses Retry-After header for wait time when present', async () => {
      const waitSpy = vi.spyOn(global, 'setTimeout').mockImplementation((fn: any) => { fn(); return 0 as any; });

      mockFetch
        .mockResolvedValueOnce(makeResponse('', 429, { 'Retry-After': '2' }))
        .mockResolvedValueOnce(makeResponse({ ok: true }));

      await client.getPositions();

      expect(waitSpy).toHaveBeenCalledWith(expect.any(Function), 2000);
      waitSpy.mockRestore();
    });
  });
});

describe('DhanClient.getHistory', () => {
  let client: DhanClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new DhanClient('token', 'client-id');
    mockFetch.mockResolvedValue(makeResponse({ timestamp: [], open: [], high: [], low: [], close: [], volume: [] }));
  });

  it('calls /charts/historical for daily interval', async () => {
    await client.getHistory('500325', 'D', '2024-01-01', '2024-01-31', 'NSE_EQ', 'EQUITY');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(mockFetch.mock.calls[0][0]).toContain('/charts/historical');
    expect(body).toMatchObject({ securityId: '500325', fromDate: '2024-01-01', toDate: '2024-01-31', expiryCode: 0 });
  });

  it('calls /charts/intraday for minute intervals', async () => {
    await client.getHistory('500325', '5', '2024-01-01', '2024-01-02', 'NSE_EQ', 'EQUITY');

    expect(mockFetch.mock.calls[0][0]).toContain('/charts/intraday');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.interval).toBe('5');
  });
});

describe('DhanClient.placeOrder', () => {
  let client: DhanClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new DhanClient('token', 'client-id');
    mockFetch.mockResolvedValue(makeResponse({ orderId: 'ORD001' }));
  });

  it('sets price=0 for MARKET orders', async () => {
    await client.placeOrder({ symbol: 'RELIANCE', securityId: '500325', transactionType: 'BUY', quantity: 10, orderType: 'MARKET' });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.price).toBe(0);
  });

  it('sets price from params for LIMIT orders', async () => {
    await client.placeOrder({ symbol: 'RELIANCE', securityId: '500325', transactionType: 'BUY', quantity: 10, orderType: 'LIMIT', price: 1500 });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.price).toBe(1500);
  });

  it('defaults productType to INTRADAY when not provided', async () => {
    await client.placeOrder({ symbol: 'RELIANCE', securityId: '500325', transactionType: 'BUY', quantity: 5, orderType: 'MARKET' });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.productType).toBe('INTRADAY');
  });

  it('includes dhanClientId in request body', async () => {
    await client.placeOrder({ symbol: 'RELIANCE', securityId: '500325', transactionType: 'BUY', quantity: 1, orderType: 'MARKET' });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.dhanClientId).toBe('client-id');
  });
});
