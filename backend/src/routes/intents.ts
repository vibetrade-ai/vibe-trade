import type { FastifyInstance } from "fastify";
import { randomUUID } from "crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type {
  IntentStore,
  TriggerStore,
  PortfolioStore,
  StrategyStore,
  TradeStore,
  ApprovalStore,
  Intent,
  IntentPrimitive,
  IntentType,
  ClarificationQuestion,
} from "../lib/storage/index.js";
import { getBrokerAdapter, getAnthropicClient } from "../lib/credentials.js";
import { syncOrders } from "../lib/brokers/dhan/order-sync.js";
import { TOOLS, type ToolDefinition, createRegisterTriggerTool, createPortfolioTools, createStrategyTools } from "../lib/tools.js";
import { getSecurityId } from "../lib/brokers/dhan/instruments.js";
import { computeOpenPositions } from "../lib/trade-utils.js";

// In-memory map for pausing/resuming intent processors awaiting clarification
const pendingClarifications = new Map<string, { resolve: (answers: Record<string, string>) => void; reject: (e: Error) => void }>();

// In-memory map for pausing/resuming intent processors awaiting plan approval
const pendingPlanApprovals = new Map<string, { resolve: (r: { approved: boolean; feedback?: string }) => void; reject: (e: Error) => void }>();

export interface IntentsRouteOpts {
  intents: IntentStore;
  triggers: TriggerStore;
  portfolios: PortfolioStore;
  strategies: StrategyStore;
  trades: TradeStore;
  approvals: ApprovalStore;
}

// Static tools available to the intent processor (from TOOLS registry)
const STATIC_INTENT_PROCESSOR_TOOL_NAMES = [
  "get_quote",
  "get_index_quote",
  "get_historical_data",
  "compute_indicators",
  "fetch_news",
  "get_market_status",
  "search_instruments",
  "place_order",
];

const INTENT_COMPLETE_TOOL: Anthropic.Tool = {
  name: "intent_complete",
  description: "Call this when you have finished creating all necessary primitives to fulfill the intent. Pass the classified type, a one-sentence summary, and plain-English entry/exit conditions whenever they are known.",
  input_schema: {
    type: "object" as const,
    properties: {
      type: {
        type: "string",
        enum: ["atomic", "conditional", "scheduled", "agentic", "composite"],
        description: "Classification of the intent type",
      },
      summary: {
        type: "string",
        description: "One sentence describing what was created, e.g. 'Set a recurring trigger to buy ₹5000 of NIFTYBEES every Monday at 9:15 AM'",
      },
      entry_condition: {
        type: "string",
        description: "One short sentence (max ~100 chars) describing only how/when the position is entered, e.g. 'Buy 10 TATAMOTORS at market' or 'Trigger fires when RSI < 30'. Never include exit info.",
      },
      exit_condition: {
        type: "string",
        description: "One short sentence (max ~100 chars) describing ONLY when/how to exit. Never repeat entry conditions here. If no automatic exit, write 'No automatic exit'.",
      },
    },
    required: ["type", "summary", "entry_condition", "exit_condition"],
  },
};

const PROPOSE_PLAN_TOOL: Anthropic.Tool = {
  name: "propose_plan",
  description: "Propose an implementation plan to the user before executing. Call this after gathering clarifications and before creating any orders, triggers, portfolios, or strategies. The user must approve before you proceed. Only describe what the user explicitly asked for. If you believe something is a valuable addition (e.g. a stop-loss), you must have asked about it in clarifications first with a recommended option. If you didn't ask about it, do not add it.",
  input_schema: {
    type: "object" as const,
    properties: {
      plan: { type: "string", description: "Structured markdown description of what you will implement: instruments, conditions, order types, quantities. Only include what the user asked for or confirmed in clarifications." },
      summary: { type: "string", description: "One-sentence summary, e.g. 'Buy 50 RELIANCE if RSI < 30, sell when RSI > 70'" },
    },
    required: ["plan", "summary"],
  },
};

