import { existsSync } from "fs";
import { resolve, join } from "path";
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { statusRoute } from "./routes/status.js";
import { settingsRoute } from "./routes/settings.js";
import { chatRoute } from "./routes/chat.js";
import { conversationsRoute } from "./routes/conversations.js";
import { approvalsRoute } from "./routes/approvals.js";
import { triggersRoute } from "./routes/triggers.js";
import { strategiesRoute } from "./routes/strategies.js";
import { portfoliosRoute } from "./routes/portfolios.js";
import type { StorageProvider } from "./lib/storage/index.js";

export type HarnessPluginOpts = {
  storage: StorageProvider;
};

export async function harnessPlugin(
  fastify: FastifyInstance,
  opts: HarnessPluginOpts
): Promise<void> {
  const { storage } = opts;

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
    portfolios: storage.portfolios,
  });
  await fastify.register(conversationsRoute, { store: storage.conversations });
  await fastify.register(approvalsRoute, {
    approvals: storage.approvals,
    triggers: storage.triggers,
    trades: storage.trades,
  });
  await fastify.register(triggersRoute, {
    triggers: storage.triggers,
    triggerAudit: storage.triggerAudit,
  });
  await fastify.register(strategiesRoute, {
    strategies: storage.strategies,
    triggers: storage.triggers,
    trades: storage.trades,
  });
  await fastify.register(portfoliosRoute, {
    portfolios: storage.portfolios,
    triggers: storage.triggers,
    trades: storage.trades,
  });

  const projectRoot = resolve(__dirname, "../../");
  const staticDir = join(projectRoot, "frontend", "out");
  if (existsSync(staticDir)) {
    console.log(`[static] Serving frontend from ${staticDir}`);
    await fastify.register(fastifyStatic, {
      root: staticDir,
      prefix: "/",
      wildcard: false,
    });
    fastify.setNotFoundHandler(async (req, reply) => {
      if (req.url.startsWith("/api/") || req.url.startsWith("/ws/")) {
        return reply.status(404).send({ error: "Not found" });
      }
      return reply.sendFile("index.html");
    });
  }
}
