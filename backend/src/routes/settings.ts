import type { FastifyInstance } from "fastify";
import { credentialsStore } from "../lib/credentials.js";
import { BrokerAuthError } from "../lib/brokers/errors.js";

export async function settingsRoute(fastify: FastifyInstance) {
  fastify.get("/api/settings", async () => {
    const status = credentialsStore.status();
    const allConfigured = Object.values(status).every(Boolean);
    return { status, allConfigured };
  });

  fastify.post("/api/settings", async (request, reply) => {
    const body = request.body as Record<string, string> | null;
    if (!body || typeof body !== "object") {
      return reply.status(400).send({ error: "Invalid request body" });
    }

    const allowed = ["ANTHROPIC_API_KEY", "DHAN_ACCESS_TOKEN", "DHAN_CLIENT_ID", "broker"];
    const patch: Record<string, string> = {};
    for (const key of allowed) {
      if (typeof body[key] === "string" && body[key].trim() !== "") {
        patch[key] = body[key].trim();
      }
    }

    if (Object.keys(patch).length === 0) {
      return reply.status(400).send({ error: "No valid non-empty fields provided" });
    }

    await credentialsStore.update(patch);
    const status = credentialsStore.status();
    return { success: true, status };
  });

  fastify.get("/api/settings/broker-status", async () => {
    const { DHAN_ACCESS_TOKEN, DHAN_CLIENT_ID } = credentialsStore.status();
    if (!DHAN_ACCESS_TOKEN || !DHAN_CLIENT_ID) {
      return { configured: false, connected: false, expired: false };
    }
    try {
      const adapter = credentialsStore.getBrokerAdapter();
      await adapter.getFunds();
      return { configured: true, connected: true, expired: false };
    } catch (err) {
      if (err instanceof BrokerAuthError) {
        return { configured: true, connected: false, expired: true };
      }
      return { configured: true, connected: false, expired: false, error: (err as Error).message };
    }
  });
}
