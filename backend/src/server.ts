import "dotenv/config";
import { existsSync } from "fs";
import { resolve, join } from "path";
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { statusRoute } from "./routes/status.js";
import { chatRoute } from "./routes/chat.js";
import { conversationsRoute } from "./routes/conversations.js";
import { approvalsRoute } from "./routes/approvals.js";
import { triggersRoute } from "./routes/triggers.js";
import { schedulesRoute } from "./routes/schedules.js";
import { strategiesRoute } from "./routes/strategies.js";
import { settingsRoute } from "./routes/settings.js";
import { createStorageProvider } from "./lib/storage/index.js";
import { credentialsStore, getDhanClient } from "./lib/credentials.js";
import { HeartbeatService } from "./lib/heartbeat/service.js";
import { SchedulerService } from "./lib/scheduler/service.js";

const PORT = parseInt(process.env.PORT ?? "3001", 10);

// Auto-detect CLI/standalone mode: if frontend/out/ exists next to the package root, serve it
const projectRoot = resolve(__dirname, "../../");
const staticDir = join(projectRoot, "frontend", "out");
const serveStatic = existsSync(staticDir);

const fastify = Fastify({ logger: { level: "info" } });

async function start() {
  const storage = createStorageProvider();
  credentialsStore.init(storage.credentials);
  await credentialsStore.load();

  await fastify.register(fastifyCors, {
    origin: serveStatic
      ? true
      : (process.env.FRONTEND_URL ?? "http://localhost:3000"),
    methods: ["GET", "POST", "DELETE"],
  });

  await fastify.register(fastifyWebsocket);

  await fastify.register(statusRoute);
  await fastify.register(settingsRoute);
  await fastify.register(chatRoute, {
    store: storage.conversations,
    memory: storage.memory,
    triggers: storage.triggers,
    approvals: storage.approvals,
    schedules: storage.schedules,
    scheduleRuns: storage.scheduleRuns,
    strategies: storage.strategies,
    trades: storage.trades,
  });
  await fastify.register(conversationsRoute, { store: storage.conversations });
  await fastify.register(approvalsRoute, { approvals: storage.approvals, triggers: storage.triggers });
  await fastify.register(triggersRoute, { triggers: storage.triggers, triggerAudit: storage.triggerAudit });
  await fastify.register(schedulesRoute, { schedules: storage.schedules, scheduleRuns: storage.scheduleRuns });
  await fastify.register(strategiesRoute, { strategies: storage.strategies, triggers: storage.triggers, schedules: storage.schedules, trades: storage.trades });

  fastify.get("/health", async () => ({ ok: true }));

  // CLI/standalone mode: serve the static frontend and add SPA fallback
  if (serveStatic) {
    console.log(`[static] Serving frontend from ${staticDir}`);
    await fastify.register(fastifyStatic, { root: staticDir, prefix: "/", wildcard: false });
    fastify.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith("/api/") || request.url.startsWith("/ws/")) {
        return reply.status(404).send({ error: "Not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  try {
    await fastify.listen({ port: PORT, host: "0.0.0.0" });
    console.log(`VibeTrade backend running on http://localhost:${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }

  // Start heartbeat (after server is up)
  let heartbeat: HeartbeatService | null = null;
  try {
    const dhan = getDhanClient();
    heartbeat = new HeartbeatService(dhan, storage.triggers, storage.approvals, storage.triggerAudit, storage.memory, 60_000, storage.strategies, storage.trades);
    heartbeat.start();
  } catch (err) {
    console.warn("[heartbeat] Failed to start (Dhan credentials not configured):", (err as Error).message);
  }

  // Start scheduler
  let scheduler: SchedulerService | null = null;
  try {
    const schedulerDhan = getDhanClient();
    scheduler = new SchedulerService(schedulerDhan, storage.schedules, storage.scheduleRuns, storage.triggers, storage.approvals, storage.memory, 60_000, storage.strategies, storage.trades);
    scheduler.start();
  } catch (err) {
    console.warn("[scheduler] Failed to start:", (err as Error).message);
  }

  credentialsStore.registerServices({ heartbeat, scheduler });

  const shutdown = async () => {
    heartbeat?.stop();
    scheduler?.stop();
    await fastify.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => { void shutdown(); });
  process.on("SIGINT",  () => { void shutdown(); });
}

start();
