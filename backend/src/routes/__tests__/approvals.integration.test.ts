/**
 * Integration tests for the approvals route.
 *
 * Uses real LocalApprovalStore + LocalTradeStore + LocalTriggerStore backed by a
 * temporary directory on disk. Only the broker adapter is mocked — no live API
 * calls are made, so this suite runs fine outside market hours.
 *
 * What these tests verify that the unit tests cannot:
 *  - Trade records are actually persisted to trades.json
 *  - Approval status is actually updated in approvals.json
 *  - intentId round-trips correctly through file storage
 *  - GET ?status=all returns every approval regardless of status
 *  - Duplicate-orderId guard in LocalTradeStore is exercised
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import Fastify from "fastify";
import { approvalsRoute } from "../approvals.js";
import { LocalApprovalStore } from "../../lib/storage/local/approval-store.js";
import { LocalTradeStore } from "../../lib/storage/local/trade-store.js";
import { LocalTriggerStore } from "../../lib/storage/local/trigger-store.js";
import type { PendingApproval } from "../../lib/heartbeat/types.js";

vi.mock("../../lib/credentials.js", () => ({
  getBrokerAdapter: vi.fn(),
}));
vi.mock("../../lib/brokers/dhan/instruments.js", () => ({
  getSecurityId: vi.fn().mockResolvedValue("500325"),
}));

import { getBrokerAdapter } from "../../lib/credentials.js";

// ─── helpers ────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "vibe-approvals-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeStores() {
  return {
    approvals: new LocalApprovalStore(tmpDir),
    triggers: new LocalTriggerStore(tmpDir),
    trades: new LocalTradeStore(tmpDir),
  };
}

async function buildApp(stores: ReturnType<typeof makeStores>) {
  const app = Fastify({ logger: false });
  await app.register(approvalsRoute, stores);
  return app;
}

function pendingTradeApproval(id = "appr-1"): PendingApproval {
  return {
    id,
    kind: "trade",
    triggerId: "trig-1",
    triggerName: "Buy RELIANCE on dip",
    reasoning: "RSI < 30",
    tradeArgs: {
      symbol: "RELIANCE",
      transaction_type: "BUY",
      quantity: 5,
      order_type: "MARKET",
    },
    status: "pending",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    strategyId: "strat-99",
    intentId: "intent-42",
  };
}

async function readJsonFile(path: string) {
  return JSON.parse(await readFile(path, "utf-8"));
}

// ─── GET /api/approvals ─────────────────────────────────────────────────────

describe("GET /api/approvals — real storage", () => {
  it("returns empty array when no approvals exist", async () => {
    const stores = makeStores();
    const app = await buildApp(stores);

    const res = await app.inject({ method: "GET", url: "/api/approvals" });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it("returns only pending approvals by default", async () => {
    const stores = makeStores();
    const approval = pendingTradeApproval();
    await stores.approvals.add(approval);
    await stores.approvals.updateStatus(approval.id, "approved");

    // Add a second pending one
    const pending = pendingTradeApproval("appr-2");
    await stores.approvals.add(pending);

    const app = await buildApp(stores);
    const res = await app.inject({ method: "GET", url: "/api/approvals" });
    const body = JSON.parse(res.body) as PendingApproval[];

    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("appr-2");
  });

  it("status=all returns approvals of every status from disk", async () => {
    const stores = makeStores();
    const a1 = pendingTradeApproval("appr-pending");
    const a2 = pendingTradeApproval("appr-approved");
    const a3 = pendingTradeApproval("appr-rejected");

    await stores.approvals.add(a1);
    await stores.approvals.add(a2);
    await stores.approvals.add(a3);
    await stores.approvals.updateStatus("appr-approved", "approved");
    await stores.approvals.updateStatus("appr-rejected", "rejected");

    const app = await buildApp(stores);
    const res = await app.inject({ method: "GET", url: "/api/approvals?status=all" });
    const body = JSON.parse(res.body) as PendingApproval[];

    expect(res.statusCode).toBe(200);
    expect(body).toHaveLength(3);
    const statuses = body.map(a => a.status).sort();
    expect(statuses).toEqual(["approved", "pending", "rejected"]);
  });
});

// ─── POST decide — rejection ─────────────────────────────────────────────────

describe("POST decide — rejection, real storage", () => {
  it("persists rejected status to approvals.json and writes no trade", async () => {
    const stores = makeStores();
    const approval = pendingTradeApproval();
    await stores.approvals.add(approval);

    const app = await buildApp(stores);
    const res = await app.inject({
      method: "POST",
      url: `/api/approvals/${approval.id}/decide`,
      payload: { decision: "rejected" },
    });

    expect(res.statusCode).toBe(200);

    // Verify the file was updated
    const approvalsOnDisk = await readJsonFile(join(tmpDir, "approvals.json")) as PendingApproval[];
    expect(approvalsOnDisk[0].status).toBe("rejected");
    expect(approvalsOnDisk[0].decidedAt).toBeTruthy();

    // Confirm no trades.json was created
    await expect(readJsonFile(join(tmpDir, "trades.json"))).rejects.toThrow();
  });
});

// ─── POST decide — approval ──────────────────────────────────────────────────

describe("POST decide — trade approval, real storage", () => {
  beforeEach(() => {
    vi.mocked(getBrokerAdapter).mockReturnValue({
      placeOrder: vi.fn().mockResolvedValue({ orderId: "broker-order-77" }),
    } as any);
  });

  it("writes trade record to trades.json with all fields intact", async () => {
    const stores = makeStores();
    const approval = pendingTradeApproval();
    await stores.approvals.add(approval);

    const app = await buildApp(stores);
    const res = await app.inject({
      method: "POST",
      url: `/api/approvals/${approval.id}/decide`,
      payload: { decision: "approved" },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, orderId: "broker-order-77" });

    const tradesOnDisk = await readJsonFile(join(tmpDir, "trades.json")) as any[];
    expect(tradesOnDisk).toHaveLength(1);

    const trade = tradesOnDisk[0];
    expect(trade.orderId).toBe("broker-order-77");
    expect(trade.symbol).toBe("RELIANCE");
    expect(trade.transactionType).toBe("BUY");
    expect(trade.quantity).toBe(5);
    expect(trade.orderType).toBe("MARKET");
    expect(trade.status).toBe("pending");
    expect(trade.strategyId).toBe("strat-99");
    expect(trade.intentId).toBe("intent-42");      // Fix 3: must survive file round-trip
    expect(trade.id).toBeTruthy();
    expect(trade.createdAt).toBeTruthy();
  });

  it("persists approved status and decidedAt to approvals.json", async () => {
    const stores = makeStores();
    const approval = pendingTradeApproval();
    await stores.approvals.add(approval);

    const app = await buildApp(stores);
    await app.inject({
      method: "POST",
      url: `/api/approvals/${approval.id}/decide`,
      payload: { decision: "approved" },
    });

    const approvalsOnDisk = await readJsonFile(join(tmpDir, "approvals.json")) as PendingApproval[];
    expect(approvalsOnDisk[0].status).toBe("approved");
    expect(approvalsOnDisk[0].decidedAt).toBeTruthy();
  });

  it("second decide on same approval returns 409 and does not double-write trade", async () => {
    const stores = makeStores();
    const approval = pendingTradeApproval();
    await stores.approvals.add(approval);

    const app = await buildApp(stores);

    // First approval succeeds
    await app.inject({
      method: "POST",
      url: `/api/approvals/${approval.id}/decide`,
      payload: { decision: "approved" },
    });

    // Second attempt on the same approval
    const res = await app.inject({
      method: "POST",
      url: `/api/approvals/${approval.id}/decide`,
      payload: { decision: "approved" },
    });

    expect(res.statusCode).toBe(409);

    // Only one trade record should exist (LocalTradeStore deduplicates on orderId)
    const tradesOnDisk = await readJsonFile(join(tmpDir, "trades.json")) as any[];
    expect(tradesOnDisk).toHaveLength(1);
  });

  it("trade is queryable from TradeStore by intentId after approval", async () => {
    const stores = makeStores();
    const approval = pendingTradeApproval();
    await stores.approvals.add(approval);

    const app = await buildApp(stores);
    await app.inject({
      method: "POST",
      url: `/api/approvals/${approval.id}/decide`,
      payload: { decision: "approved" },
    });

    // This is the query the performance endpoint uses
    const tradesByIntent = await stores.trades.list({ intentId: "intent-42" });
    expect(tradesByIntent).toHaveLength(1);
    expect(tradesByIntent[0].symbol).toBe("RELIANCE");
    expect(tradesByIntent[0].status).toBe("pending");
  });
});
