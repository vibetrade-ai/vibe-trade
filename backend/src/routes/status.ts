import type { FastifyInstance } from "fastify";
import { getBrokerAdapter } from "../lib/credentials.js";
import { BrokerAuthError } from "../lib/brokers/errors.js";

export async function statusRoute(fastify: FastifyInstance) {
  fastify.get("/status", async (_request, reply) => {
    try {
      const broker = getBrokerAdapter();
      await broker.getFunds();
      const name = broker.capabilities.name;
      return reply.send({ status: "connected", message: `${name} account connected successfully` });
    } catch (err) {
      if (err instanceof BrokerAuthError) {
        return reply.status(401).send({ status: "token_expired", message: err.message });
      }
      if (err instanceof Error && err.message.includes("credentials not configured")) {
        return reply.status(500).send({ status: "misconfigured", message: err.message });
      }
      return reply.status(503).send({
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
