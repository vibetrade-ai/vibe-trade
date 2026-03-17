import type { FastifyInstance } from "fastify";
import type { StrategyStore, TriggerStore, TradeStore, TradeRecord } from "../lib/storage/index.js";
import type { DhanClient } from "../lib/dhan/client.js";
import { getDhanClient } from "../lib/credentials.js";
import { computeOpenPositions, computeRealizedPnl } from "../lib/trade-utils.js";
import { syncOrders } from "../lib/order-sync.js";

export async function strategiesRoute(
  fastify: FastifyInstance,
  opts: { strategies: StrategyStore; triggers: TriggerStore; trades: TradeStore },
) {
  // GET /api/strategies — list
  fastify.get("/api/strategies", async (request) => {
    const query = request.query as { status?: string };
    const statusFilter = query.status === "archived" ? "archived" : query.status === "all" ? undefined : "active";
    if (query.status === "all") {
      const [active, archived] = await Promise.all([
        opts.strategies.list({ status: "active" }),
        opts.strategies.list({ status: "archived" }),
      ]);
      return [...active, ...archived];
    }
    return opts.strategies.list(statusFilter ? { status: statusFilter as "active" | "archived" } : undefined);
  });

  // POST /api/strategies — create
  fastify.post("/api/strategies", async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const { randomUUID } = await import("crypto");
    const now = new Date().toISOString();
    const strategy = {
      id: randomUUID(),
      name: body.name as string,
      description: body.description as string,
      plan: body.plan as string,
      allocation: body.allocation as number,
      state: (body.state as string ?? "scanning") as import("../lib/storage/types.js").StrategyState,
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    };
    await opts.strategies.upsert(strategy);
    reply.code(201);
    return strategy;
  });

  // GET /api/strategies/:id — get with linked triggers
  fastify.get("/api/strategies/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const strategy = await opts.strategies.get(id);
    if (!strategy) {
      reply.code(404);
      return { error: "Not found" };
    }
    const allTriggers = await opts.triggers.list({ status: ["active", "paused"] });
    const linkedTriggers = allTriggers.filter(t => t.strategyId === id);
    return { ...strategy, linkedTriggers };
  });

  // PATCH /api/strategies/:id/state — update state
  fastify.patch("/api/strategies/:id/state", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { state: string };
    const strategy = await opts.strategies.get(id);
    if (!strategy) {
      reply.code(404);
      return { error: "Not found" };
    }
    await opts.strategies.setState(id, body.state as import("../lib/storage/types.js").StrategyState);
    return { success: true };
  });

  // PATCH /api/strategies/:id/plan — update plan text
  fastify.patch("/api/strategies/:id/plan", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { plan: string };
    const strategy = await opts.strategies.get(id);
    if (!strategy) {
      reply.code(404);
      return { error: "Not found" };
    }
    await opts.strategies.updatePlan(id, body.plan);
    return { success: true };
  });

  // DELETE /api/strategies/:id — archive (with open-position guard + cascade)
  fastify.delete("/api/strategies/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const strategy = await opts.strategies.get(id);
    if (!strategy) { reply.code(404); return { error: "Not found" }; }

    // Guard: block archive if strategy has open positions
    const filled = await opts.trades.list({ strategyId: id, status: "filled" });
    const openPositions = computeOpenPositions(filled);
    if (openPositions.length > 0) {
      reply.code(409);
      return {
        error: "Strategy has open positions",
        openPositions: openPositions.map(p => ({ symbol: p.symbol, quantity: p.quantity })),
        hint: "Close all tagged positions in Dhan before archiving",
      };
    }

    // Cascade: cancel active and paused triggers
    const linkedTriggers = await opts.triggers.list({ status: ["active", "paused"] });
    const triggersCancelled = linkedTriggers.filter(t => t.strategyId === id);

    await Promise.all(triggersCancelled.map(t => opts.triggers.setStatus(t.id, "cancelled")));
    await opts.strategies.setStatus(id, "archived");

    return {
      success: true,
      triggersCancelled: triggersCancelled.length,
    };
  });

  // GET /api/strategies/:id/trades — raw trade records for a strategy
  fastify.get("/api/strategies/:id/trades", async (request, reply) => {
    const { id } = request.params as { id: string };
    const strategy = await opts.strategies.get(id);
    if (!strategy) { reply.code(404); return { error: "Not found" }; }
    return opts.trades.list({ strategyId: id });
  });

  // GET /api/strategies/:id/performance — aggregated P&L stats
  fastify.get("/api/strategies/:id/performance", async (request, reply) => {
    const { id } = request.params as { id: string };
    const strategy = await opts.strategies.get(id);
    if (!strategy) { reply.code(404); return { error: "Not found" }; }

    const allTrades = await opts.trades.list({ strategyId: id });
    const filled = allTrades.filter(t => t.status === "filled");
    const buys = filled.filter(t => t.transactionType === "BUY");
    const sells = filled.filter(t => t.transactionType === "SELL");
    const sellsWithPnl = sells.filter(t => t.realizedPnl !== undefined);

    const totalRealizedPnl = +sellsWithPnl.reduce((s, t) => s + t.realizedPnl!, 0).toFixed(2);
    const winRate = sellsWithPnl.length > 0
      ? +(sellsWithPnl.filter(t => t.realizedPnl! > 0).length / sellsWithPnl.length).toFixed(2)
      : null;
    const bestTrade = sellsWithPnl.reduce<TradeRecord | null>((b, t) => !b || t.realizedPnl! > b.realizedPnl! ? t : b, null);
    const worstTrade = sellsWithPnl.reduce<TradeRecord | null>((w, t) => !w || t.realizedPnl! < w.realizedPnl! ? t : w, null);

    // Open positions: net qty per symbol from filled trades
    const openPositions = computeOpenPositions(filled);

    const deployedCapital = openPositions.reduce((s, p) => s + p.deployedCapital, 0);

    return {
      strategyId: id,
      strategyName: strategy.name,
      allocation: strategy.allocation,
      deployedCapital: +deployedCapital.toFixed(2),
      totalTrades: allTrades.length,
      filledTrades: filled.length,
      pendingTrades: allTrades.filter(t => t.status === "pending").length,
      buyTrades: buys.length,
      sellTrades: sells.length,
      totalRealizedPnl,
      winRate,
      bestTrade: bestTrade ? { symbol: bestTrade.symbol, pnl: bestTrade.realizedPnl!, date: bestTrade.filledAt } : null,
      worstTrade: worstTrade ? { symbol: worstTrade.symbol, pnl: worstTrade.realizedPnl!, date: worstTrade.filledAt } : null,
      openPositions,
    };
  });

  // POST /api/trades/sync — pull Dhan tradebook and update pending records
  fastify.post("/api/trades/sync", async (_request, reply) => {
    let dhan: DhanClient;
    try {
      dhan = getDhanClient();
    } catch {
      reply.code(503);
      return { error: "Dhan credentials not configured" };
    }

    let tradebookEntries = 0;
    try {
      const raw = await dhan.getTradebook();
      tradebookEntries = Array.isArray(raw) ? (raw as unknown[]).length : 0;
    } catch (err) {
      console.error("[trades/sync] tradebook fetch failed:", err);
    }
    const { fillsUpdated: updated } = await syncOrders(dhan, opts.trades);
    return { tradebookEntries, updated };
  });

  // GET /api/trades — all trades, optionally filtered
  fastify.get("/api/trades", async (request) => {
    const q = request.query as { strategyId?: string; symbol?: string; status?: string };
    return opts.trades.list({
      strategyId: q.strategyId,
      symbol: q.symbol,
      status: q.status as import("../lib/storage/types.js").TradeStatus | undefined,
    });
  });
}
