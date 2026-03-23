/**
 * Integration tests for GET /api/intents/:id/performance
 *
 * Uses real LocalIntentStore + LocalTradeStore backed by a temporary directory.
 * The four unused stores (triggers, portfolios, strategies, approvals) are stubbed
 * with vi.fn() objects. The broker adapter is mocked to control sync and LTP responses.
 *
 * What these tests verify:
 *  - 404 when intent not found
 *  - Zero P&L / empty positions when no trades exist
 *  - unrealizedPnl > 0 when LTP > avgBuyPrice (regression test for the original bug)
 *  - unrealizedPnl < 0 when LTP < avgBuyPrice
 *  - realizedPnl computed when a BUY is fully closed by a SELL
 *  - Pending (non-filled) trades are excluded from open positions
 *  - Graceful 200 when broker.getQuote throws
 *  - syncOrders (broker.getTradebook) is called on each request
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import Fastify from "fastify";
import { intentsRoute } from "../intents.js";
import { LocalIntentStore } from "../../lib/storage/local/intent-store.js";
import { LocalTradeStore } from "../../lib/storage/local/trade-store.js";
import type { Intent, TradeRecord } from "../../lib/storage/types.js";

// ─── mocks ──────────────────────────────────────────────────────────────────

vi.mock("../../lib/credentials.js", () => ({
  getBrokerAdapter: vi.fn(),
  getAnthropicClient: vi.fn(),
}));

vi.mock("../../lib/brokers/dhan/instruments.js", () => ({
  getSecurityId: vi.fn().mockResolvedValue("500325"),
}));

// Mock the Anthropic tools registry — intentsRoute imports TOOLS from tools.ts
vi.mock("../../lib/tools.js", () => ({
  TOOLS: [],
  createRegisterTriggerTool: vi.fn().mockReturnValue({ name: "register_trigger", definition: {}, handler: vi.fn() }),
  createPortfolioTools: vi.fn().mockReturnValue([]),
  createStrategyTools: vi.fn().mockReturnValue([]),
}));

import { getBrokerAdapter } from "../../lib/credentials.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "vibe-perf-test-"));
  vi.clearAllMocks();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeStores() {
  const intents = new LocalIntentStore(tmpDir);
  const trades = new LocalTradeStore(tmpDir);

  // Stub unused stores with minimal vi.fn() shapes
  const triggers = {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue(undefined),
    setStatus: vi.fn().mockResolvedValue(undefined),
    updateNextFireAt: vi.fn().mockResolvedValue(undefined),
    pruneExpired: vi.fn().mockResolvedValue(undefined),
  };

  const portfolios = {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue(undefined),
    setStatus: vi.fn().mockResolvedValue(undefined),
    addStrategy: vi.fn().mockResolvedValue(undefined),
    removeStrategy: vi.fn().mockResolvedValue(undefined),
  };

  const strategies = {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    updatePlan: vi.fn().mockResolvedValue(undefined),
  };

  const approvals = {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    add: vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    pruneExpired: vi.fn().mockResolvedValue(undefined),
  };

  return { intents, trades, triggers, portfolios, strategies, approvals };
}

async function buildApp(stores: ReturnType<typeof makeStores>) {
  const app = Fastify({ logger: false });
  await app.register(intentsRoute, stores);
  return app;
}

function makeIntent(id = "intent-1"): Intent {
  return {
    id,
    text: "Buy RELIANCE on dip",
    status: "active",
    primitives: [],
    createdAt: new Date().toISOString(),
  };
}

function makeTrade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    id: `trade-${Math.random().toString(36).slice(2)}`,
    orderId: `order-${Math.random().toString(36).slice(2)}`,
    symbol: "RELIANCE",
    securityId: "500325",
    transactionType: "BUY",
    quantity: 10,
    orderType: "MARKET",
    requestedPrice: 1500,
    executedPrice: 1500,
    status: "filled",
    intentId: "intent-1",
    createdAt: new Date().toISOString(),
    filledAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeMockBroker(ltpOverride?: number | null) {
  return {
    getTradebook: vi.fn().mockResolvedValue([]),
    getOrders: vi.fn().mockResolvedValue([]),
    getQuote:
      ltpOverride === null
        ? vi.fn().mockRejectedValue(new Error("LTP unavailable"))
        : vi.fn().mockResolvedValue([
            { symbol: "RELIANCE", lastPrice: ltpOverride ?? 2000 },
          ]),
    placeOrder: vi.fn(),
  };
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("GET /api/intents/:id/performance", () => {
  it("case 1 — returns 404 when intent not found", async () => {
    const stores = makeStores();
    vi.mocked(getBrokerAdapter).mockReturnValue(makeMockBroker() as any);
    const app = await buildApp(stores);

    const res = await app.inject({ method: "GET", url: "/api/intents/nonexistent/performance" });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toMatchObject({ error: "Not found" });
  });

  it("case 2 — intent exists but no trades → zero P&L and empty positions", async () => {
    const stores = makeStores();
    await stores.intents.append(makeIntent());
    vi.mocked(getBrokerAdapter).mockReturnValue(makeMockBroker() as any);
    const app = await buildApp(stores);

    const res = await app.inject({ method: "GET", url: "/api/intents/intent-1/performance" });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.tradeCount).toBe(0);
    expect(body.unrealizedPnl).toBe(0);
    expect(body.realizedPnl).toBe(0);
    expect(body.openPositions).toEqual([]);
  });

  it("case 3 — one filled BUY, LTP above cost → unrealizedPnl > 0", async () => {
    const stores = makeStores();
    await stores.intents.append(makeIntent());
    // executedPrice=1500, qty=10, LTP=2000 → unrealized = (2000-1500)*10 = 5000
    await stores.trades.append(makeTrade({ executedPrice: 1500, quantity: 10 }));
    vi.mocked(getBrokerAdapter).mockReturnValue(makeMockBroker(2000) as any);
    const app = await buildApp(stores);

    const res = await app.inject({ method: "GET", url: "/api/intents/intent-1/performance" });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.unrealizedPnl).toBe(5000);
    expect(body.openPositions).toHaveLength(1);
    expect(body.openPositions[0].ltp).toBe(2000);
    expect(body.openPositions[0].unrealizedPnl).toBe(5000);
  });

  it("case 4 — one filled BUY, LTP below cost → unrealizedPnl < 0", async () => {
    const stores = makeStores();
    await stores.intents.append(makeIntent());
    // executedPrice=1500, qty=10, LTP=1200 → unrealized = (1200-1500)*10 = -3000
    await stores.trades.append(makeTrade({ executedPrice: 1500, quantity: 10 }));
    vi.mocked(getBrokerAdapter).mockReturnValue(makeMockBroker(1200) as any);
    const app = await buildApp(stores);

    const res = await app.inject({ method: "GET", url: "/api/intents/intent-1/performance" });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.unrealizedPnl).toBe(-3000);
    expect(body.openPositions[0].unrealizedPnl).toBe(-3000);
  });

  it("case 5 — BUY then full SELL → realizedPnl non-zero, no open positions, unrealizedPnl=0", async () => {
    const stores = makeStores();
    await stores.intents.append(makeIntent());
    const t0 = new Date("2026-01-01T09:00:00Z").toISOString();
    const t1 = new Date("2026-01-01T10:00:00Z").toISOString();
    // BUY 10 @ 1500, SELL 10 @ 1800 → realized = (1800-1500)*10 = 3000
    await stores.trades.append(makeTrade({ transactionType: "BUY", executedPrice: 1500, quantity: 10, createdAt: t0, filledAt: t0 }));
    await stores.trades.append(makeTrade({ transactionType: "SELL", executedPrice: 1800, quantity: 10, createdAt: t1, filledAt: t1 }));
    vi.mocked(getBrokerAdapter).mockReturnValue(makeMockBroker(1800) as any);
    const app = await buildApp(stores);

    const res = await app.inject({ method: "GET", url: "/api/intents/intent-1/performance" });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.realizedPnl).toBe(3000);
    expect(body.openPositions).toEqual([]);
    expect(body.unrealizedPnl).toBe(0);
  });

  it("case 6 — pending trade is ignored (not counted in open positions)", async () => {
    const stores = makeStores();
    await stores.intents.append(makeIntent());
    await stores.trades.append(makeTrade({ status: "pending" }));
    vi.mocked(getBrokerAdapter).mockReturnValue(makeMockBroker(2000) as any);
    const app = await buildApp(stores);

    const res = await app.inject({ method: "GET", url: "/api/intents/intent-1/performance" });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.openPositions).toEqual([]);
    expect(body.unrealizedPnl).toBe(0);
    // The pending trade IS included in tradeCount (all trades listed)
    expect(body.tradeCount).toBe(1);
  });

  it("case 7 — broker.getQuote throws → 200 with position returned but no ltp, unrealizedPnl=0", async () => {
    const stores = makeStores();
    await stores.intents.append(makeIntent());
    await stores.trades.append(makeTrade({ executedPrice: 1500, quantity: 10 }));
    // getQuote will throw but getTradebook for sync must succeed
    vi.mocked(getBrokerAdapter)
      .mockReturnValueOnce({ getTradebook: vi.fn().mockResolvedValue([]), getOrders: vi.fn().mockResolvedValue([]) } as any)
      .mockReturnValueOnce({ getQuote: vi.fn().mockRejectedValue(new Error("timeout")) } as any);
    const app = await buildApp(stores);

    const res = await app.inject({ method: "GET", url: "/api/intents/intent-1/performance" });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.unrealizedPnl).toBe(0);
    expect(body.openPositions).toHaveLength(1);
    expect(body.openPositions[0].ltp).toBeUndefined();
  });

  it("case 8 — broker.getTradebook is called once per request when pending trades exist (syncOrders runs)", async () => {
    const stores = makeStores();
    await stores.intents.append(makeIntent());
    // A pending trade causes syncOrders to proceed past the early-return guard
    await stores.trades.append(makeTrade({ status: "pending" }));
    const broker = makeMockBroker();
    vi.mocked(getBrokerAdapter).mockReturnValue(broker as any);
    const app = await buildApp(stores);

    await app.inject({ method: "GET", url: "/api/intents/intent-1/performance" });

    expect(broker.getTradebook).toHaveBeenCalledOnce();
  });
});
