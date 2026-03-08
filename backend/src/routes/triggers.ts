import type { FastifyInstance } from "fastify";
import type { TriggerStore, TriggerAuditStore } from "../lib/storage/index.js";

export async function triggersRoute(
  fastify: FastifyInstance,
  opts: { triggers: TriggerStore; triggerAudit: TriggerAuditStore }
) {
  // GET /api/triggers — active triggers
  fastify.get("/api/triggers", async () => {
    return opts.triggers.list({ status: "active" });
  });

  // GET /api/triggers/audit — full fire history, newest first
  fastify.get("/api/triggers/audit", async () => {
    return opts.triggerAudit.list();
  });
}
