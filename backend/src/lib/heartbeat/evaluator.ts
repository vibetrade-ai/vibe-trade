import vm from "vm";
import Anthropic from "@anthropic-ai/sdk";
import type { Trigger, SystemSnapshot } from "./types.js";

type CodeCondition = { mode: "code"; expression: string };
type LlmCondition  = { mode: "llm"; description: string };

const anthropic = new Anthropic();

export function evaluateCodeTriggers(snapshot: SystemSnapshot, triggers: Trigger[]): string[] {
  const fired: string[] = [];
  for (const trigger of triggers) {
    const cond = trigger.condition as CodeCondition;
    try {
      const result = vm.runInNewContext(
        cond.expression,
        {
          quotes: snapshot.quotes,
          positions: snapshot.positions,
          funds: snapshot.funds,
          nifty50: snapshot.nifty50,
          banknifty: snapshot.banknifty,
        },
        { timeout: 500 }
      );
      if (result === true) fired.push(trigger.id);
    } catch (err) {
      console.error(`[heartbeat] code eval error for trigger ${trigger.id}:`, err);
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
