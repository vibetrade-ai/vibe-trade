import "dotenv/config";
import { existsSync, renameSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyCors from "@fastify/cors";
import { intentsRoute } from "./routes/intents.js";
import { brokerChatRoute } from "./routes/broker-chat.js";
import { harnessPlugin } from "./harness-plugin.js";
import { createStorageProvider } from "./lib/storage/index.js";
import { credentialsStore, getBrokerAdapter } from "./lib/credentials.js";
import { HeartbeatService } from "./lib/heartbeat/service.js";
import { getDataDir } from "./lib/data-dir.js";
import { computeNextRunAt, computeNextTradingRunAt } from "./lib/heartbeat/cron-utils.js";
import type { Trigger } from "./lib/heartbeat/types.js";

const PORT = parseInt(process.env.PORT ?? "3001", 10);

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
    origin: (origin: string | undefined, callback: (err: Error | null, allow: boolean) => void) => {
      const allowed = (process.env.FRONTEND_URLS ?? "http://localhost:3000,http://localhost:3002,http://localhost:3003")
        .split(",").map((u: string) => u.trim());
      if (!origin || allowed.includes(origin)) callback(null, true);
      else callback(new Error("Not allowed by CORS"), false);
    },
    methods: ["GET", "POST", "PATCH", "DELETE"],
  });

  await fastify.register(fastifyWebsocket);

  await fastify.register(harnessPlugin, { storage });

  await fastify.register(intentsRoute, {
    intents: storage.intents,
    triggers: storage.triggers,
    portfolios: storage.portfolios,
    strategies: storage.strategies,
    trades: storage.trades,
    approvals: storage.approvals,
  });
  await fastify.register(brokerChatRoute, {
    store: storage.conversations,
    intents: storage.intents,
    triggers: storage.triggers,
    portfolios: storage.portfolios,
    strategies: storage.strategies,
    trades: storage.trades,
    approvals: storage.approvals,
  });

  fastify.get("/health", async () => ({ ok: true }));

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
    const broker = getBrokerAdapter();
    heartbeat = new HeartbeatService(broker, storage.triggers, storage.approvals, storage.triggerAudit, storage.memory, 60_000, storage.strategies, storage.trades, storage.portfolios);
    heartbeat.start();
  } catch (err) {
    console.warn("[heartbeat] Failed to start (broker credentials not configured):", (err as Error).message);
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
