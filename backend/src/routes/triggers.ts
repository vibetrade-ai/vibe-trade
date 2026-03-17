import type { FastifyInstance } from "fastify";
import type { TriggerStore, TriggerAuditStore } from "../lib/storage/index.js";
import { computeNextRunAt, computeNextTradingRunAt } from "../lib/heartbeat/cron-utils.js";

export async function triggersRoute(
  fastify: FastifyInstance,
  opts: { triggers: TriggerStore; triggerAudit: TriggerAuditStore }
) {
  // GET /api/triggers — active + paused triggers
  fastify.get("/api/triggers", async () => {
    return opts.triggers.list({ status: ["active", "paused"] });
  });

  // GET /api/triggers/audit — full fire history, newest first
  fastify.get("/api/triggers/audit", async () => {
    return opts.triggerAudit.list();
  });

  // POST /api/triggers/:id/pause
  fastify.post<{ Params: { id: string } }>("/api/triggers/:id/pause", async (req, reply) => {
    const trigger = await opts.triggers.get(req.params.id);
    if (!trigger) return reply.status(404).send({ error: "Trigger not found" });
    if (trigger.status !== "active") return reply.status(400).send({ error: `Trigger is not active (status: ${trigger.status})` });
    await opts.triggers.setStatus(req.params.id, "paused");
    return { ok: true };
  });

  // POST /api/triggers/:id/resume
  fastify.post<{ Params: { id: string } }>("/api/triggers/:id/resume", async (req, reply) => {
    const trigger = await opts.triggers.get(req.params.id);
    if (!trigger) return reply.status(404).send({ error: "Trigger not found" });
    if (trigger.status !== "paused") return reply.status(400).send({ error: `Trigger is not paused (status: ${trigger.status})` });

    const cond = trigger.condition as { mode: string; cron?: string };
    let nextFireAt: string | undefined;
    if (cond.cron) {
      const now = new Date();
      nextFireAt = trigger.tradingDaysOnly
        ? computeNextTradingRunAt(cond.cron, now)
        : computeNextRunAt(cond.cron, now);
      await opts.triggers.updateNextFireAt(req.params.id, nextFireAt, undefined);
    }
    await opts.triggers.setStatus(req.params.id, "active");
    return { ok: true, ...(nextFireAt ? { nextFireAt } : {}) };
  });

  // DELETE /api/triggers/:id — cancel
  fastify.delete<{ Params: { id: string } }>("/api/triggers/:id", async (req, reply) => {
    const trigger = await opts.triggers.get(req.params.id);
    if (!trigger) return reply.status(404).send({ error: "Trigger not found" });
    await opts.triggers.setStatus(req.params.id, "cancelled");
    return { ok: true };
  });
}
