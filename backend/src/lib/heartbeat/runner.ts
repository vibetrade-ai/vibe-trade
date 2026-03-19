import type Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "crypto";
import type { BrokerAdapter } from "../brokers/types.js";
import type { TriggerStore, ApprovalStore, TriggerAuditStore, MemoryStore, StrategyStore } from "../storage/index.js";
import type { Trigger, SystemSnapshot, TradeArgs } from "./types.js";
import { TOOLS } from "../tools.js";
import { getAnthropicClient } from "../credentials.js";
import type { Candle } from "../indicators.js";
import { computeIndicators } from "../indicators.js";

// ── TtlCache ──────────────────────────────────────────────────────────────────
class TtlCache<T> {
  private entries = new Map<string, { value: T; expiresAt: number }>();
  get(key: string): T | undefined {
    const e = this.entries.get(key);
    if (!e || Date.now() > e.expiresAt) { this.entries.delete(key); return undefined; }
    return e.value;
  }
  set(key: string, value: T, ttlMs: number): void {
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
}

// Module-level candle cache — persists across runs, TTL keeps data fresh
const candleCache = new TtlCache<Candle[]>();

function candleTtl(interval: string): number {
  return interval === "1d" ? 4 * 3600_000 : parseInt(interval) * 60_000;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const JOB_TIMEOUT_MS = 5 * 60 * 1000;
const ANTHROPIC_CALL_TIMEOUT_MS = 120_000;
const HISTORY_RESULT_LIMIT = 3000;

const GENERIC_CACHEABLE = new Set([
  "get_fundamentals", "fetch_news", "get_market_status", "search_instruments",
  "get_top_movers", "compare_stocks", "get_etf_info",
]);

function summariseForHistory(toolName: string, text: string): string {
  if (text.length <= HISTORY_RESULT_LIMIT) return text;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return JSON.stringify(parsed.slice(0, 5), null, 2)
        + `\n... [${parsed.length - 5} more items omitted. Call ${toolName} again with same args for full result.]`;
    }
  } catch { /* not JSON array */ }
  return text.slice(0, HISTORY_RESULT_LIMIT)
    + `\n... [${text.length - HISTORY_RESULT_LIMIT} chars omitted. Call ${toolName} again with same args for full result.]`;
}

function historicalSummary(symbol: string, interval: string, candles: Candle[]): string {
  const periodHigh = Math.max(...candles.map(c => c.high));
  const periodLow  = Math.min(...candles.map(c => c.low));
  const avgVol     = Math.round(candles.reduce((s, c) => s + c.volume, 0) / candles.length);
  return JSON.stringify({
    symbol, interval, total_candles: candles.length,
    period_high: periodHigh, period_low: periodLow, avg_volume: avgVol,
    last_10_candles: candles.slice(-10),
  }, null, 2);
}

function indicatorSummary(symbol: string, interval: string, candles: Candle[]): string {
  const result = computeIndicators(candles);
  return JSON.stringify({
    symbol, interval, candles_analyzed: candles.length,
    last_5_with_indicators: result.slice(-5),
  }, null, 2);
}

const READ_ONLY_TOOLS = [
  "get_quote", "get_index_quote", "get_positions", "get_funds",
  "get_historical_data", "compute_indicators", "get_fundamentals",
  "fetch_news", "get_market_status", "get_top_movers", "search_instruments",
];

