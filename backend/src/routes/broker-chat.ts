import type { FastifyInstance } from "fastify";
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "crypto";
import type { ConversationStore, IntentStore, TriggerStore, PortfolioStore, StrategyStore, TradeStore, ApprovalStore } from "../lib/storage/index.js";
import { getBrokerAdapter, getAnthropicClient } from "../lib/credentials.js";
import { TOOLS } from "../lib/tools.js";
import { runIntentProcessor } from "./intents.js";
import type { ClientMessage, ServerMessage } from "../types.js";
import { BrokerAuthError } from "../lib/brokers/errors.js";

interface BrokerChatOpts {
  store: ConversationStore;
  intents: IntentStore;
  triggers: TriggerStore;
  portfolios: PortfolioStore;
  strategies: StrategyStore;
  trades: TradeStore;
  approvals: ApprovalStore;
}

const SYSTEM_PROMPT = `You are a trading assistant connected to the user's brokerage account. You can answer questions about the market, portfolio, and positions using the available tools. You can also take trading actions directly — place trades, set up automations, create strategies — by calling the create_intent tool, which you execute yourself.

IMPORTANT — tool usage rules:
- Always call the relevant tool FIRST before writing any response. Never start writing an answer and then call a tool mid-sentence.
- After receiving tool results, write your full response based on the data.
- Do not narrate what you are about to do. Just call the tool silently and then present the result.
- Only call tools that the user explicitly asked for. Do not make unsolicited tool calls.
- Do not offer unsolicited opinions or proactively suggest trades.

IMPORTANT — framing rules:
- You are the one doing the work. Never say things like "a specialist will handle this", "you'll be notified", "I'll pass this along", or anything that implies a human intermediary will take over. You handle everything yourself.
- After calling create_intent, give a brief, factual confirmation of what you've kicked off. Do not promise future notifications or suggest anything else will happen beyond what the user asked for.

Formatting:
- Format monetary values in Indian Rupees (₹) with Indian number formatting (e.g. ₹1,23,456.78)
- Use markdown tables for structured data (positions, orders)
- Be concise — lead with the numbers, add brief commentary after

Error handling:
- If a tool returns an error starting with "TOOL_ERROR:", explain what went wrong in plain, friendly language — no technical jargon, no HTTP status codes, no internal error codes
- If the error is "TOOL_ERROR: TOKEN_EXPIRED", tell the user their session has expired and they need to reconnect — do not call any more tools`;

const CREATE_INTENT_TOOL: Anthropic.Tool = {
  name: "create_intent",
  description: "Use this when the user wants to perform a trading action — place a trade, set up an automation, create a strategy, etc. Do NOT use this to answer questions.",
  input_schema: {
    type: "object" as const,
    properties: {
      text: { type: "string", description: "The user's action request, verbatim" },
    },
    required: ["text"],
  },
};

export async function brokerChatRoute(fastify: FastifyInstance, opts: BrokerChatOpts) {
  fastify.get("/ws/broker-chat", { websocket: true }, async (socket, request) => {
    const conversationId =
      (request.query as { conversationId?: string }).conversationId ?? randomUUID();
    const conversationHistory: Anthropic.MessageParam[] = await opts.store.load(conversationId);

    // Build read-only tool definitions (exclude tools requiring approval)
    const readOnlyToolDefs: Anthropic.Tool[] = Object.values(TOOLS)
      .filter(t => !t.requiresApproval)
      .map(t => t.definition);
    const allToolDefs: Anthropic.Tool[] = [...readOnlyToolDefs, CREATE_INTENT_TOOL];

    function send(msg: ServerMessage) {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(msg));
      }
    }

    socket.on("message", async (raw: Buffer | string) => {
      let clientMsg: ClientMessage;
      try {
        clientMsg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        send({ type: "error", message: "Invalid JSON message" });
        return;
      }

      if (clientMsg.type !== "message") return;

      const saveFrom = conversationHistory.length;
      for (const msg of clientMsg.messages) {
        if (msg.role !== "user" && msg.role !== "assistant") continue;
        conversationHistory.push({ role: msg.role, content: msg.content });
      }

      let broker = null;
      try { broker = getBrokerAdapter(); } catch { /* not configured */ }

      const systemPrompt = SYSTEM_PROMPT + (broker
        ? `\n\n<broker>\nName: ${broker.capabilities.name}\nMarkets: ${broker.capabilities.markets.join(", ")}\nAsset classes: ${broker.capabilities.assetClasses.join(", ")}\n</broker>`
        : "");

      try {
        const anthropic = getAnthropicClient();
        let tokenExpired = false;

        while (true) {
          const stream = anthropic.messages.stream({
            model: "claude-sonnet-4-6",
            max_tokens: 8096,
            system: systemPrompt,
            tools: allToolDefs,
            messages: conversationHistory,
          });

          stream.on("text", (text) => {
            send({ type: "text_delta", content: text });
          });

          const finalMessage = await stream.finalMessage();

          const toolUses: Anthropic.ToolUseBlock[] = [];
          for (const block of finalMessage.content) {
            if (block.type === "tool_use") toolUses.push(block);
          }

          conversationHistory.push({ role: "assistant", content: finalMessage.content });

          if (finalMessage.stop_reason === "end_turn" || toolUses.length === 0) {
            send({ type: "done" });
            if (tokenExpired) send({ type: "token_expired" });
            break;
          }

          const toolResults: Anthropic.ToolResultBlockParam[] = [];

          for (const toolUse of toolUses) {
            const args = toolUse.input as Record<string, unknown>;

            if (toolUse.name === "create_intent") {
              const text = (args.text as string) ?? "";
              const intentId = randomUUID();

              await opts.intents.append({
                id: intentId,
                text,
                status: "processing",
                primitives: [],
                createdAt: new Date().toISOString(),
              });

              void runIntentProcessor(intentId, text, undefined, {
                intents: opts.intents,
                triggers: opts.triggers,
                portfolios: opts.portfolios,
                strategies: opts.strategies,
                trades: opts.trades,
                approvals: opts.approvals,
              });

              send({ type: "intent_created", intentId });

              toolResults.push({
                type: "tool_result",
                tool_use_id: toolUse.id,
                content: JSON.stringify({ intentId }),
              });
              continue;
            }

            const toolDef = TOOLS[toolUse.name];
            if (!toolDef) {
              toolResults.push({
                type: "tool_result",
                tool_use_id: toolUse.id,
                content: `TOOL_ERROR: Unknown tool "${toolUse.name}"`,
              });
              continue;
            }

            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const result = await toolDef.handler(args, broker as any);
              toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: result });
            } catch (err) {
              if (err instanceof BrokerAuthError) {
                tokenExpired = true;
                toolResults.push({
                  type: "tool_result",
                  tool_use_id: toolUse.id,
                  content: "TOOL_ERROR: TOKEN_EXPIRED — Your broker session has expired.",
                });
              } else {
                const msg = err instanceof Error ? err.message : String(err);
                toolResults.push({
                  type: "tool_result",
                  tool_use_id: toolUse.id,
                  content: `TOOL_ERROR: ${msg}`,
                });
              }
            }
          }

          conversationHistory.push({ role: "user", content: toolResults });
        }
      } catch (err) {
        console.error("[broker-chat] Claude loop error:", err);
        send({
          type: "error",
          message: err instanceof Error ? err.message : "An unexpected error occurred",
        });
      }

      await opts.store.append(conversationId, conversationHistory.slice(saveFrom));
    });

    socket.on("error", (err: Error) => {
      console.error("[broker-chat] WebSocket error:", err);
    });
  });
}
