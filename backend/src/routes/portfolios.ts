import type { FastifyInstance } from "fastify";
import type { PortfolioStore, TriggerStore, TradeStore, TradeRecord } from "../lib/storage/index.js";
import { computeOpenPositions } from "../lib/trade-utils.js";

export async function portfoliosRoute(
  fastify: FastifyInstance,
  opts: { portfolios: PortfolioStore; triggers: TriggerStore; trades: TradeStore },
) {
  // GET /api/portfolios — list active portfolios
  fastify.get("/api/portfolios", async (request) => {
    const query = request.query as { status?: string };
    if (query.status === "all") {
      return opts.portfolios.list();
    }
    const status = (query.status as import("../lib/storage/types.js").PortfolioStatus | undefined) ?? "active";
    return opts.portfolios.list({ status });
  });

  // POST /api/portfolios — create
  fastify.post("/api/portfolios", async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const { randomUUID } = await import("crypto");
    const now = new Date().toISOString();
    const portfolio = {
      id: randomUUID(),
      name: body.name as string,
      description: (body.description as string) ?? "",
      allocation: body.allocation as number,
      benchmark: body.benchmark as string | undefined,
      strategyIds: (body.strategyIds as string[]) ?? [],
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    };
    await opts.portfolios.upsert(portfolio);
    reply.code(201);
    return portfolio;
  });

  // GET /api/portfolios/:id — detail + linked triggers
  fastify.get("/api/portfolios/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const portfolio = await opts.portfolios.get(id);
    if (!portfolio) {
      reply.code(404);
      return { error: "Not found" };
    }
    const allTriggers = await opts.triggers.list({ status: ["active", "paused"] });
    const linkedTriggers = allTriggers.filter(t => t.portfolioId === id);
    return { ...portfolio, linkedTriggers };
  });

  // PATCH /api/portfolios/:id/status — pause / archive
  fastify.patch("/api/portfolios/:id/status", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { status: string };
    const portfolio = await opts.portfolios.get(id);
    if (!portfolio) {
      reply.code(404);
      return { error: "Not found" };
    }
    await opts.portfolios.setStatus(id, body.status as import("../lib/storage/types.js").PortfolioStatus);
    return { success: true };
  });

  // POST /api/portfolios/:id/strategies/:strategyId — attach strategy
  fastify.post("/api/portfolios/:id/strategies/:strategyId", async (request, reply) => {
    const { id, strategyId } = request.params as { id: string; strategyId: string };
    const portfolio = await opts.portfolios.get(id);
    if (!portfolio) {
      reply.code(404);
      return { error: "Not found" };
    }
    await opts.portfolios.addStrategy(id, strategyId);
    return { success: true };
  });

  // DELETE /api/portfolios/:id/strategies/:strategyId — detach strategy
  fastify.delete("/api/portfolios/:id/strategies/:strategyId", async (request, reply) => {
    const { id, strategyId } = request.params as { id: string; strategyId: string };
    const portfolio = await opts.portfolios.get(id);
    if (!portfolio) {
      reply.code(404);
      return { error: "Not found" };
    }
    await opts.portfolios.removeStrategy(id, strategyId);
    return { success: true };
  });

  // GET /api/portfolios/:id/performance — P&L, win rate, deployed capital, open positions
  fastify.get("/api/portfolios/:id/performance", async (request, reply) => {
    const { id } = request.params as { id: string };
    const portfolio = await opts.portfolios.get(id);
    if (!portfolio) {
      reply.code(404);
      return { error: "Not found" };
    }

    const allTrades = await opts.trades.list({ portfolioId: id });
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

    const openPositions = computeOpenPositions(filled);
    const deployedCapital = openPositions.reduce((s, p) => s + p.deployedCapital, 0);

    return {
      portfolioId: id,
      portfolioName: portfolio.name,
      allocation: portfolio.allocation,
      deployedCapital: +deployedCapital.toFixed(2),
      availableCapital: +(portfolio.allocation - deployedCapital).toFixed(2),
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

  // GET /api/portfolios/:id/trades — trade history for this portfolio
  fastify.get("/api/portfolios/:id/trades", async (request, reply) => {
    const { id } = request.params as { id: string };
    const portfolio = await opts.portfolios.get(id);
    if (!portfolio) {
      reply.code(404);
      return { error: "Not found" };
    }
    return opts.trades.list({ portfolioId: id });
  });
}
