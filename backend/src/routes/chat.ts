import type { FastifyInstance } from "fastify";
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "crypto";
import { DhanClient } from "../lib/dhan/client.js";
import { TOOLS, type ToolDefinition, getAllToolDefinitions, getApprovalDescription } from "../lib/tools.js";
import { DhanTokenExpiredError } from "../types.js";
import type { ClientMessage, ServerMessage } from "../types.js";

const anthropic = new Anthropic();

const SYSTEM_PROMPT = `You are VibeTrade, an AI-powered trading assistant connected to the user's Dhan brokerage account.

You have access to tools to fetch live quotes, view positions/funds/orders, and place or cancel orders.

IMPORTANT — tool usage rules:
- Always call the relevant tool FIRST before writing any response. Never start writing an answer and then call a tool mid-sentence.
- After receiving tool results, write your full response based on the data.
- Do not narrate what you are about to do ("Let me check..." / "I'll look that up..."). Just call the tool silently and then present the result.
- Only call tools that the user explicitly asked for. Do not make unsolicited tool calls.

Formatting:
- Format monetary values in Indian Rupees (₹) with Indian number formatting (e.g. ₹1,23,456.78)
- Use markdown tables for structured data (positions, orders)
- Be concise — lead with the numbers, add brief commentary after
- For market orders, note that execution price may differ from the quoted LTP

Error handling:
- If a tool returns an error starting with "TOOL_ERROR:", explain what went wrong in plain, friendly language — no technical jargon, no HTTP status codes, no internal error codes
- Common translations: a 400 error on a quote usually means the market is closed or the symbol isn't available right now; a 400 on an order means the order parameters were invalid; a 5xx means Dhan's servers are having issues
- If the error is "TOOL_ERROR: TOKEN_EXPIRED", tell the user their session has expired and they need to reconnect — do not call any more tools`;

export async function chatRoute(fastify: FastifyInstance) {
  fastify.get("/ws/chat", { websocket: true }, (socket, _request) => {
    const dhanClient = new DhanClient();
    const pendingApprovals = new Map<string, (approved: boolean) => void>();
    const conversationHistory: Anthropic.MessageParam[] = [];

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

      if (clientMsg.type === "tool_approval_response") {
        const resolver = pendingApprovals.get(clientMsg.requestId);
        if (resolver) {
          pendingApprovals.delete(clientMsg.requestId);
          resolver(clientMsg.approved);
        }
        return;
      }

      if (clientMsg.type === "message") {
        for (const msg of clientMsg.messages) {
          conversationHistory.push({ role: msg.role, content: msg.content });
        }
        await runClaudeLoop(dhanClient, conversationHistory, pendingApprovals, send);
      }
    });

    socket.on("close", () => {
      for (const resolver of pendingApprovals.values()) resolver(false);
      pendingApprovals.clear();
    });

    socket.on("error", (err: Error) => {
      console.error("WebSocket error:", err);
    });
  });
}

// Executes a tool and returns a result string. Never throws.
// Returns isError=true so the caller can surface it to the frontend.
async function runTool(
  toolDef: ToolDefinition,
  args: Record<string, unknown>,
  dhanClient: DhanClient
): Promise<{ result: string; isError: boolean; tokenExpired: boolean }> {
  try {
    const result = await toolDef.handler(args, dhanClient);
    return { result, isError: false, tokenExpired: false };
  } catch (err) {
    if (err instanceof DhanTokenExpiredError) {
      return {
        result: "TOOL_ERROR: TOKEN_EXPIRED — Your Dhan session has expired. Please update your access token and restart the backend.",
        isError: true,
        tokenExpired: true,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { result: `TOOL_ERROR: ${msg}`, isError: true, tokenExpired: false };
  }
}

async function runClaudeLoop(
  dhanClient: DhanClient,
  history: Anthropic.MessageParam[],
  pendingApprovals: Map<string, (approved: boolean) => void>,
  send: (msg: ServerMessage) => void
) {
  let tokenExpired = false;

  try {
    while (true) {
      const stream = anthropic.messages.stream({
        model: "claude-sonnet-4-6",
        max_tokens: 8096,
        system: SYSTEM_PROMPT,
        tools: getAllToolDefinitions(),
        messages: history,
      });

      stream.on("text", (text) => {
        send({ type: "text_delta", content: text });
      });

      const finalMessage = await stream.finalMessage();

      const toolUses: Anthropic.ToolUseBlock[] = [];
      for (const block of finalMessage.content) {
        if (block.type === "tool_use") toolUses.push(block);
      }

      history.push({ role: "assistant", content: finalMessage.content });

      if (finalMessage.stop_reason === "end_turn" || toolUses.length === 0) {
        send({ type: "done" });
        if (tokenExpired) send({ type: "token_expired" });
        return;
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      // Kick off all read-only tools in parallel immediately.
      // Approval-gated tools stay sequential — each needs an explicit user decision.
      type ToolOut = { result: string; isError: boolean; tokenExpired: boolean };
      const readOnlyPending = new Map<string, Promise<ToolOut>>();

      for (const toolUse of toolUses) {
        const toolDef = TOOLS[toolUse.name];
        if (toolDef && !toolDef.requiresApproval) {
          const args = toolUse.input as Record<string, unknown>;
          send({ type: "tool_use_start", tool: toolUse.name, args });
          readOnlyPending.set(toolUse.id, runTool(toolDef, args, dhanClient));
        }
      }

      for (const toolUse of toolUses) {
        const toolDef = TOOLS[toolUse.name];
        if (!toolDef) {
          send({ type: "tool_use_result", tool: toolUse.name, result: "Unknown tool", isError: true });
          toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: `TOOL_ERROR: Unknown tool "${toolUse.name}"` });
          continue;
        }

        const args = toolUse.input as Record<string, unknown>;
        let result: string;
        let isError = false;

        if (toolDef.requiresApproval) {
          send({ type: "tool_use_start", tool: toolUse.name, args });
          const requestId = randomUUID();
          send({
            type: "tool_approval_request",
            requestId,
            tool: toolUse.name,
            args,
            description: getApprovalDescription(toolUse.name, args),
          });

          const approved = await new Promise<boolean>((resolve) => {
            pendingApprovals.set(requestId, resolve);
          });

          if (!approved) {
            result = "User denied this action.";
          } else {
            const out = await runTool(toolDef, args, dhanClient);
            result = out.result;
            isError = out.isError;
            if (out.tokenExpired) tokenExpired = true;
          }
        } else {
          // Already running — just await the in-flight promise
          const out = await readOnlyPending.get(toolUse.id)!;
          result = out.result;
          isError = out.isError;
          if (out.tokenExpired) tokenExpired = true;
        }

        send({ type: "tool_use_result", tool: toolUse.name, result, isError });
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: result });
      }

      history.push({ role: "user", content: toolResults });
    }
  } catch (err) {
    console.error("Claude loop error:", err);
    send({
      type: "error",
      message: err instanceof Error ? err.message : "An unexpected error occurred",
    });
  }
}