const ASK_CLARIFICATION_TOOL: Anthropic.Tool = {
  name: "ask_clarification",
  description: "Call this BEFORE creating any primitives when the intent leaves critical decisions ambiguous (e.g. exact amount, quantity, which exchange, order type, schedule time, stop-loss level). Ask specific questions with explicit options. Always mark one option as recommended.",
  input_schema: {
    type: "object" as const,
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Short unique id, e.g. 'q1'" },
            question: { type: "string" },
            options: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  value: { type: "string" },
                  label: { type: "string" },
                  recommended: { type: "boolean" },
                },
                required: ["value", "label"],
              },
            },
          },
          required: ["id", "question", "options"],
        },
      },
    },
    required: ["questions"],
  },
};

function buildSystemPrompt(text: string): string {
  return `You are an intent processor for a financial trading harness. The user has expressed this intent:

"${text}"

Your job: create the right primitives to fulfill it in as few turns as possible.

## Turn budget
You have a limited number of turns. Minimise turns at every step:
- Call ask_clarification ONCE with ALL questions in a single call — never split into multiple asks.
- Call propose_plan ONCE with the complete plan.
- After plan approval, call ALL creation tools simultaneously in a single response — do not create primitives one at a time. For example, if you need to place 10 orders and register 2 triggers, emit all 12 tool calls in the same response.
- Call intent_complete in the SAME response as your last creation tool — do not use a separate turn for it.
- Never call a market data tool unless strictly required to determine a symbol or price needed for a creation call.

## Workflow

**Step 1 — Clarify (skip if intent is fully unambiguous)**
Call ask_clarification once with ALL questions.

**Step 2 — Plan**
Call propose_plan once with a complete, structured plan. Wait for approval.

**Step 3 — Create (one turn)**
After approval, emit ALL of the following in a single response:
- create_portfolio (if needed)
- create_strategy (if needed)
- ALL place_order calls (batch every order together)
- ALL register_trigger calls (batch every trigger together)
- intent_complete

Do NOT interleave creation with analysis. Do NOT wait for one creation to finish before starting another.

## Guidelines
- Immediate execution (buy/sell now): call place_order
- Conditional (when X, do Y): call register_trigger with a condition
- Scheduled/recurring: call register_trigger with recurring=true
- Agentic monitoring (watch X and decide): call register_trigger with action.type="reasoning_job"
- Portfolio/fund management: call create_portfolio first in the same response as register_trigger/place_order. Do NOT specify portfolioId in those downstream calls — the server will automatically inject the portfolioId from the create_portfolio result before executing them.
- Use product_type: "CNC" for equity delivery (long-term holds). Use "INTRADAY" only when the user explicitly asks for same-day trades.

## intent_complete fields
- type: atomic | conditional | scheduled | agentic | composite
- summary: one sentence describing what you created
- entry_condition: ONE sentence (≤100 chars), entry only — what triggers the entry
- exit_condition: ONE sentence (≤100 chars), exit only — what closes the position. Never include entry info here.

## Plan constraints
- Your plan must only contain what the user asked for or what they confirmed in clarifications.
- If you think something is a valuable addition (stop-loss, position sizing, extra instruments), raise it as a clarification question with a recommended option — then include it only if confirmed.
- Never silently add features, conditions, or parameters that were not discussed.`;
}

function extractPrimitives(toolName: string, result: string): IntentPrimitive[] {
  const primitives: IntentPrimitive[] = [];
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    if (parsed.triggerId && typeof parsed.triggerId === "string") {
      primitives.push({ type: "trigger", id: parsed.triggerId });
    }
    if (parsed.portfolioId && typeof parsed.portfolioId === "string") {
      primitives.push({ type: "portfolio", id: parsed.portfolioId });
    }
    if (parsed.strategyId && typeof parsed.strategyId === "string") {
      primitives.push({ type: "strategy", id: parsed.strategyId });
    }
    if (parsed.orderId && typeof parsed.orderId === "string") {
      primitives.push({ type: "order", id: parsed.orderId });
    }
  } catch {
    // non-JSON result; ignore
  }
  return primitives;
}

