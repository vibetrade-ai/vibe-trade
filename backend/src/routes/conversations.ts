import type { FastifyInstance } from "fastify";
import type Anthropic from "@anthropic-ai/sdk";
import type { ConversationStore } from "../lib/storage/index.js";

// A displayable unit for the frontend — mirrors the ChatItem shape on the client.
interface MessageView {
  role: "user" | "assistant" | "tool";
  text: string;
  toolName?: string;
}

export async function conversationsRoute(
  fastify: FastifyInstance,
  opts: { store: ConversationStore }
) {
  fastify.get("/api/conversations", async (_request, _reply) => {
    return opts.store.list();
  });

  fastify.get("/api/conversations/:id/messages", async (request, _reply) => {
    const { id } = request.params as { id: string };
    const history = await opts.store.load(id);
    const views: MessageView[] = [];

    for (const msg of history) {
      if (typeof msg.content === "string") {
        // Simple string user message
        views.push({ role: msg.role as "user" | "assistant", text: msg.content });
        continue;
      }

      if (!Array.isArray(msg.content)) continue;

      // Skip pure tool-result turns (backend implementation detail)
      if (msg.content.every((b) => b.type === "tool_result")) continue;

      for (const block of msg.content) {
        if (block.type === "text") {
          const text = (block as Anthropic.TextBlock).text;
          if (text) views.push({ role: msg.role as "user" | "assistant", text });
        } else if (block.type === "tool_use") {
          const b = block as Anthropic.ToolUseBlock;
          views.push({ role: "tool", text: JSON.stringify(b.input, null, 2), toolName: b.name });
        }
      }
    }

    return views;
  });
}
