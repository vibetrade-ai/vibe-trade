import vm from "vm";
import Anthropic from "@anthropic-ai/sdk";
import type { Trigger, SystemSnapshot } from "./types.js";

export function evaluateTimeTriggers(triggers: Trigger[]): string[] {
  const now = Date.now();
  return triggers
    .filter(t => {
      const cond = t.condition as { mode: "time"; fireAt: string };
      return now >= new Date(cond.fireAt).getTime();
    })
    .map(t => t.id);
}

type CodeCondition = { mode: "code"; expression: string };
type LlmCondition  = { mode: "llm"; description: string };

const anthropic = new Anthropic();

const SAFE_QUOTE = { lastPrice: 0, previousClose: 0, changePercent: 0, open: 0, high: 0, low: 0, symbol: "", securityId: "" };

export function evaluateCodeTriggers(snapshot: SystemSnapshot, triggers: Trigger[]): string[] {
  const fired: string[] = [];

  // Wrap quotes in a Proxy so missing symbols return a zero-value object instead of undefined.
  // This prevents expressions like `quotes["RELIANCE"].lastPrice` from throwing when the
  // symbol's quote wasn't fetched (e.g. due to a partial Dhan API failure).
  const safeQuotes = new Proxy(snapshot.quotes, {
    get(target, prop: string) {
      return target[prop] ?? SAFE_QUOTE;
    },
  });

  for (const trigger of triggers) {
    const cond = trigger.condition as CodeCondition;
    try {
      const result = vm.runInNewContext(
        cond.expression,
        {
          quotes: safeQuotes,
          positions: snapshot.positions,
          funds: snapshot.funds,
          nifty50: snapshot.nifty50,
          banknifty: snapshot.banknifty,
        },
        { timeout: 500 }
      );
      if (result === true) fired.push(trigger.id);
    } catch (err) {
      console.warn(`[heartbeat] code eval error for trigger ${trigger.id}:`, err instanceof Error ? err.message : err);
    }
  }
  return fired;
}

export async function evaluateLlmTriggers(snapshot: SystemSnapshot, triggers: Trigger[]): Promise<string[]> {
  if (triggers.length === 0) return [];

  const compactSnapshot = {
    capturedAt: snapshot.capturedAt,
    marketStatus: snapshot.marketStatus,
    nifty50: snapshot.nifty50 ? { lp: snapshot.nifty50.lastPrice, chg: snapshot.nifty50.changePercent } : null,
    banknifty: snapshot.banknifty ? { lp: snapshot.banknifty.lastPrice, chg: snapshot.banknifty.changePercent } : null,
    quotes: Object.fromEntries(
      Object.entries(snapshot.quotes).map(([k, v]) => [k, { lp: v.lastPrice, chg: v.changePercent }])
    ),
    positions: snapshot.positions.map(p => ({ sym: p.symbol, qty: p.quantity, pnl: p.pnlPercent })),
    funds: snapshot.funds,
  };

  const triggerList = triggers.map(t => ({
    id: t.id,
    description: (t.condition as LlmCondition).description,
  }));

  try {
    const resp = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      system: "Return ONLY a JSON array of trigger IDs whose conditions are currently met based on the market snapshot. Return [] if none. No markdown, no explanation.",
      messages: [
        {
          role: "user",
          content: `Snapshot:\n${JSON.stringify(compactSnapshot)}\n\nTriggers:\n${JSON.stringify(triggerList)}`,
        },
      ],
    });

    const text = resp.content[0]?.type === "text" ? resp.content[0].text.trim() : "[]";
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return [];
    const knownIds = new Set(triggers.map(t => t.id));
    return (parsed as string[]).filter(id => knownIds.has(id));
  } catch (err) {
    console.error("[heartbeat] LLM eval error:", err);
    return [];
  }
}