export async function runIntentProcessor(
  intentId: string,
  text: string,
  portfolioId: string | undefined,
  opts: IntentsRouteOpts,
): Promise<void> {
  let anthropic: Anthropic;
  try {
    anthropic = getAnthropicClient();
  } catch {
    await opts.intents.update(intentId, {
      status: "failed",
      summary: "Anthropic API key not configured",
      resolvedAt: new Date().toISOString(),
    });
    return;
  }

  // Build the combined tool map: static tools + factory-created tools
  const registerTriggerTool = createRegisterTriggerTool(opts.triggers);
  const portfolioTools = createPortfolioTools(opts.portfolios, opts.triggers, opts.trades);
  const strategyTools = createStrategyTools(opts.strategies, opts.triggers);

  const combinedTools: Record<string, ToolDefinition> = {};

  // Add static tools
  for (const name of STATIC_INTENT_PROCESSOR_TOOL_NAMES) {
    if (TOOLS[name]) combinedTools[name] = TOOLS[name];
  }

  // Add factory tools
  combinedTools["register_trigger"] = registerTriggerTool;
  for (const t of portfolioTools) {
    if (t.definition.name === "create_portfolio") {
      combinedTools["create_portfolio"] = t;
    }
  }
  for (const t of strategyTools) {
    if (t.definition.name === "create_strategy") {
      combinedTools["create_strategy"] = t;
    }
  }

  const toolDefs: Anthropic.Tool[] = Object.values(combinedTools).map(t => t.definition as Anthropic.Tool);
  toolDefs.push(INTENT_COMPLETE_TOOL);
  toolDefs.push(ASK_CLARIFICATION_TOOL);
  toolDefs.push(PROPOSE_PLAN_TOOL);

  let broker: import("../lib/brokers/types.js").BrokerAdapter;
  try {
    broker = getBrokerAdapter();
  } catch {
    await opts.intents.update(intentId, {
      status: "failed",
      summary: "Broker credentials not configured",
      resolvedAt: new Date().toISOString(),
    });
    return;
  }

  const messages: Anthropic.MessageParam[] = [];
  const collectedPrimitives: IntentPrimitive[] = [];
  let portfolioIdFromPrimitives = portfolioId;
  let shouldTerminate = false;
  let intentType: IntentType | undefined;
  let intentSummary: string | undefined;
  let intentEntry: string | undefined;
  let intentExit: string | undefined;
  const MAX_TURNS = 20;
  const PROCESSING_TIMEOUT_MS = 3 * 60 * 1000; // excludes time spent waiting for user input
  let userWaitMs = 0; // accumulated time blocked on clarifications / plan approvals
  const startTime = Date.now();
  const processingElapsed = () => Date.now() - startTime - userWaitMs;

  // Inject portfolio context if provided
  const userMessage = portfolioId
    ? `Process this intent. Use portfolioId="${portfolioId}" for any triggers or orders created.\n\nIntent: ${text}`
    : `Process this intent: ${text}`;

  messages.push({ role: "user", content: userMessage });

  try {
    for (let turn = 0; turn < MAX_TURNS && !shouldTerminate; turn++) {
      if (processingElapsed() > PROCESSING_TIMEOUT_MS) {
        throw new Error("Intent processor timed out after 3 minutes of active processing");
      }

      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: buildSystemPrompt(text),
        tools: toolDefs,
        messages,
      });

      // Add assistant response to messages
      messages.push({ role: "assistant", content: response.content });

      if (response.stop_reason === "end_turn") break;

      // Process tool calls
      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );
      if (toolUseBlocks.length === 0) break;

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const toolUse of toolUseBlocks) {
        if (toolUse.name === "intent_complete") {
          const args = toolUse.input as { type: IntentType; summary: string; entry_condition?: string; exit_condition?: string };
          intentType = args.type;
          intentSummary = args.summary;
          intentEntry = args.entry_condition;
          intentExit = args.exit_condition;
          shouldTerminate = true;
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify({ ok: true }),
          });
          continue;
        }

        if (toolUse.name === "ask_clarification") {
          const args = toolUse.input as { questions: ClarificationQuestion[] };

          await opts.intents.update(intentId, {
            status: "clarifying",
            clarifications: args.questions,
          });

          const waitStart = Date.now();
          const answers = await new Promise<Record<string, string>>((resolve, reject) => {
            pendingClarifications.set(intentId, { resolve, reject });
            setTimeout(() => {
              pendingClarifications.delete(intentId);
              reject(new Error("Clarification timed out after 10 minutes"));
            }, 10 * 60 * 1000);
          });
          userWaitMs += Date.now() - waitStart;

          await opts.intents.update(intentId, { status: "processing" });

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify({ answers }),
          });
          continue;
        }

        if (toolUse.name === "propose_plan") {
          const args = toolUse.input as { plan: string; summary: string };
          await opts.intents.update(intentId, {
            status: "planning",
            plan: args.plan,
            planSummary: args.summary,
            planFeedback: undefined,
          });

          const planWaitStart = Date.now();
          const result = await new Promise<{ approved: boolean; feedback?: string }>((resolve, reject) => {
            pendingPlanApprovals.set(intentId, { resolve, reject });
            setTimeout(() => {
              pendingPlanApprovals.delete(intentId);
              reject(new Error("Plan approval timed out after 10 minutes"));
            }, 10 * 60 * 1000);
          });
          userWaitMs += Date.now() - planWaitStart;

          await opts.intents.update(intentId, { status: "processing" });

          if (result.approved) {
            toolResults.push({
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: JSON.stringify({ approved: true, message: "User approved the plan. Proceed with implementation." }),
            });
          } else {
            const feedback = result.feedback ?? "User requested changes but provided no specific feedback.";
            await opts.intents.update(intentId, { planFeedback: feedback });
            toolResults.push({
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: JSON.stringify({ approved: false, feedback, message: "User rejected the plan. Review their feedback and propose a revised plan or ask for clarification." }),
            });
          }
          continue;
        }

        // Look up tool in combined map
        const toolDef = combinedTools[toolUse.name];
        if (!toolDef) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify({ error: `Unknown tool: ${toolUse.name}` }),
            is_error: true,
          });
          continue;
        }

        try {
          const args = toolUse.input as Record<string, unknown>;
          // Inject intentId into register_trigger calls so triggers are linked
          if (toolUse.name === "register_trigger") {
            args.intentId = intentId;
            if (portfolioIdFromPrimitives && !args.portfolioId) {
              args.portfolioId = portfolioIdFromPrimitives;
            }
          }
          // Inject intentId into create_strategy calls
          if (toolUse.name === "create_strategy") {
            args.intentId = intentId;
          }
          // Inject intentId and portfolioId into place_order if available
          if (toolUse.name === "place_order") {
            args.intentId = intentId;
            if (portfolioIdFromPrimitives && !args.portfolioId) {
              args.portfolioId = portfolioIdFromPrimitives;
            }
          }

          const result = await toolDef.handler(args, broker);
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: result,
          });

          // Auto-record every successful place_order
          if (toolUse.name === "place_order") {
            try {
              const parsed = JSON.parse(result) as Record<string, unknown>;
              if (!parsed["error"]) {
                const orderId = String(parsed["orderId"] ?? randomUUID());
                const symbol = (args.symbol as string).toUpperCase();
                const securityId = await getSecurityId(symbol).catch(() => "unknown");
                const currentStatus = String(parsed["currentStatus"] ?? "").toUpperCase();
                const initialStatus: import("../lib/storage/types.js").TradeStatus =
                  currentStatus === "FILLED" || currentStatus === "TRADED" || currentStatus === "PART_TRADED" ? "filled"
                  : currentStatus === "REJECTED" ? "rejected"
                  : currentStatus === "CANCELLED" || currentStatus === "EXPIRED" ? "cancelled"
                  : "pending";
                await opts.trades.append({
                  id: randomUUID(),
                  orderId,
                  symbol,
                  securityId,
                  transactionType: args.transaction_type as "BUY" | "SELL",
                  quantity: args.quantity as number,
                  orderType: args.order_type as "MARKET" | "LIMIT",
                  requestedPrice: args.price as number | undefined,
                  status: initialStatus,
                  executedPrice: initialStatus === "filled"
                    ? (parsed["executedPrice"] as number | undefined) : undefined,
                  filledAt: initialStatus === "filled"
                    ? (parsed["filledAt"] as string | undefined) : undefined,
                  rejectionReason: initialStatus === "rejected"
                    ? (parsed["rejectionReason"] as string | undefined) : undefined,
                  strategyId: args.strategy_id as string | undefined,
                  portfolioId: args.portfolioId as string | undefined,
                  intentId,
                  note: args.note as string | undefined,
                  createdAt: new Date().toISOString(),
                });
              }
            } catch (err) {
              console.error("[intents] failed to record trade:", err);
            }
          }

          // Extract primitive IDs from results
          const newPrimitives = extractPrimitives(toolUse.name, result);
          for (const p of newPrimitives) {
            if (!collectedPrimitives.some(e => e.id === p.id && e.type === p.type)) {
              collectedPrimitives.push(p);
              // Update intent with newly discovered primitives
              await opts.intents.update(intentId, { primitives: [...collectedPrimitives] });
            }
            // Track portfolio ID for downstream tools
            if (p.type === "portfolio" && !portfolioIdFromPrimitives) {
              portfolioIdFromPrimitives = p.id;
              await opts.intents.update(intentId, { portfolioId: p.id });
            }
          }
        } catch (err) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify({ error: (err as Error).message }),
            is_error: true,
          });
        }
      }

      messages.push({ role: "user", content: toolResults });
    }

    // Finalize intent
    await opts.intents.update(intentId, {
      status: "active",
      type: intentType,
      summary: intentSummary ?? "Intent processed",
      ...(intentEntry !== undefined && { entryCondition: intentEntry }),
      ...(intentExit !== undefined && { exitCondition: intentExit }),
      primitives: collectedPrimitives,
      resolvedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`[intents] Processing failed for ${intentId}:`, err);
    await opts.intents.update(intentId, {
      status: "failed",
      summary: `Processing failed: ${(err as Error).message}`,
      resolvedAt: new Date().toISOString(),
    });
  }
}