const RUNNER_SYSTEM = `You are VibeTrade's autonomous analysis engine. A trigger has fired and you must analyze the situation and decide on a course of action.

Available read-only tools: get_quote, get_index_quote, get_positions, get_funds, get_historical_data, compute_indicators, get_fundamentals, fetch_news, get_market_status, get_top_movers, search_instruments

Available action tools:
- register_soft_trigger: Register a new soft (reasoning_job) trigger directly, no approval needed
- queue_trade_approval: Queue a trade for user approval (user will approve/reject in the app). You may call this multiple times.
- queue_hard_trigger_approval: Queue a new hard_order trigger for user consent
- no_action: Signal that no action is warranted

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
        name: { type: "string", description: "Human-readable trigger name" },
        scope: { type: "string", enum: ["symbol", "market", "portfolio"] },
        watchSymbols: { type: "array", items: { type: "string" }, description: "Symbols to watch" },
        condition: {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["code", "llm", "event"] },
            expression: { type: "string", description: "For code mode: JS expression against snapshot" },
            description: { type: "string", description: "For llm mode: natural language condition" },
            kind: { type: "string", enum: ["position_opened", "position_closed", "news_mention", "sentiment_negative", "pe_below", "fundamentals_changed", "vix_above", "nifty_drop_percent"], description: "Event kind (event mode)" },
            symbols: { type: "array", items: { type: "string" }, description: "Symbols (position/news/sentiment event kinds)" },
            categories: { type: "array", items: { type: "string" }, description: "RSS categories (news/sentiment event kinds)" },
            symbol: { type: "string", description: "Single symbol for pe_below / fundamentals_changed" },
            threshold: { type: "number", description: "Threshold for pe_below, vix_above, nifty_drop_percent" },
          },
          required: ["mode"],
        },
        expiresAt: { type: "string", description: "ISO string expiry (optional)" },
        context: { type: "string", description: "Optional context/goal to carry into the next reasoning job when this trigger fires" },
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
            mode: { type: "string", enum: ["code", "llm", "event"] },
            expression: { type: "string" },
            description: { type: "string" },
            kind: { type: "string", enum: ["position_opened", "position_closed", "news_mention", "sentiment_positive", "sentiment_negative", "pe_below", "pe_above", "fundamentals_changed", "vix_above", "vix_below", "nifty_drop_percent", "nifty_rise_percent"] },
            symbols: { type: "array", items: { type: "string" } },
            categories: { type: "array", items: { type: "string" } },
            symbol: { type: "string" },
            threshold: { type: "number" },
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
  broker: BrokerAdapter,
  triggerStore: TriggerStore,
  approvalStore: ApprovalStore,
  auditStore: TriggerAuditStore,
  memory: MemoryStore,
  strategyStore?: StrategyStore,
): Promise<void> {
  const startedAt = Date.now();

  const memoryContent = await memory.read().catch(() => "");
  let systemPrompt = RUNNER_SYSTEM + (memoryContent ? `\n\n<memory>\n${memoryContent}\n</memory>` : "");

  // Inject strategy context if trigger is linked to a strategy
  if (trigger.strategyId && strategyStore) {
    const strategy = await strategyStore.get(trigger.strategyId).catch(() => null);
    if (strategy) {
      if (strategy.status === "archived") {
        console.warn(`[heartbeat] trigger ${trigger.id} linked to archived strategy ${trigger.strategyId} — cancelling`);
        await triggerStore.setStatus(trigger.id, "cancelled");
        return;
      }
      const activeTriggers = await triggerStore.list({ status: "active" });
      const linkedTriggers = activeTriggers.filter(t => t.strategyId === strategy.id);
      const triggersBlock = linkedTriggers.length > 0
        ? linkedTriggers.map(t => `- "${t.name}": ${JSON.stringify(t.condition)} → ${t.action.type}`).join("\n")
        : "None";
      const availableBalance = snapshot.funds?.availableBalance ?? null;
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

  if (trigger.context) {
    systemPrompt += `\n\n<trigger_context>\n${trigger.context}\n</trigger_context>`;
  }

  const allTools: Anthropic.Tool[] = [
    ...READ_ONLY_TOOLS.map(name => TOOLS[name]!.definition),
    ...RUNNER_TOOLS,
  ];

  // Determine user message: use action.prompt if present, else auto-build from snapshot
  const isCronTrigger = !!(trigger.condition as { mode: string; cron?: string }).cron;
  const actionPrompt = (trigger.action as { type: string; prompt?: string }).prompt;

  let initialUserMsg: string;
  if (actionPrompt) {
    initialUserMsg = actionPrompt;
  } else if (isCronTrigger) {
    initialUserMsg = `Scheduled trigger fired: "${trigger.name}"
Scope: ${trigger.scope}
${trigger.watchSymbols.length > 0 ? `Watch symbols: ${trigger.watchSymbols.join(", ")}` : ""}

Analyze the market and take appropriate action.`;
  } else {
    initialUserMsg = `Trigger fired: "${trigger.name}"
Condition: ${JSON.stringify(trigger.condition)}
Scope: ${trigger.scope}
Watch symbols: ${trigger.watchSymbols.join(", ")}

Current market snapshot:
${JSON.stringify(snapshot, null, 2)}

