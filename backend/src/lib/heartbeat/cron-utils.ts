import { parseExpression } from "cron-parser";
import type { Trigger } from "./types.js";
import { isTradingDay } from "../market-calendar.js";

export function computeNextRunAt(cron: string, after = new Date()): string {
  return parseExpression(cron, { tz: "Asia/Kolkata", currentDate: after })
    .next().toISOString();
}

export function computeNextTradingRunAt(cron: string, after = new Date()): string {
  const interval = parseExpression(cron, { tz: "Asia/Kolkata", currentDate: after });
  while (true) {
    const candidate = interval.next().toDate();
    const dateStr = candidate.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    if (isTradingDay(dateStr).is_trading_day) return candidate.toISOString();
  }
}

/**
 * Returns IDs of cron triggers whose nextFireAt has passed (and are not stale).
 * Stale triggers (overdue beyond staleAfterMs threshold) are returned separately
 * so the caller can advance their nextFireAt without dispatching them.
 */
export function evaluateCronTriggers(
  triggers: Trigger[],
  now: Date,
): { fired: string[]; stale: string[] } {
  const nowIso = now.toISOString();
  const DEFAULT_STALE_MS = 5 * 60 * 1000;
  const MAX_STALE_MS = 2 * 60 * 60 * 1000;

  const fired: string[] = [];
  const stale: string[] = [];

  for (const t of triggers) {
    if (t.status !== "active") continue;
    const cond = t.condition as { mode: "time"; cron?: string };
    if (!cond.cron) continue;
    if (!t.nextFireAt) continue;
    if (t.nextFireAt > nowIso) continue;

    const staleAfterMs = Math.min(t.staleAfterMs ?? DEFAULT_STALE_MS, MAX_STALE_MS);
    const overdueMs = now.getTime() - new Date(t.nextFireAt).getTime();
    if (overdueMs > staleAfterMs) {
      stale.push(t.id);
    } else {
      fired.push(t.id);
    }
  }

  return { fired, stale };
}