export async function intentsRoute(
  fastify: FastifyInstance,
  opts: IntentsRouteOpts,
) {
  // POST /api/intents — create and start async processing
  fastify.post("/api/intents", async (request, reply) => {
    const body = request.body as { text: string; portfolioId?: string };
    if (!body.text?.trim()) {
      reply.code(400);
      return { error: "text is required" };
    }

    const now = new Date().toISOString();
    const intent: Intent = {
      id: randomUUID(),
      text: body.text.trim(),
      status: "processing",
      primitives: [],
      portfolioId: body.portfolioId,
      createdAt: now,
    };

    await opts.intents.append(intent);
    reply.code(202);

    // Start async processing (fire and forget)
    setImmediate(() => {
      runIntentProcessor(intent.id, intent.text, intent.portfolioId, opts).catch(err =>
        console.error("[intents] Unhandled error in processor:", err)
      );
    });

    return { intentId: intent.id };
  });

  // GET /api/intents — list with optional status filter
  fastify.get("/api/intents", async (request) => {
    const query = request.query as { status?: string };
    if (!query.status) return opts.intents.list();
    const statuses = query.status.split(",").map(s => s.trim()) as import("../lib/storage/types.js").IntentStatus[];
    return opts.intents.list({ status: statuses });
  });

  // GET /api/intents/:id — get with expanded primitive summaries
  fastify.get("/api/intents/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const intent = await opts.intents.get(id);
    if (!intent) {
      reply.code(404);
      return { error: "Not found" };
    }

    // Expand primitives
    const expanded = await Promise.all(
      intent.primitives.map(async (p) => {
        try {
          if (p.type === "trigger") {
            const trigger = await opts.triggers.get(p.id);
            const scheduledAt = trigger?.nextFireAt
              ?? (trigger?.condition.mode === "time" ? ((trigger.condition as { mode: "time"; fireAt?: string; at?: string }).fireAt ?? (trigger.condition as { mode: "time"; at?: string }).at) : undefined);
            return { ...p, trigger: trigger ? { name: trigger.name, status: trigger.status, nextFireAt: trigger.nextFireAt, scheduledAt, lastFiredAt: trigger.lastFiredAt } : null };
          }
          if (p.type === "portfolio") {
            const portfolio = await opts.portfolios.get(p.id);
            return { ...p, portfolio: portfolio ? { name: portfolio.name, allocation: portfolio.allocation, status: portfolio.status } : null };
          }
          if (p.type === "strategy") {
            const strategy = await opts.strategies.get(p.id);
            return { ...p, strategy: strategy ? { name: strategy.name } : null };
          }
          if (p.type === "order") {
            const trade = await opts.trades.get(p.id);
            return { ...p, trade: trade ? { symbol: trade.symbol, status: trade.status, quantity: trade.quantity, transactionType: trade.transactionType, executedPrice: trade.executedPrice } : null };
          }
        } catch {
          // ignore expansion errors
        }
        return p;
      })
    );

    return { ...intent, primitives: expanded };
  });

  // POST /api/intents/:id/clarify — submit answers to resume a paused processor
  fastify.post("/api/intents/:id/clarify", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { answers: Record<string, string> };

    const intent = await opts.intents.get(id);
    if (!intent) { reply.code(404); return { error: "Not found" }; }
    if (intent.status !== "clarifying") { reply.code(409); return { error: "Intent is not awaiting clarification" }; }

    const entry = pendingClarifications.get(id);
    if (!entry) { reply.code(409); return { error: "No pending clarification" }; }

    pendingClarifications.delete(id);
    entry.resolve(body.answers);
    return { ok: true };
  });

  // POST /api/intents/:id/approve-plan — approve or reject a proposed plan
  fastify.post("/api/intents/:id/approve-plan", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { approved: boolean; feedback?: string };
    const intent = await opts.intents.get(id);
    if (!intent) { reply.code(404); return { error: "Not found" }; }
    if (intent.status !== "planning") { reply.code(409); return { error: "Intent is not awaiting plan approval" }; }
    const entry = pendingPlanApprovals.get(id);
    if (!entry) { reply.code(409); return { error: "No pending plan approval" }; }
    pendingPlanApprovals.delete(id);
    entry.resolve({ approved: body.approved, feedback: body.feedback });
    return { ok: true };
  });

  // DELETE /api/intents/:id — cancel intent and linked triggers
  fastify.delete("/api/intents/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const intent = await opts.intents.get(id);
    if (!intent) {
      reply.code(404);
      return { error: "Not found" };
    }
    if (intent.status === "cancelled") {
      return { ok: true, message: "Already cancelled" };
    }

    // Drain pending awaits so processors can exit cleanly
    pendingPlanApprovals.get(id)?.reject(new Error("Intent cancelled by user"));
    pendingPlanApprovals.delete(id);
    pendingClarifications.get(id)?.reject(new Error("Intent cancelled by user"));
    pendingClarifications.delete(id);

    // Cancel linked triggers
    const triggerPrimitives = intent.primitives.filter(p => p.type === "trigger");
    let cancelledTriggers = 0;
    for (const p of triggerPrimitives) {
      try {
        const trigger = await opts.triggers.get(p.id);
        if (trigger && (trigger.status === "active" || trigger.status === "paused")) {
          await opts.triggers.setStatus(p.id, "cancelled");
          cancelledTriggers++;
        }
      } catch {
        // ignore
      }
    }

    await opts.intents.update(id, {
      status: "cancelled",
      resolvedAt: new Date().toISOString(),
    });

    return { ok: true, cancelledTriggers };
  });

  // GET /api/intents/:id/performance — realized P&L and open positions for an intent
  fastify.get("/api/intents/:id/performance", async (request, reply) => {
    const { id } = request.params as { id: string };
    const intent = await opts.intents.get(id);
    if (!intent) {
      reply.code(404);
      return { error: "Not found" };
    }

    try {
      const broker = getBrokerAdapter();
      await syncOrders(broker, opts.trades);
    } catch { /* non-fatal */ }

    const trades = await opts.trades.list({ intentId: id });
    const openPositions = computeOpenPositions(trades.filter(t => t.status === "filled"));

    // Compute realized P&L: for each filled SELL, compute P&L against prior filled BUYs of the same symbol
    let realizedPnl = 0;
    const filledTrades = trades.filter(t => t.status === "filled");
    for (const sell of filledTrades.filter(t => t.transactionType === "SELL")) {
      const priorBuys = filledTrades.filter(
        t => t.transactionType === "BUY" && t.symbol === sell.symbol && t.createdAt <= sell.createdAt
      );
      if (priorBuys.length > 0 && sell.executedPrice != null) {
        const totalQty = priorBuys.reduce((s, t) => s + t.quantity, 0);
        const totalCost = priorBuys.reduce((s, t) => s + (t.executedPrice! * t.quantity), 0);
        if (totalQty > 0) {
          const avgCost = totalCost / totalQty;
          realizedPnl += +((sell.executedPrice - avgCost) * sell.quantity).toFixed(2);
        }
      }
    }

    type EnrichedPosition = (typeof openPositions)[number] & { ltp?: number; unrealizedPnl?: number };
    const enriched: EnrichedPosition[] = openPositions.map(p => ({ ...p }));
    let unrealizedPnl = 0;

    if (openPositions.length > 0) {
      try {
        const broker = getBrokerAdapter();
        const quotes = await broker.getQuote(openPositions.map(p => p.symbol));
        const ltpMap = Object.fromEntries(quotes.map(q => [q.symbol.toUpperCase(), q.lastPrice]));
        for (const pos of enriched) {
          const ltp = ltpMap[pos.symbol.toUpperCase()];
          if (ltp != null && ltp > 0) {
            pos.ltp = ltp;
            pos.unrealizedPnl = +((ltp - pos.avgBuyPrice) * pos.quantity).toFixed(2);
            unrealizedPnl += pos.unrealizedPnl;
          }
        }
        unrealizedPnl = +unrealizedPnl.toFixed(2);
      } catch (err) {
        console.warn("[intents/performance] LTP fetch failed:", err instanceof Error ? err.message : err);
      }
    }

    const deployedCapital = +enriched.reduce((s, p) => s + p.deployedCapital, 0).toFixed(2);

    let allocation: number | undefined;
    if (intent.portfolioId) {
      try {
        const portfolio = await opts.portfolios.get(intent.portfolioId);
        if (portfolio) allocation = portfolio.allocation;
      } catch { /* non-fatal */ }
    }

    return {
      intentId: id,
      ...(intent.portfolioId && { portfolioId: intent.portfolioId }),
      ...(allocation !== undefined && { allocation }),
      deployedCapital,
      ...(allocation !== undefined && { availableCapital: +(allocation - deployedCapital).toFixed(2) }),
      trades,
      openPositions: enriched,
      realizedPnl: +realizedPnl.toFixed(2),
      unrealizedPnl,
      tradeCount: trades.length,
    };
  });
}
