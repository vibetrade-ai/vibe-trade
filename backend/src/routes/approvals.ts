import type { FastifyInstance } from "fastify";
import { randomUUID } from "crypto";
import { DhanClient } from "../lib/dhan/client.js";
import { getSecurityId } from "../lib/dhan/instruments.js";
import type { ApprovalStore, TriggerStore } from "../lib/storage/index.js";

export async function approvalsRoute(
  fastify: FastifyInstance,
  opts: { approvals: ApprovalStore; triggers: TriggerStore }
) {
  // GET /api/approvals?status=pending|approved|rejected|expired|all
  fastify.get("/api/approvals", async (request) => {
    const status = (request.query as { status?: string }).status ?? "pending";
    if (status === "all") {
      return opts.approvals.list({ status: "pending" as const }).then(() =>
        opts.approvals.list({ status: "pending" as const })
      );
    }
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
          const dhan = new DhanClient();
          const ta = approval.tradeArgs;
          const securityId = await getSecurityId(ta.symbol);
          const result = await dhan.placeOrder({
            symbol: ta.symbol,
            securityId,
            transactionType: ta.transaction_type,
            quantity: ta.quantity,
            orderType: ta.order_type,
            price: ta.price,
          });
          await opts.approvals.updateStatus(id, "approved", decidedAt);
          return { ok: true, orderId: (result as Record<string, unknown>)["orderId"] };
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
        });
        await opts.approvals.updateStatus(id, "approved", decidedAt);
        return { ok: true };
      }
    }
  );
}
