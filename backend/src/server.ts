import "dotenv/config";
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyCors from "@fastify/cors";
import { statusRoute } from "./routes/status.js";
import { chatRoute } from "./routes/chat.js";
import { conversationsRoute } from "./routes/conversations.js";
import { createStorageProvider } from "./lib/storage/index.js";

const PORT = parseInt(process.env.PORT ?? "3001", 10);

const fastify = Fastify({ logger: { level: "info" } });

async function start() {
  const storage = createStorageProvider();

  await fastify.register(fastifyCors, {
    origin: process.env.FRONTEND_URL ?? "http://localhost:3000",
    methods: ["GET", "POST", "DELETE"],
  });

  await fastify.register(fastifyWebsocket);

  await fastify.register(statusRoute);
  await fastify.register(chatRoute, { store: storage.conversations });
  await fastify.register(conversationsRoute, { store: storage.conversations });

  fastify.get("/health", async () => ({ ok: true }));

  try {
    await fastify.listen({ port: PORT, host: "0.0.0.0" });
    console.log(`VibeTrade backend running on http://localhost:${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
