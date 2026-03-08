import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "crypto";
import type { DhanClient } from "../dhan/client.js";
import type { TriggerStore, ApprovalStore, TriggerAuditStore, MemoryStore } from "../storage/index.js";
import type { Trigger, SystemSnapshot, TradeArgs } from "./types.js";
import { getSecurityId } from "../dhan/instruments.js";
import { TOOLS } from "../tools.js";

const anthropic = new Anthropic();

const READ_ONLY_TOOLS = [
  "get_quote", "get_index_quote", "get_positions", "get_funds",
  "get_historical_data", "compute_indicators", "get_fundamentals",
  "fetch_news", "get_market_status",
];

const RUNNER_SYSTEM = `You are VibeTrade's autonomous analysis engine. A trigger has fired and you must analyze the situation and decide on a course of action.

Available read-only tools: get_quote, get_index_quote, get_positions, get_funds, get_historical_data, compute_indicators, get_fundamentals, fetch_news, get_market_status

Available action tools:
- register_soft_trigger: Register a new soft (reasoning_job) trigger directly, no approval needed
- queue_trade_approval: Queue a trade for user approval (user will approve/reject in the app)
- queue_hard_trigger_approval: Queue a new hard_order trigger for user consent
- no_action: Signal that no action is warranted

Rules:
- Call read-only tools to gather data before deciding
- Do NOT produce conversational text — your output is not shown to the user
- If no action is warranted, call no_action with your reasoning
- Max 10 turns`;

const RUNNER_TOOLS: Anthropic.Tool[] = [
  {
    name: "register_soft_trigger",
    description: "Register a new soft trigger (reasoning_job action) directly without user approval.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Human-readable trigger name" },
        scope: { type: "string", enum: ["symbol", "market", "portfolio"] },
        watchSymbols: { type: "array", items: { type: "string" }, description: "Symbols to watch" },
        condition: {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["code", "llm"] },
            expression: { type: "string", description: "For code mode: JS expression against snapshot" },
            description: { type: "string", description: "For llm mode: natural language condition" },
          },
          required: ["mode"],
        },
        expiresAt: { type: "string", description: "ISO string expiry (optional)" },
      },
      required: ["name", "scope", "watchSymbols", "condition"],
    },
  },
  {
    name: "queue_trade_approval",
    description: "Queue a trade proposal for user approval. The user will see it in the Approvals panel.",
    input_schema: {
      type: "object",
      properties: {
        reasoning: { type: "string", description: "Why you recommend this trade" },
        symbol: { type: "string" },
        transaction_type: { type: "string", enum: ["BUY", "SELL"] },
        quantity: { type: "number" },
        order_type: { type: "string", enum: ["MARKET", "LIMIT"] },
        price: { type: "number", description: "Required for LIMIT orders" },
      },
      required: ["reasoning", "symbol", "transaction_type", "quantity", "order_type"],
    },
  },
  {
    name: "queue_hard_trigger_approval",
    description: "Queue a new hard_order trigger for user consent. If approved, it will execute automatically when condition fires.",
    input_schema: {
      type: "object",
      properties: {
        reasoning: { type: "string" },
        name: { type: "string" },
        scope: { type: "string", enum: ["symbol", "market", "portfolio"] },
        watchSymbols: { type: "array", items: { type: "string" } },
        condition: {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["code", "llm"] },
            expression: { type: "string" },
            description: { type: "string" },
          },
          required: ["mode"],
        },
        tradeArgs: {
          type: "object",
          properties: {
            symbol: { type: "string" },
            transaction_type: { type: "string", enum: ["BUY", "SELL"] },
            quantity: { type: "number" },
            order_type: { type: "string", enum: ["MARKET", "LIMIT"] },
            price: { type: "number" },
          },
          required: ["symbol", "transaction_type", "quantity", "order_type"],
        },
        expiresAt: { type: "string" },
      },
      required: ["reasoning", "name", "scope", "watchSymbols", "condition", "tradeArgs"],
    },
  },
  {
    name: "no_action",
    description: "Signal that no action is warranted after analysis.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Brief explanation of why no action is taken" },
      },
      required: ["reason"],
    },
  },
];

