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
import { fetchCandles } from "../dhan/candles.js";
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
  return interval === "D" ? 4 * 3600_000 : parseInt(interval) * 60_000;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const JOB_TIMEOUT_MS = 5 * 60 * 1000;         // Fix 6: 5-min wall clock
const ANTHROPIC_CALL_TIMEOUT_MS = 120_000;    // Fix 7: 2-min per-call timeout
const HISTORY_RESULT_LIMIT = 3000;            // Fix 3: compact history entries

// Tools whose results are stable during a ~5-min run (skip for live price feeds)
const GENERIC_CACHEABLE = new Set([
  "get_fundamentals", "fetch_news", "get_market_status", "search_instruments",
  "get_top_movers", "compare_stocks", "get_etf_info",
]);

// ── summariseForHistory ───────────────────────────────────────────────────────
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

// ── compact summaries for candle tools ───────────────────────────────────────
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

    // Per-run result cache: "toolName:JSON.stringify(args)" → full/compact result string
    const resultCache = new Map<string, string>();

    let terminated = false;
    let turns = 0;
    const approvalIds: string[] = [];
    let lastNoActionReason = "";
    let lastSummary = "";

    // ── Main loop (extracted so we can race against a wall-clock timeout) ──
    async function runJobLoop(): Promise<void> {
      while (!terminated && turns < 10) {
        turns++;
        const resp = await anthropic.messages.create({   // Fix 8: reduced max_tokens
          model: "claude-sonnet-4-6",
          max_tokens: 2048,
          system: systemPrompt,
          tools: allTools,
          messages: history,
        }, { timeout: ANTHROPIC_CALL_TIMEOUT_MS });      // Fix 7: per-call timeout

        const respMsg = resp as Anthropic.Message;
        history.push({ role: "assistant", content: respMsg.content });

        if (respMsg.stop_reason === "end_turn") break;

        const toolUses = respMsg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
        if (toolUses.length === 0) break;

        // Fix 5: run all tool calls in this turn concurrently
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
                triggerId: schedule.id, triggerName: schedule.name,
                reasoning: args.reasoning as string,
                tradeArgs, status: "pending",
                createdAt: new Date().toISOString(), expiresAt: expiry,
                ...(schedule.strategyId ? { strategyId: schedule.strategyId } : {}),
              });
              approvalId = id;
              summaryUpdate = "trade";
              console.log(`[scheduler] queued trade approval ${id} for schedule ${schedule.id}`);
              resultText = `Trade approval queued (id: ${id}). You may queue more or call no_action when done.`;

            } else if (toolUse.name === "queue_hard_trigger_approval") {
              const id = randomUUID();
              const expiry = new Date(Date.now() + 30 * 60 * 1000).toISOString();
              await approvalStore.add({
                id, kind: "hard_trigger",
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
              approvalId = id;
              console.log(`[scheduler] queued hard_trigger approval ${id}`);
              resultText = `Hard trigger approval queued (id: ${id}).`;

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

            // Fix 2: get_historical_data — candle cache + compact summary ──────
            } else if (toolUse.name === "get_historical_data") {
              const symbol = args.symbol as string;
              const interval = args.interval as "1" | "5" | "15" | "25" | "60" | "D";
              const days = Math.min(args.days as number, interval === "D" ? 365 : 30);
              const cacheKey = `get_historical_data:${JSON.stringify(args)}`;
              const cached = resultCache.get(cacheKey);
              if (cached !== undefined) {
                resultText = cached;
              } else {
                const candleKey = `${symbol}:${interval}:${days}`;
                let candles = candleCache.get(candleKey);
                if (!candles) {
                  candles = await fetchCandles(symbol, interval, days, dhan);
                  candleCache.set(candleKey, candles, candleTtl(interval));
                }
                const summary = historicalSummary(symbol, interval, candles);
                resultCache.set(cacheKey, summary);
                resultText = summary;
              }

            // Fix 2: compute_indicators — share candles from candleCache ────────
            } else if (toolUse.name === "compute_indicators") {
              const symbol = args.symbol as string;
              const interval = args.interval as "1" | "5" | "15" | "25" | "60" | "D";
              const days = Math.min(args.days as number, interval === "D" ? 365 : 30);
              const cacheKey = `compute_indicators:${JSON.stringify(args)}`;
              const cached = resultCache.get(cacheKey);
              if (cached !== undefined) {
                resultText = cached;
              } else {
                const candleKey = `${symbol}:${interval}:${days}`;
                let candles = candleCache.get(candleKey);
                if (!candles) {
                  candles = await fetchCandles(symbol, interval, days, dhan);
                  candleCache.set(candleKey, candles, candleTtl(interval));
                } else {
                  console.log(`[runner] cache hit for compute_indicators:${candleKey} (reusing candles from candleCache)`);
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
              // Fix 2: generic tools — resultCache for stable tools, direct call for live feeds
              const cacheKey = `${toolUse.name}:${JSON.stringify(args)}`;
              const toolDef = TOOLS[toolUse.name];
              if (!toolDef) {
                resultText = `TOOL_ERROR: Unknown tool "${toolUse.name}"`;
              } else if (GENERIC_CACHEABLE.has(toolUse.name)) {
                const cached = resultCache.get(cacheKey);
                if (cached !== undefined) {
                  resultText = cached; // full result on re-call
                } else {
                  const fullResult = await toolDef.handler(args, dhan);
                  resultCache.set(cacheKey, fullResult);
                  resultText = summariseForHistory(toolUse.name, fullResult); // Fix 3
                }
              } else {
                resultText = await toolDef.handler(args, dhan);
              }
            }
          } catch (err) {
            resultText = `TOOL_ERROR: ${err instanceof Error ? err.message : String(err)}`;
          }

          return { id: toolUse.id, resultText, shouldTerminate, noActionReason, approvalId, summaryUpdate };
        }));

        // Collect parallel results
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

    // Fix 6: race against wall-clock timeout
    await Promise.race([
      runJobLoop(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Job exceeded 5-minute wall-clock limit")), JOB_TIMEOUT_MS)
      ),
    ]);

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
