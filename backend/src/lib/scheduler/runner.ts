import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "crypto";
import type { DhanClient } from "../dhan/client.js";
import type { ApprovalStore, MemoryStore, StrategyStore, TradeStore } from "../storage/index.js";
import type { TriggerStore } from "../storage/index.js";
import type { Schedule } from "./types.js";
import type { ScheduleRunStore } from "./store.js";
import type { TradeArgs } from "../heartbeat/types.js";
import { TOOLS } from "../tools.js";
import { syncOrders } from "../order-sync.js";

const anthropic = new Anthropic();

const READ_ONLY_TOOLS = [
  "get_quote", "get_index_quote", "get_positions", "get_funds",
  "get_historical_data", "compute_indicators", "get_fundamentals",
  "fetch_news", "get_market_status", "get_top_movers", "search_instruments",
];

const SCHEDULE_RUNNER_SYSTEM = `You are VibeTrade's autonomous scheduled analysis engine. A scheduled task has fired and you must analyze the market situation and take appropriate action.

Available read-only tools: get_quote, get_index_quote, get_positions, get_funds, get_historical_data, compute_indicators, get_fundamentals, fetch_news, get_market_status, get_top_movers, search_instruments

Available action tools:
- register_soft_trigger: Register a new soft (reasoning_job) trigger directly, no approval needed
- queue_trade_approval: Queue a trade for user approval (user will approve/reject in the app). You may call this multiple times to queue several trades.
- queue_hard_trigger_approval: Queue a new hard_order trigger for user consent
- no_action: Signal that no opportunities were found

Rules:
- Call read-only tools to gather data before deciding
- Do NOT produce conversational text — your output is not shown to the user
- You may queue multiple trade approvals before calling no_action or stopping
- If no action is warranted, call no_action with your reasoning
- Max 10 turns`;

const RUNNER_TOOLS: Anthropic.Tool[] = [
  {
    name: "register_soft_trigger",
    description: "Register a new soft trigger (reasoning_job action) directly without user approval.",
    input_schema: {
      type: "object",
      properties: {
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
        expiresAt: { type: "string" },
      },
      required: ["name", "scope", "watchSymbols", "condition"],
    },
  },
  {
    name: "queue_trade_approval",
    description: "Queue a trade proposal for user approval. Call multiple times for multiple trades.",
    input_schema: {
      type: "object",
      properties: {
        reasoning: { type: "string" },
        symbol: { type: "string" },
        transaction_type: { type: "string", enum: ["BUY", "SELL"] },
        quantity: { type: "number" },
        order_type: { type: "string", enum: ["MARKET", "LIMIT"] },
        price: { type: "number" },
      },
      required: ["reasoning", "symbol", "transaction_type", "quantity", "order_type"],
    },
  },
  {
    name: "queue_hard_trigger_approval",
    description: "Queue a new hard_order trigger for user consent.",
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
    description: "Signal that no action or opportunity was found.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string" },
      },
      required: ["reason"],
    },
  },
];

