import type { FastifyInstance } from "fastify";
import { computeNextRunAt, computeNextTradingRunAt } from "../lib/scheduler/service.js";
import { parseExpression } from "cron-parser";
import type { ScheduleStore, ScheduleRunStore } from "../lib/scheduler/store.js";

export async function schedulesRoute(
  fastify: FastifyInstance,
  opts: { schedules: ScheduleStore; scheduleRuns: ScheduleRunStore }
) {
  // GET /api/schedules — list non-deleted schedules
  fastify.get("/api/schedules", async () => {
    return opts.schedules.list();
  });

  // GET /api/schedules/runs — last 50 runs
  fastify.get("/api/schedules/runs", async () => {
    return opts.scheduleRuns.list(50);
  });

  // POST /api/schedules/:id/pause
  fastify.post<{ Params: { id: string } }>("/api/schedules/:id/pause", async (req, reply) => {
    const schedule = await opts.schedules.get(req.params.id);
    if (!schedule) return reply.status(404).send({ error: "Schedule not found" });
    await opts.schedules.setStatus(req.params.id, "paused");
    return { ok: true };
  });

  // POST /api/schedules/:id/resume
  fastify.post<{ Params: { id: string } }>("/api/schedules/:id/resume", async (req, reply) => {
    const schedule = await opts.schedules.get(req.params.id);
    if (!schedule) return reply.status(404).send({ error: "Schedule not found" });
    const now = new Date();
    const nextRunAt = schedule.tradingDaysOnly
      ? computeNextTradingRunAt(schedule.cronExpression, now)
      : computeNextRunAt(schedule.cronExpression, now);
    await opts.schedules.setStatus(req.params.id, "active");
    await opts.schedules.updateNextRunAt(req.params.id, nextRunAt);
    return { ok: true, nextRunAt };
  });

  // DELETE /api/schedules/:id
  fastify.delete<{ Params: { id: string } }>("/api/schedules/:id", async (req, reply) => {
    const schedule = await opts.schedules.get(req.params.id);
    if (!schedule) return reply.status(404).send({ error: "Schedule not found" });
    await opts.schedules.setStatus(req.params.id, "deleted");
    return { ok: true };
  });
}