export async function runReasoningJob(
  trigger: Trigger,
  snapshot: SystemSnapshot,
  dhan: DhanClient,
  triggerStore: TriggerStore,
  approvalStore: ApprovalStore,
  auditStore: TriggerAuditStore,
  memory: MemoryStore,
): Promise<void> {
  const memoryContent = await memory.read().catch(() => "");
  const systemPrompt = RUNNER_SYSTEM + (memoryContent ? `\n\n<memory>\n${memoryContent}\n</memory>` : "");

  const allTools: Anthropic.Tool[] = [
    ...READ_ONLY_TOOLS.map(name => TOOLS[name]!.definition),
    ...RUNNER_TOOLS,
  ];

  const initialUserMsg = `Trigger fired: "${trigger.name}"
Condition: ${JSON.stringify(trigger.condition)}
Scope: ${trigger.scope}
Watch symbols: ${trigger.watchSymbols.join(", ")}

Current market snapshot:
${JSON.stringify(snapshot, null, 2)}

Analyze the situation and take appropriate action.`;

  const history: Anthropic.MessageParam[] = [
    { role: "user", content: initialUserMsg },
  ];

  let terminated = false;
  let turns = 0;

  while (!terminated && turns < 10) {
    turns++;
    const resp = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: systemPrompt,
      tools: allTools,
      messages: history,
    });

    history.push({ role: "assistant", content: resp.content });

    if (resp.stop_reason === "end_turn") break;

    const toolUses = resp.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) break;

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUses) {
      const args = toolUse.input as Record<string, unknown>;
      let resultText: string;

      if (toolUse.name === "no_action") {
        console.log(`[heartbeat] reasoning job no_action: ${args.reason}`);
        await auditStore.append({
          id: randomUUID(), triggerId: trigger.id, triggerName: trigger.name,
          firedAt: snapshot.capturedAt, snapshotAtFire: snapshot, action: trigger.action,
          outcome: { type: "reasoning_job_no_action", reason: args.reason as string },
        });
        terminated = true;
        resultText = "Noted. Job complete.";

      } else if (toolUse.name === "queue_trade_approval") {
        const tradeArgs: TradeArgs = {
          symbol: args.symbol as string,
          transaction_type: args.transaction_type as "BUY" | "SELL",
          quantity: args.quantity as number,
          order_type: args.order_type as "MARKET" | "LIMIT",
          price: args.price as number | undefined,
        };
        const approvalId = randomUUID();
        const expiry = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min
        await approvalStore.add({
          id: approvalId, kind: "trade",
          triggerId: trigger.id, triggerName: trigger.name,
          reasoning: args.reasoning as string,
          tradeArgs, status: "pending",
          createdAt: new Date().toISOString(), expiresAt: expiry,
        });
        console.log(`[heartbeat] queued trade approval ${approvalId}`);
        await auditStore.append({
          id: randomUUID(), triggerId: trigger.id, triggerName: trigger.name,
          firedAt: snapshot.capturedAt, snapshotAtFire: snapshot, action: trigger.action,
          outcome: { type: "reasoning_job_queued", approvalId },
        });
        terminated = true;
        resultText = `Trade approval queued (id: ${approvalId}). User will be notified.`;

      } else if (toolUse.name === "queue_hard_trigger_approval") {
        const htApprovalId = randomUUID();
        const expiry = new Date(Date.now() + 30 * 60 * 1000).toISOString();
        await approvalStore.add({
          id: htApprovalId, kind: "hard_trigger",
          originatingTriggerId: trigger.id,
          originatingTriggerName: trigger.name,
          reasoning: args.reasoning as string,
          proposedTrigger: {
            name: args.name as string,
            scope: args.scope as "symbol" | "market" | "portfolio",
            watchSymbols: args.watchSymbols as string[],
            condition: args.condition as { mode: "code"; expression: string } | { mode: "llm"; description: string },
            action: { type: "hard_order", tradeArgs: args.tradeArgs as TradeArgs },
            expiresAt: args.expiresAt as string | undefined,
            status: "active" as const,
          },
          status: "pending",
          createdAt: new Date().toISOString(), expiresAt: expiry,
        });
        console.log(`[heartbeat] queued hard_trigger approval ${htApprovalId}`);
        terminated = true;
        resultText = `Hard trigger approval queued (id: ${htApprovalId}).`;

      } else if (toolUse.name === "register_soft_trigger") {
        const newTrigger: Trigger = {
          id: randomUUID(),
          name: args.name as string,
          scope: args.scope as "symbol" | "market" | "portfolio",
          watchSymbols: args.watchSymbols as string[],
          condition: args.condition as { mode: "code"; expression: string } | { mode: "llm"; description: string },
          action: { type: "reasoning_job" },
          expiresAt: args.expiresAt as string | undefined,
          createdAt: new Date().toISOString(),
          active: true,
          status: "active",
        };
        await triggerStore.upsert(newTrigger);
        console.log(`[heartbeat] registered new soft trigger ${newTrigger.id}: ${newTrigger.name}`);
        resultText = `Trigger "${newTrigger.name}" registered (id: ${newTrigger.id}).`;

      } else {
        // Read-only tools — delegate to TOOLS
        const toolDef = TOOLS[toolUse.name];
        if (toolDef) {
          try {
            // Create a minimal DhanClient proxy for read-only tools
            resultText = await toolDef.handler(args, dhan);
          } catch (err) {
            resultText = `TOOL_ERROR: ${err instanceof Error ? err.message : String(err)}`;
          }
        } else {
          resultText = `TOOL_ERROR: Unknown tool "${toolUse.name}"`;
        }
      }

      toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: resultText });
    }

    if (!terminated) {
      history.push({ role: "user", content: toolResults });
    }
  }
}
