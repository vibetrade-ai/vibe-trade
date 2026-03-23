import type { FastifyInstance } from "fastify";
import { randomUUID } from "crypto";
import { getBrokerAdapter } from "../lib/credentials.js";
import type { ApprovalStore, TriggerStore, TradeStore } from "../lib/storage/index.js";
import { getSecurityId } from "../lib/brokers/dhan/instruments.js";

export async function approvalsRoute(
  fastify: FastifyInstance,
  opts: { approvals: ApprovalStore; triggers: TriggerStore; trades: TradeStore }
) {
  // GET /api/approvals?status=pending|approved|rejected|expired|all
  fastify.get("/api/approvals", async (request) => {
    const status = (request.query as { status?: string }).status ?? "pending";
    if (status === "all") return opts.approvals.list();
    return opts.approvals.list({ status: status as "pending" | "approved" | "rejected" | "expired" });
  });

  // POST /api/approvals/:id/decide
  fastify.post<{ Params: { id: string }; Body: { decision: "approved" | "rejected" } }>(
    "/api/approvals/:id/decide",
    async (request, reply) => {
      const { id } = request.params;
      const { decision } = request.body;

      const approval = await opts.approvals.get(id);
      if (!approval) {
        reply.code(404);
        return { ok: false, error: "Approval not found" };
      }
      if (approval.status !== "pending") {
        reply.code(409);
        return { ok: false, error: `Approval already ${approval.status}` };
      }

      const decidedAt = new Date().toISOString();

      if (decision === "rejected") {
        await opts.approvals.updateStatus(id, "rejected", decidedAt);
        return { ok: true };
      }

      // Approved
      if (approval.kind === "trade") {
        try {
          const broker = getBrokerAdapter();
          const ta = approval.tradeArgs;
          const result = await broker.placeOrder({
            symbol: ta.symbol,
            side: ta.transaction_type,
            quantity: ta.quantity,
            orderType: ta.order_type,
            productType: ta.product_type === "INTRADAY" ? "INTRADAY" : "DELIVERY",
            price: ta.price,
          });
          await opts.approvals.updateStatus(id, "approved", decidedAt);

          const securityId = await getSecurityId(ta.symbol).catch(() => "unknown");
          await opts.trades.append({
            id: randomUUID(),
            orderId: result.orderId ?? randomUUID(),
            symbol: ta.symbol.toUpperCase(),
            securityId,
            transactionType: ta.transaction_type,
            quantity: ta.quantity,
            orderType: ta.order_type,
            requestedPrice: ta.price,
            status: "pending",
            strategyId: approval.strategyId,
            portfolioId: approval.portfolioId,
            intentId: approval.intentId,
            note: `Approved trade (approval ${id})`,
            createdAt: new Date().toISOString(),
          });

          return { ok: true, orderId: result.orderId };
        } catch (err) {
          reply.code(500);
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      } else {
        // hard_trigger approval
        const proposed = approval.proposedTrigger;
        await opts.triggers.upsert({
          id: randomUUID(),
          name: proposed.name,
          scope: proposed.scope,
          watchSymbols: proposed.watchSymbols,
          condition: proposed.condition,
          action: proposed.action,
          expiresAt: proposed.expiresAt,
          createdAt: new Date().toISOString(),
          active: true,
          status: "active",
          ...(proposed.intentId ? { intentId: proposed.intentId } : {}),
          ...(proposed.portfolioId ? { portfolioId: proposed.portfolioId } : {}),
          ...(proposed.strategyId ? { strategyId: proposed.strategyId } : {}),
        });
        await opts.approvals.updateStatus(id, "approved", decidedAt);
        return { ok: true };
      }
    }
  );
}
