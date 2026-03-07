import type { FastifyInstance } from "fastify";
import { DhanClient } from "../lib/dhan/client.js";
import { DhanTokenExpiredError } from "../types.js";

export async function statusRoute(fastify: FastifyInstance) {
  fastify.get("/status", async (_request, reply) => {
    try {
      const client = new DhanClient();
      // Use getFunds as a lightweight connectivity check
      await client.getFunds();
      return reply.send({ status: "connected", message: "Dhan account connected successfully" });
    } catch (err) {
      if (err instanceof DhanTokenExpiredError) {
        return reply.status(401).send({ status: "token_expired", message: err.message });
      }
      if (err instanceof Error && err.message.includes("DHAN_ACCESS_TOKEN")) {
        return reply.status(500).send({ status: "misconfigured", message: err.message });
      }
      return reply.status(503).send({
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
