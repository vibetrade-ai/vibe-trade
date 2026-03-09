import Anthropic from "@anthropic-ai/sdk";
import type { Trigger, SystemSnapshot, EventCondition, EventDelta } from "./types.js";

const anthropic = new Anthropic();

export async function evaluateEventTriggers(
  snapshot: SystemSnapshot,
  delta: EventDelta,
  triggers: Trigger[],
): Promise<string[]> {
  if (triggers.length === 0) return [];

  const fired: string[] = [];
  const sentimentTriggers: Array<{ trigger: Trigger; cond: EventCondition & { kind: "sentiment_positive" | "sentiment_negative" } }> = [];

  for (const trigger of triggers) {
    const cond = trigger.condition as EventCondition;

    switch (cond.kind) {
      case "position_opened": {
        const newSymbols = new Set(delta.newPositions.map(p => p.symbol.toUpperCase()));
        if (cond.symbols.some(s => newSymbols.has(s.toUpperCase()))) {
          fired.push(trigger.id);
        }
        break;
      }
      case "position_closed": {
        const closedSymbols = new Set(delta.closedPositions.map(p => p.symbol.toUpperCase()));
        if (cond.symbols.some(s => closedSymbols.has(s.toUpperCase()))) {
          fired.push(trigger.id);
        }
        break;
      }
      case "news_mention": {
        const watchUpper = cond.symbols.map(s => s.toUpperCase());
        let mentioned = false;
        for (const cat of cond.categories) {
          const items = delta.newHeadlines[cat] ?? [];
          if (items.some(item =>
            watchUpper.some(sym => item.title.toUpperCase().includes(sym))
          )) {
            mentioned = true;
            break;
          }
        }
        if (mentioned) fired.push(trigger.id);
        break;
      }
      case "sentiment_positive":
      case "sentiment_negative": {
        // Batch Haiku calls below
        sentimentTriggers.push({ trigger, cond });
        break;
      }
      case "pe_below": {
        const fund = delta.fundamentals[cond.symbol.toUpperCase()];
        if (fund?.pe_ratio != null && fund.pe_ratio < cond.threshold) {
          fired.push(trigger.id);
        }
        break;
      }
      case "pe_above": {
        const fund = delta.fundamentals[cond.symbol.toUpperCase()];
        if (fund?.pe_ratio != null && fund.pe_ratio > cond.threshold) {
          fired.push(trigger.id);
        }
        break;
      }
      case "fundamentals_changed": {
        if (delta.fundamentals[cond.symbol.toUpperCase()] != null) {
          fired.push(trigger.id);
        }
        break;
      }
      case "vix_above": {
        if (delta.vixQuote != null && delta.vixQuote.lastPrice > cond.threshold) {
          fired.push(trigger.id);
        }
        break;
      }
      case "vix_below": {
        if (delta.vixQuote != null && delta.vixQuote.lastPrice < cond.threshold) {
          fired.push(trigger.id);
        }
        break;
      }
      case "nifty_drop_percent": {
        if (snapshot.nifty50 != null && snapshot.nifty50.changePercent < -Math.abs(cond.threshold)) {
          fired.push(trigger.id);
        }
        break;
      }
      case "nifty_rise_percent": {
        if (snapshot.nifty50 != null && snapshot.nifty50.changePercent > Math.abs(cond.threshold)) {
          fired.push(trigger.id);
        }
        break;
      }
    }
  }

  // Batch sentiment evaluation via Haiku
  if (sentimentTriggers.length > 0) {
    // Collect all headlines relevant to these triggers
    const allHeadlines: Record<string, string[]> = {};
    for (const { cond } of sentimentTriggers) {
      for (const cat of cond.categories) {
        const items = delta.newHeadlines[cat] ?? [];
        if (items.length > 0) {
          allHeadlines[cat] = items.map(i => i.title);
        }
      }
    }
    const hasAnyHeadlines = Object.values(allHeadlines).some(arr => arr.length > 0);
    if (!hasAnyHeadlines) {
      // No new headlines — sentiment triggers can't fire
    } else {
      const triggerList = sentimentTriggers.map(({ trigger, cond }) => ({
        id: trigger.id,
        kind: cond.kind,
        symbols: cond.symbols,
        categories: cond.categories,
      }));

      try {
        const resp = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 256,
          system: "Return ONLY a JSON array of trigger IDs whose sentiment condition is met by the provided headlines. For sentiment_negative triggers, fire if the watched symbols have negative coverage. For sentiment_positive triggers, fire if the watched symbols have positive coverage. Return [] if none. No markdown, no explanation.",
          messages: [
            {
              role: "user",
              content: `Headlines by category:\n${JSON.stringify(allHeadlines)}\n\nTriggers:\n${JSON.stringify(triggerList)}`,
            },
          ],
        });

        const raw = resp.content[0]?.type === "text" ? resp.content[0].text.trim() : "[]";
        const text = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
        const parsed = JSON.parse(text) as unknown;
        if (Array.isArray(parsed)) {
          const knownIds = new Set(sentimentTriggers.map(({ trigger }) => trigger.id));
          for (const id of parsed as string[]) {
            if (knownIds.has(id)) fired.push(id);
          }
        }
      } catch (err) {
        console.error("[heartbeat] sentiment eval error:", err);
      }
    }
  }

  return fired;
}