export async function runScheduleJob(
  schedule: Schedule,
  dhan: DhanClient,
  triggerStore: TriggerStore,
  approvalStore: ApprovalStore,
  scheduleRunStore: ScheduleRunStore,
  memory: MemoryStore,
  strategyStore?: StrategyStore,
  tradeStore?: TradeStore,
): Promise<void> {
  const startedAt = new Date().toISOString();
  const runId = randomUUID();

  if (tradeStore) {
    await syncOrders(dhan, tradeStore).catch(err =>
      console.error("[scheduler] pre-run order sync failed:", err)
    );
  }

  try {
    const memoryContent = await memory.read().catch(() => "");
    let systemPrompt = SCHEDULE_RUNNER_SYSTEM + (memoryContent ? `\n\n<memory>\n${memoryContent}\n</memory>` : "");

    // Inject strategy context if schedule is linked to a strategy
    if (schedule.strategyId && strategyStore) {
      const strategy = await strategyStore.get(schedule.strategyId).catch(() => null);
      if (strategy) {
        if (strategy.status === "archived") {
          console.warn(`[scheduler] schedule ${schedule.id} linked to archived strategy ${schedule.strategyId} — skipping`);
          return;
        }
        const [activeTriggers, fundsRaw] = await Promise.all([
          triggerStore.list({ status: "active" }),
          dhan.getFunds().catch(() => null),
        ]);
        const linkedTriggers = activeTriggers.filter(t => t.strategyId === strategy.id);
        const triggersBlock = linkedTriggers.length > 0
          ? linkedTriggers.map(t => `- "${t.name}": ${JSON.stringify(t.condition)} → ${t.action.type}`).join("\n")
          : "None";
        const funds = fundsRaw as { availableBalance?: number } | null;
        const availableBalance = funds?.availableBalance ?? null;
        const fundsLine = availableBalance !== null
          ? `Available balance: ₹${availableBalance.toLocaleString("en-IN")}  |  Allocation: ₹${strategy.allocation.toLocaleString("en-IN")}${availableBalance < strategy.allocation ? "  ⚠️ Balance is below strategy allocation" : ""}`
          : `Allocation: ₹${strategy.allocation.toLocaleString("en-IN")}  (live balance unavailable)`;
        systemPrompt += `\n\n<strategy name="${strategy.name}">
State: ${strategy.state}  |  ${fundsLine}

## Plan
${strategy.plan}

## Active Triggers
${triggersBlock}

IMPORTANT: Before queuing any trade, confirm the required capital does not exceed the available balance shown above. If funds are insufficient, call no_action with a clear reason.
</strategy>`;
      }
    }

    const allTools: Anthropic.Tool[] = [
      ...READ_ONLY_TOOLS.map(name => TOOLS[name]!.definition),
      ...RUNNER_TOOLS,
    ];

    const history: Anthropic.MessageParam[] = [
      { role: "user", content: schedule.prompt },
    ];

    let terminated = false;
    let turns = 0;
    const approvalIds: string[] = [];
    let lastNoActionReason = "";
    let lastSummary = "";

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
          lastNoActionReason = args.reason as string;
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
          const expiry = new Date(Date.now() + 30 * 60 * 1000).toISOString();
          // Use schedule id/name as the trigger reference
          await approvalStore.add({
            id: approvalId, kind: "trade",
            triggerId: schedule.id, triggerName: schedule.name,
            reasoning: args.reasoning as string,
            tradeArgs, status: "pending",
            createdAt: new Date().toISOString(), expiresAt: expiry,
            ...(schedule.strategyId ? { strategyId: schedule.strategyId } : {}),
          });
          approvalIds.push(approvalId);
          console.log(`[scheduler] queued trade approval ${approvalId} for schedule ${schedule.id}`);
          lastSummary = `Queued ${approvalIds.length} trade approval(s)`;
          resultText = `Trade approval queued (id: ${approvalId}). You may queue more or call no_action when done.`;

        } else if (toolUse.name === "queue_hard_trigger_approval") {
          const htApprovalId = randomUUID();
          const expiry = new Date(Date.now() + 30 * 60 * 1000).toISOString();
          await approvalStore.add({
            id: htApprovalId, kind: "hard_trigger",
            originatingTriggerId: schedule.id,
            originatingTriggerName: schedule.name,
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
          approvalIds.push(htApprovalId);
          console.log(`[scheduler] queued hard_trigger approval ${htApprovalId}`);
          resultText = `Hard trigger approval queued (id: ${htApprovalId}).`;

        } else if (toolUse.name === "register_soft_trigger") {
          const { randomUUID: uuid } = await import("crypto");
          const newTrigger = {
            id: uuid(),
            name: args.name as string,
            scope: args.scope as "symbol" | "market" | "portfolio",
            watchSymbols: args.watchSymbols as string[],
            condition: args.condition as { mode: "code"; expression: string } | { mode: "llm"; description: string },
            action: { type: "reasoning_job" as const },
            expiresAt: args.expiresAt as string | undefined,
            createdAt: new Date().toISOString(),
            active: true,
            status: "active" as const,
          };
          await triggerStore.upsert(newTrigger);
          console.log(`[scheduler] registered soft trigger ${newTrigger.id}: ${newTrigger.name}`);
          resultText = `Trigger "${newTrigger.name}" registered (id: ${newTrigger.id}).`;

        } else {
          const toolDef = TOOLS[toolUse.name];
          if (toolDef) {
            try {
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

    const completedAt = new Date().toISOString();
    let outcome: import("./types.js").ScheduleRunOutcome;

    if (lastNoActionReason) {
      outcome = { type: "no_action", reason: lastNoActionReason };
    } else if (approvalIds.length > 0) {
      outcome = { type: "completed", summary: lastSummary || `Queued ${approvalIds.length} approval(s)`, approvalIds };
    } else {
      outcome = { type: "completed", summary: "Completed with no explicit actions", approvalIds: [] };
    }

    await scheduleRunStore.append({ id: runId, scheduleId: schedule.id, scheduleName: schedule.name, startedAt, completedAt, outcome, ...(schedule.strategyId ? { strategyId: schedule.strategyId } : {}) });
    console.log(`[scheduler] run ${runId} for schedule ${schedule.id} completed: ${outcome.type}`);

  } catch (err) {
    const completedAt = new Date().toISOString();
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[scheduler] run ${runId} for schedule ${schedule.id} error:`, err);
    await scheduleRunStore.append({
      id: runId, scheduleId: schedule.id, scheduleName: schedule.name,
      startedAt, completedAt,
      outcome: { type: "error", message },
    }).catch(() => {});
  }
}
