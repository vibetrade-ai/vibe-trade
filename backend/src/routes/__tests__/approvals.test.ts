import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { approvalsRoute } from "../approvals.js";
import type { ApprovalStore, TriggerStore, TradeStore } from "../../lib/storage/types.js";
import type { PendingApproval } from "../../lib/heartbeat/types.js";

// Mock credentials and instruments so no real API keys / CSV needed
vi.mock("../../lib/credentials.js", () => ({
  getBrokerAdapter: vi.fn(),
}));
vi.mock("../../lib/brokers/dhan/instruments.js", () => ({
  getSecurityId: vi.fn().mockResolvedValue("500325"),
}));

import { getBrokerAdapter } from "../../lib/credentials.js";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeApprovalStore(overrides: Partial<ApprovalStore> = {}): ApprovalStore {
  return {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    add: vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    pruneExpired: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeTriggerStore(overrides: Partial<TriggerStore> = {}): TriggerStore {
  return {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue(undefined),
    setStatus: vi.fn().mockResolvedValue(undefined),
    updateNextFireAt: vi.fn().mockResolvedValue(undefined),
    pruneExpired: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeTradeStore(overrides: Partial<TradeStore> = {}): TradeStore {
  return {
    append: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeTradeApproval(partial: Partial<Extract<PendingApproval, { kind: "trade" }>> = {}): PendingApproval {
  return {
    id: "appr-1",
    kind: "trade",
    triggerId: "trig-1",
    triggerName: "Test trigger",
    reasoning: "Looks good",
    tradeArgs: {
      symbol: "RELIANCE",
      transaction_type: "BUY",
      quantity: 10,
      order_type: "MARKET",
    },
    status: "pending",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    strategyId: "strat-abc",
    intentId: "intent-xyz",
    ...partial,
  };
}

async function buildApp(
  approvals: ApprovalStore,
  triggers: TriggerStore,
  trades: TradeStore,
) {
  const app = Fastify({ logger: false });
  await app.register(approvalsRoute, { approvals, triggers, trades });
  return app;
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe("GET /api/approvals", () => {
  it("lists pending approvals by default", async () => {
    const approvals = makeApprovalStore();
    const app = await buildApp(approvals, makeTriggerStore(), makeTradeStore());

    await app.inject({ method: "GET", url: "/api/approvals" });

    expect(approvals.list).toHaveBeenCalledWith({ status: "pending" });
  });

  it("passes explicit status filter through", async () => {
    const approvals = makeApprovalStore();
    const app = await buildApp(approvals, makeTriggerStore(), makeTradeStore());

    await app.inject({ method: "GET", url: "/api/approvals?status=approved" });

    expect(approvals.list).toHaveBeenCalledWith({ status: "approved" });
  });

  it("calls list() with no filter when status=all", async () => {
    const approvals = makeApprovalStore();
    const app = await buildApp(approvals, makeTriggerStore(), makeTradeStore());

    await app.inject({ method: "GET", url: "/api/approvals?status=all" });

    // list() called once, with no argument (returns everything)
    expect(approvals.list).toHaveBeenCalledTimes(1);
    expect(approvals.list).toHaveBeenCalledWith();
  });
});

describe("POST /api/approvals/:id/decide — rejection", () => {
  it("updates status to rejected and records no trade", async () => {
    const approval = makeTradeApproval();
    const approvals = makeApprovalStore({ get: vi.fn().mockResolvedValue(approval) });
    const trades = makeTradeStore();
    const app = await buildApp(approvals, makeTriggerStore(), trades);

    const res = await app.inject({
      method: "POST",
      url: `/api/approvals/${approval.id}/decide`,
      payload: { decision: "rejected" },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true });
    expect(approvals.updateStatus).toHaveBeenCalledWith(approval.id, "rejected", expect.any(String));
    expect(trades.append).not.toHaveBeenCalled();
  });
});

describe("POST /api/approvals/:id/decide — trade approval", () => {
  beforeEach(() => {
    vi.mocked(getBrokerAdapter).mockReturnValue({
      placeOrder: vi.fn().mockResolvedValue({ orderId: "broker-order-99" }),
    } as any);
  });

  it("returns 404 when approval not found", async () => {
    const approvals = makeApprovalStore({ get: vi.fn().mockResolvedValue(null) });
    const app = await buildApp(approvals, makeTriggerStore(), makeTradeStore());

    const res = await app.inject({
      method: "POST",
      url: "/api/approvals/nonexistent/decide",
      payload: { decision: "approved" },
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 409 when approval is already decided", async () => {
    const approval = makeTradeApproval({ status: "approved" });
    const approvals = makeApprovalStore({ get: vi.fn().mockResolvedValue(approval) });
    const app = await buildApp(approvals, makeTriggerStore(), makeTradeStore());

    const res = await app.inject({
      method: "POST",
      url: `/api/approvals/${approval.id}/decide`,
      payload: { decision: "approved" },
    });

    expect(res.statusCode).toBe(409);
  });

  it("places order and records trade with correct fields", async () => {
    const approval = makeTradeApproval();
    const approvals = makeApprovalStore({ get: vi.fn().mockResolvedValue(approval) });
    const trades = makeTradeStore();
    const app = await buildApp(approvals, makeTriggerStore(), trades);

    const res = await app.inject({
      method: "POST",
      url: `/api/approvals/${approval.id}/decide`,
      payload: { decision: "approved" },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, orderId: "broker-order-99" });

    expect(approvals.updateStatus).toHaveBeenCalledWith(approval.id, "approved", expect.any(String));

    expect(trades.append).toHaveBeenCalledTimes(1);
    const recorded = vi.mocked(trades.append).mock.calls[0][0];
    expect(recorded).toMatchObject({
      orderId: "broker-order-99",
      symbol: "RELIANCE",
      transactionType: "BUY",
      quantity: 10,
      orderType: "MARKET",
      status: "pending",          // heartbeat will sync to filled
      strategyId: "strat-abc",
      intentId: "intent-xyz",     // Fix 3: intentId propagated
    });
    expect(recorded.id).toBeTruthy();
    expect(recorded.createdAt).toBeTruthy();
  });

  it("records trade even when approval has no strategyId or intentId", async () => {
    const approval = makeTradeApproval({ strategyId: undefined, intentId: undefined });
    const approvals = makeApprovalStore({ get: vi.fn().mockResolvedValue(approval) });
    const trades = makeTradeStore();
    const app = await buildApp(approvals, makeTriggerStore(), trades);

    await app.inject({
      method: "POST",
      url: `/api/approvals/${approval.id}/decide`,
      payload: { decision: "approved" },
    });

    const recorded = vi.mocked(trades.append).mock.calls[0][0];
    expect(recorded.strategyId).toBeUndefined();
    expect(recorded.intentId).toBeUndefined();
    expect(recorded.status).toBe("pending");
  });

  it("returns 500 and does not record trade when broker throws", async () => {
    vi.mocked(getBrokerAdapter).mockReturnValue({
      placeOrder: vi.fn().mockRejectedValue(new Error("Broker down")),
    } as any);

    const approval = makeTradeApproval();
    const approvals = makeApprovalStore({ get: vi.fn().mockResolvedValue(approval) });
    const trades = makeTradeStore();
    const app = await buildApp(approvals, makeTriggerStore(), trades);

    const res = await app.inject({
      method: "POST",
      url: `/api/approvals/${approval.id}/decide`,
      payload: { decision: "approved" },
    });

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, error: "Broker down" });
    expect(trades.append).not.toHaveBeenCalled();
  });
});

describe("POST /api/approvals/:id/decide — hard_trigger approval", () => {
  it("upserts trigger and updates approval status", async () => {
    const approval: PendingApproval = {
      id: "appr-hard-1",
      kind: "hard_trigger",
      originatingTriggerId: "trig-orig",
      originatingTriggerName: "Origin",
      reasoning: "Good idea",
      proposedTrigger: {
        name: "New hard trigger",
        scope: "symbol",
        watchSymbols: ["TCS"],
        condition: { mode: "code", expression: "price > 4000" },
        action: { type: "hard_order", tradeArgs: { symbol: "TCS", transaction_type: "BUY", quantity: 5, order_type: "MARKET" } },
        status: "active",
      },
      status: "pending",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };

    const approvals = makeApprovalStore({ get: vi.fn().mockResolvedValue(approval) });
    const triggers = makeTriggerStore();
    const trades = makeTradeStore();
    const app = await buildApp(approvals, triggers, trades);

    const res = await app.inject({
      method: "POST",
      url: `/api/approvals/${approval.id}/decide`,
      payload: { decision: "approved" },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true });
    expect(triggers.upsert).toHaveBeenCalledTimes(1);
    const upserted = vi.mocked(triggers.upsert).mock.calls[0][0];
    expect(upserted).toMatchObject({
      name: "New hard trigger",
      scope: "symbol",
      watchSymbols: ["TCS"],
      active: true,
      status: "active",
    });
    expect(upserted.id).toBeTruthy();   // generated UUID
    expect(trades.append).not.toHaveBeenCalled();
  });
});