Analyze the situation and take appropriate action.`;
  }

  const history: Anthropic.MessageParam[] = [
    { role: "user", content: initialUserMsg },
  ];

  const resultCache = new Map<string, string>();
  let terminated = false;
  let turns = 0;
  const approvalIds: string[] = [];
  let lastNoActionReason = "";
  let lastSummary = "";

  async function runJobLoop(): Promise<void> {
    while (!terminated && turns < 10) {
      turns++;
      const resp = await getAnthropicClient().messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        system: systemPrompt,
        tools: allTools,
        messages: history,
      }, { timeout: ANTHROPIC_CALL_TIMEOUT_MS });

      const respMsg = resp as Anthropic.Message;
      history.push({ role: "assistant", content: respMsg.content });

      if (respMsg.stop_reason === "end_turn") break;

      const toolUses = respMsg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (toolUses.length === 0) break;

      // Run all tool calls concurrently
      const toolResultEntries = await Promise.all(toolUses.map(async (toolUse: Anthropic.ToolUseBlock) => {
        const args = toolUse.input as Record<string, unknown>;
        let resultText: string;
        let shouldTerminate = false;
        let noActionReason = "";
        let approvalId = "";
        let summaryUpdate = "";

        try {
          if (toolUse.name === "no_action") {
            noActionReason = args.reason as string;
            shouldTerminate = true;
            resultText = "Noted. Job complete.";

          } else if (toolUse.name === "queue_trade_approval") {
            const tradeArgs: TradeArgs = {
              symbol: args.symbol as string,
              transaction_type: args.transaction_type as "BUY" | "SELL",
              quantity: args.quantity as number,
              order_type: args.order_type as "MARKET" | "LIMIT",
              price: args.price as number | undefined,
            };
            const id = randomUUID();
            const expiry = new Date(Date.now() + 30 * 60 * 1000).toISOString();
            await approvalStore.add({
              id, kind: "trade",
              triggerId: trigger.id, triggerName: trigger.name,
              reasoning: args.reasoning as string,
              tradeArgs, status: "pending",
              createdAt: new Date().toISOString(), expiresAt: expiry,
              ...(trigger.strategyId ? { strategyId: trigger.strategyId } : {}),
            });
            approvalId = id;
            summaryUpdate = "trade";
            console.log(`[heartbeat] queued trade approval ${id}`);
            resultText = `Trade approval queued (id: ${id}). You may queue more or call no_action when done.`;

          } else if (toolUse.name === "queue_hard_trigger_approval") {
            const id = randomUUID();
            const expiry = new Date(Date.now() + 30 * 60 * 1000).toISOString();
            await approvalStore.add({
              id, kind: "hard_trigger",
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
            approvalId = id;
            console.log(`[heartbeat] queued hard_trigger approval ${id}`);
            resultText = `Hard trigger approval queued (id: ${id}).`;

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
              ...(trigger.strategyId ? { strategyId: trigger.strategyId } : {}),
              ...(args.context ? { context: args.context as string } : {}),
            };
            await triggerStore.upsert(newTrigger);
            console.log(`[heartbeat] registered new soft trigger ${newTrigger.id}: ${newTrigger.name}`);
            resultText = `Trigger "${newTrigger.name}" registered (id: ${newTrigger.id}).`;

          } else if (toolUse.name === "get_historical_data") {
            const symbol = args.symbol as string;
            const interval = args.interval as string;
            const days = Math.min(args.days as number, interval === "1d" ? 365 : 30);
            const cacheKey = `get_historical_data:${JSON.stringify(args)}`;
            const cached = resultCache.get(cacheKey);
            if (cached !== undefined) {
              resultText = cached;
            } else {
              const candleKey = `${symbol}:${interval}:${days}`;
              let candles = candleCache.get(candleKey);
              if (!candles) {
                const to = new Date();
                const from = new Date();
                from.setDate(from.getDate() - days);
                candles = await broker.getHistory(symbol, interval as import("../brokers/types.js").CandleInterval, from, to);
                candleCache.set(candleKey, candles, candleTtl(interval));
              }
              const summary = historicalSummary(symbol, interval, candles);
              resultCache.set(cacheKey, summary);
              resultText = summary;
            }

          } else if (toolUse.name === "compute_indicators") {
            const symbol = args.symbol as string;
            const interval = args.interval as string;
            const days = Math.min(args.days as number, interval === "1d" ? 365 : 30);
            const cacheKey = `compute_indicators:${JSON.stringify(args)}`;
            const cached = resultCache.get(cacheKey);
            if (cached !== undefined) {
              resultText = cached;
            } else {
              const candleKey = `${symbol}:${interval}:${days}`;
              let candles = candleCache.get(candleKey);
              if (!candles) {
                const to = new Date();
                const from = new Date();
                from.setDate(from.getDate() - days);
                candles = await broker.getHistory(symbol, interval as import("../brokers/types.js").CandleInterval, from, to);
                candleCache.set(candleKey, candles, candleTtl(interval));
              }
              if (candles.length < 26) {
                resultText = JSON.stringify({ error: "Insufficient data for indicators." });
              } else {
                const summary = indicatorSummary(symbol, interval, candles);
                resultCache.set(cacheKey, summary);
                resultText = summary;
              }
            }

          } else {
            const cacheKey = `${toolUse.name}:${JSON.stringify(args)}`;
            const toolDef = TOOLS[toolUse.name];
            if (!toolDef) {
              resultText = `TOOL_ERROR: Unknown tool "${toolUse.name}"`;
            } else if (GENERIC_CACHEABLE.has(toolUse.name)) {
              const cached = resultCache.get(cacheKey);
              if (cached !== undefined) {
                resultText = cached;
              } else {
                const fullResult = await toolDef.handler(args, broker);
                resultCache.set(cacheKey, fullResult);
                resultText = summariseForHistory(toolUse.name, fullResult);
              }
            } else {
              resultText = await toolDef.handler(args, broker);
            }
          }
        } catch (err) {
          resultText = `TOOL_ERROR: ${err instanceof Error ? err.message : String(err)}`;
        }

        return { id: toolUse.id, resultText, shouldTerminate, noActionReason, approvalId, summaryUpdate };
      }));

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const entry of toolResultEntries) {
        toolResults.push({ type: "tool_result", tool_use_id: entry.id, content: entry.resultText });
        if (entry.shouldTerminate) {
          terminated = true;
          lastNoActionReason = entry.noActionReason;
        }
        if (entry.approvalId) {
          approvalIds.push(entry.approvalId);
          if (entry.summaryUpdate === "trade") {
            lastSummary = `Queued ${approvalIds.length} trade approval(s)`;
          }
        }
      }

      if (!terminated) {
        history.push({ role: "user", content: toolResults });
      }
    }
  }

  try {
    // Race against wall-clock timeout
    await Promise.race([
      runJobLoop(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Job exceeded 5-minute wall-clock limit")), JOB_TIMEOUT_MS)
      ),
    ]);

    const durationMs = Date.now() - startedAt;
    const isCron = !!(trigger.condition as { mode: string; cron?: string }).cron;

    if (lastNoActionReason) {
      await auditStore.append({
        id: randomUUID(), triggerId: trigger.id, triggerName: trigger.name,
        firedAt: snapshot.capturedAt, snapshotAtFire: snapshot, action: trigger.action,
        outcome: { type: "reasoning_job_no_action", reason: lastNoActionReason },
        ...(trigger.strategyId ? { strategyId: trigger.strategyId } : {}),
      });
    } else if (isCron || approvalIds.length > 0) {
      // Use richer completed outcome for cron runs or multi-approval runs
      const summary = approvalIds.length > 0
        ? lastSummary || `Queued ${approvalIds.length} approval(s)`
        : "Completed with no explicit actions";
      await auditStore.append({
        id: randomUUID(), triggerId: trigger.id, triggerName: trigger.name,
        firedAt: snapshot.capturedAt, snapshotAtFire: snapshot, action: trigger.action,
        outcome: { type: "reasoning_job_completed", summary, approvalIds, durationMs },
        ...(trigger.strategyId ? { strategyId: trigger.strategyId } : {}),
      });
    } else {
      // Single approval or no action for legacy triggers
      await auditStore.append({
        id: randomUUID(), triggerId: trigger.id, triggerName: trigger.name,
        firedAt: snapshot.capturedAt, snapshotAtFire: snapshot, action: trigger.action,
        outcome: { type: "reasoning_job_queued", approvalId: approvalIds[0] },
        ...(trigger.strategyId ? { strategyId: trigger.strategyId } : {}),
      });
    }

    console.log(`[heartbeat] runner for ${trigger.id} completed in ${durationMs}ms`);

  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[heartbeat] reasoning job for ${trigger.id} exited: ${reason}`);
    await auditStore.append({
      id: randomUUID(), triggerId: trigger.id, triggerName: trigger.name,
      firedAt: snapshot.capturedAt, snapshotAtFire: snapshot, action: trigger.action,
      outcome: { type: "reasoning_job_no_action", reason },
    }).catch(() => {});
  }
}
