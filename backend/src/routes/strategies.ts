import type { FastifyInstance } from "fastify";
import type { StrategyStore, TriggerStore, TradeStore } from "../lib/storage/index.js";
import { computeOpenPositions } from "../lib/trade-utils.js";

export async function strategiesRoute(
  fastify: FastifyInstance,
  opts: { strategies: StrategyStore; triggers: TriggerStore; trades: TradeStore },
) {
  // GET /api/strategies — list all
  fastify.get("/api/strategies", async () => {
    return opts.strategies.list();
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

  // DELETE /api/strategies/:id — delete (with open-position guard + cascade)
  fastify.delete("/api/strategies/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const strategy = await opts.strategies.get(id);
    if (!strategy) { reply.code(404); return { error: "Not found" }; }

    // Guard: block delete if strategy has open positions
    const filled = await opts.trades.list({ strategyId: id, status: "filled" });
    const openPositions = computeOpenPositions(filled);
    if (openPositions.length > 0) {
      reply.code(409);
      return {
        error: "Strategy has open positions",
        openPositions: openPositions.map(p => ({ symbol: p.symbol, quantity: p.quantity })),
        hint: "Close all tagged positions in the broker before deleting",
      };
    }

    // Cascade: cancel active and paused triggers
    const linkedTriggers = await opts.triggers.list({ status: ["active", "paused"] });
    const triggersCancelled = linkedTriggers.filter(t => t.strategyId === id);

    await Promise.all(triggersCancelled.map(t => opts.triggers.setStatus(t.id, "cancelled")));
    await opts.strategies.delete(id);

    return {
      success: true,
      triggersCancelled: triggersCancelled.length,
    };
  });

}
