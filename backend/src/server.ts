import "dotenv/config";
import { existsSync, renameSync } from "fs";
import { readFile, writeFile } from "fs/promises";
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
import { strategiesRoute } from "./routes/strategies.js";
import { settingsRoute } from "./routes/settings.js";
import { createStorageProvider } from "./lib/storage/index.js";
import { credentialsStore, getDhanClient } from "./lib/credentials.js";
import { HeartbeatService } from "./lib/heartbeat/service.js";
import { getDataDir } from "./lib/data-dir.js";
import { computeNextRunAt, computeNextTradingRunAt } from "./lib/heartbeat/cron-utils.js";
import type { Trigger } from "./lib/heartbeat/types.js";

const PORT = parseInt(process.env.PORT ?? "3001", 10);

// Auto-detect CLI/standalone mode: if frontend/out/ exists next to the package root, serve it
const projectRoot = resolve(__dirname, "../../");
const staticDir = join(projectRoot, "frontend", "out");
const serveStatic = existsSync(staticDir);

const fastify = Fastify({ logger: { level: "info" } });

/**
 * One-time migration: convert schedules.json → triggers.json entries.
 * Idempotent — skips entries already present in triggers.json.
 */
async function migrateSchedulesToTriggers(dataDir: string): Promise<void> {
  const schedulesPath = join(dataDir, "schedules.json");
  const triggersPath = join(dataDir, "triggers.json");

  if (!existsSync(schedulesPath)) return;

  try {
    const schedulesRaw = await readFile(schedulesPath, "utf-8");
    const schedules = JSON.parse(schedulesRaw) as Array<{
      id: string;
      name: string;
      description: string;
      cronExpression: string;
      tradingDaysOnly: boolean;
      prompt: string;
      status: string;
      lastRunAt?: string;
      nextRunAt: string;
      createdAt: string;
      strategyId?: string;
      staleAfterMs?: number;
    }>;

    if (schedules.length === 0) {
      renameSync(schedulesPath, schedulesPath + ".migrated");
      return;
    }

    let triggers: Trigger[] = [];
    if (existsSync(triggersPath)) {
      const triggersRaw = await readFile(triggersPath, "utf-8");
      triggers = JSON.parse(triggersRaw) as Trigger[];
    }

    const existingIds = new Set(triggers.map(t => t.id));
    let added = 0;

    for (const s of schedules) {
      if (existingIds.has(s.id)) continue;
      if (s.status === "deleted") continue;

      // Compute next fire at from now if nextRunAt is in the past
      const now = new Date();
      let nextFireAt: string;
      try {
        const existingNext = new Date(s.nextRunAt);
        if (existingNext > now) {
          nextFireAt = s.nextRunAt;
        } else {
          nextFireAt = s.tradingDaysOnly
            ? computeNextTradingRunAt(s.cronExpression, now)
            : computeNextRunAt(s.cronExpression, now);
        }
      } catch {
        nextFireAt = computeNextRunAt(s.cronExpression, now);
      }

      const trigger: Trigger = {
        id: s.id,
        name: s.name,
        scope: "market",
        watchSymbols: [],
        condition: { mode: "time", cron: s.cronExpression },
        action: { type: "reasoning_job", prompt: s.prompt },
        tradingDaysOnly: s.tradingDaysOnly,
        staleAfterMs: s.staleAfterMs,
        nextFireAt,
        lastFiredAt: s.lastRunAt,
        status: s.status === "paused" ? "paused" : "active",
        active: s.status === "active",
        createdAt: s.createdAt,
        strategyId: s.strategyId,
        context: s.description,
      };
      triggers.push(trigger);
      added++;
    }

    if (added > 0) {
      await writeFile(triggersPath, JSON.stringify(triggers, null, 2), "utf-8");
      console.log(`[migration] Migrated ${added} schedule(s) to triggers.json`);
    }

    renameSync(schedulesPath, schedulesPath + ".migrated");
    console.log(`[migration] schedules.json renamed to schedules.json.migrated`);
  } catch (err) {
    console.error("[migration] Failed to migrate schedules:", err);
  }
}

async function start() {
  const dataDir = getDataDir();
  await migrateSchedulesToTriggers(dataDir);

  const storage = createStorageProvider();
  credentialsStore.init(storage.credentials);
  await credentialsStore.load();

  await fastify.register(fastifyCors, {
    origin: serveStatic
      ? true
      : (process.env.FRONTEND_URL ?? "http://localhost:3000"),
    methods: ["GET", "POST", "PATCH", "DELETE"],
  });

  await fastify.register(fastifyWebsocket);

  await fastify.register(statusRoute);
  await fastify.register(settingsRoute);
  await fastify.register(chatRoute, {
    store: storage.conversations,
    memory: storage.memory,
    triggers: storage.triggers,
    triggerAudit: storage.triggerAudit,
    approvals: storage.approvals,
    strategies: storage.strategies,
    trades: storage.trades,
  });
  await fastify.register(conversationsRoute, { store: storage.conversations });
  await fastify.register(approvalsRoute, { approvals: storage.approvals, triggers: storage.triggers });
  await fastify.register(triggersRoute, { triggers: storage.triggers, triggerAudit: storage.triggerAudit });
  await fastify.register(strategiesRoute, { strategies: storage.strategies, triggers: storage.triggers, trades: storage.trades });

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

  credentialsStore.registerServices({ heartbeat });

  const shutdown = async () => {
    heartbeat?.stop();
    await fastify.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => { void shutdown(); });
  process.on("SIGINT",  () => { void shutdown(); });
}

start();
