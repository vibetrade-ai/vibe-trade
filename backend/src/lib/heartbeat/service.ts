import { randomUUID } from "crypto";
import type { BrokerAdapter } from "../brokers/types.js";
import type { TriggerStore, ApprovalStore, TriggerAuditStore, MemoryStore, StrategyStore, TradeStore, PortfolioStore } from "../storage/index.js";
import { computeDeployedCapital } from "../trade-utils.js";
import { buildSnapshot } from "./snapshot.js";
import { evaluateCodeTriggers, evaluateLlmTriggers, evaluateTimeTriggers } from "./evaluator.js";
import { evaluateEventTriggers } from "./event-evaluator.js";
import { runReasoningJob } from "./runner.js";
import { getSecurityId } from "../brokers/dhan/instruments.js";
import { getMarketStatus } from "../market-calendar.js";
import { syncOrders } from "../brokers/dhan/order-sync.js";
import { fetchNews } from "../news.js";
import { getFundamentals, getVixQuote } from "../yahoo.js";
import { computeNextRunAt, computeNextTradingRunAt, evaluateCronTriggers } from "./cron-utils.js";
import type { PositionEntry, Trigger, EventDelta, EventCondition } from "./types.js";
import type { Fundamentals } from "../yahoo.js";

export class HeartbeatService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private activeJobs = 0;
  private previousPositions: PositionEntry[] = [];
  private fundamentalsCache = new Map<string, { data: Fundamentals; cachedAt: number }>();
  private seenHeadlineLinks = new Set<string>();

  constructor(
    private broker: BrokerAdapter,
    private readonly triggers: TriggerStore,
    private readonly approvals: ApprovalStore,
    private readonly triggerAudit: TriggerAuditStore,
    private readonly memory: MemoryStore,
    private readonly intervalMs: number = 60_000,
    private readonly strategyStore?: StrategyStore,
    private readonly tradeStore?: TradeStore,
    private readonly portfolioStore?: PortfolioStore,
  ) {}

  setBrokerAdapter(adapter: BrokerAdapter): void {
    this.broker = adapter;
  }

  // Backward compat alias
  setDhanClient(adapter: BrokerAdapter): void {
    this.broker = adapter;
  }

  start(): void {
    if (this.timer) return;
    console.log("[heartbeat] started");
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    // Run an initial tick shortly after start
    setTimeout(() => { void this.tick(); }, 5000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log("[heartbeat] stopped");
  }

  private async buildEventDelta(
    snapshot: import("./types.js").SystemSnapshot,
    eventTriggers: Trigger[],
  ): Promise<EventDelta> {
    const prevSymbols = new Set(this.previousPositions.map(p => p.symbol));
    const currSymbols = new Set(snapshot.positions.map(p => p.symbol));
    const newPositions     = snapshot.positions.filter(p => !prevSymbols.has(p.symbol));
    const closedPositions  = this.previousPositions.filter(p => !currSymbols.has(p.symbol));

    // Collect categories needed by news-related event triggers
    const neededCategories = new Set<string>();
    for (const t of eventTriggers) {
      const cond = t.condition as EventCondition;
      if (cond.kind === "news_mention" || cond.kind === "sentiment_negative" || cond.kind === "sentiment_positive") {
        for (const cat of cond.categories) neededCategories.add(cat);
      }
    }

    // Fetch RSS for needed categories, filter against seen links
    const newHeadlines: Record<string, import("../news.js").NewsItem[]> = {};
    for (const cat of neededCategories) {
      try {
        const items = await fetchNews(cat as any, 20);
        const fresh = items.filter(item => {
          if (this.seenHeadlineLinks.has(item.link)) return false;
          this.seenHeadlineLinks.add(item.link);
          return true;
        });
        if (fresh.length > 0) newHeadlines[cat] = fresh;
      } catch (err) {
        console.warn(`[heartbeat] news fetch error for category "${cat}":`, err instanceof Error ? err.message : err);
      }
    }

    // Collect symbols needing fundamentals refresh (pe_below, fundamentals_changed)
    const neededFundSymbols = new Set<string>();
    for (const t of eventTriggers) {
      const cond = t.condition as EventCondition;
      if (cond.kind === "pe_below" || cond.kind === "pe_above" || cond.kind === "fundamentals_changed") {
        neededFundSymbols.add(cond.symbol.toUpperCase());
      }
    }

    const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
    const now = Date.now();
    const fundamentals: Record<string, Fundamentals | null> = {};
    for (const sym of neededFundSymbols) {
      const cached = this.fundamentalsCache.get(sym);
      if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
        fundamentals[sym] = cached.data;
      } else {
        try {
          const data = await getFundamentals(sym);
          this.fundamentalsCache.set(sym, { data, cachedAt: now });
          fundamentals[sym] = data;
        } catch (err) {
          console.warn(`[heartbeat] fundamentals fetch error for "${sym}":`, err instanceof Error ? err.message : err);
          fundamentals[sym] = null;
        }
      }
    }

    // Fetch VIX only if a vix_above trigger is active
    const needsVix = eventTriggers.some(t => {
      const kind = (t.condition as EventCondition).kind;
      return kind === "vix_above" || kind === "vix_below";
    });
    let vixQuote: EventDelta["vixQuote"] = null;
    if (needsVix) {
      try {
        const v = await getVixQuote();
        if (v) {
          vixQuote = {
            symbol: v.symbol,
            securityId: "",
            lastPrice: v.lastPrice,
            previousClose: 0,
            changePercent: 0,
            open: 0,
            high: 0,
            low: 0,
          };
        }
      } catch (err) {
        console.warn("[heartbeat] VIX fetch error:", err instanceof Error ? err.message : err);
      }
    }

    return { newPositions, closedPositions, newHeadlines, fundamentals, vixQuote };
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      console.log("[heartbeat] tick");

      await this.approvals.pruneExpired();
      await this.triggers.pruneExpired();

      const activeTriggers = await this.triggers.list({ status: ["active", "paused"] });
      const activeOnly = activeTriggers.filter(t => t.status === "active");

      if (activeOnly.length === 0) {
        console.log("[heartbeat] no active triggers, skipping snapshot");
        return;
      }

      const now = new Date();
      const timeTriggers  = activeOnly.filter(t => t.condition.mode === "time");
      const codeTriggers  = activeOnly.filter(t => t.condition.mode === "code");
      const llmTriggers   = activeOnly.filter(t => t.condition.mode === "llm");
      const eventTriggers = activeOnly.filter(t => t.condition.mode === "event");

      // Split time triggers: one-shot (at/fireAt) vs cron
      const oneShotTimeTriggers = timeTriggers.filter(t => !(t.condition as { mode: "time"; cron?: string }).cron);
      const cronTimeTriggers    = timeTriggers.filter(t => !!(t.condition as { mode: "time"; cron?: string }).cron);

      const oneShotFired = evaluateTimeTriggers(oneShotTimeTriggers);

      // Evaluate cron triggers
      const { fired: cronFired, stale: cronStale } = evaluateCronTriggers(cronTimeTriggers, now);

      // Advance stale cron triggers without firing
      for (const id of cronStale) {
        const trigger = activeOnly.find(t => t.id === id);
        if (!trigger) continue;
        const cron = (trigger.condition as { mode: "time"; cron: string }).cron;
        const tradingDaysOnly = trigger.tradingDaysOnly ?? false;
        const nextFireAt = tradingDaysOnly
          ? computeNextTradingRunAt(cron, now)
          : computeNextRunAt(cron, now);
        await this.triggers.updateNextFireAt(id, nextFireAt, undefined);
        console.log(`[heartbeat] skipping stale cron trigger "${trigger.name}", next: ${nextFireAt}`);
      }

      let codeFired: string[] = [];
      let llmFired: string[] = [];
      let eventFired: string[] = [];
      let snapshot: import("./types.js").SystemSnapshot | null = null;

      const marketStatus = getMarketStatus();
      const isMarketActive = marketStatus.session === "pre_market"
        || marketStatus.session === "open"
        || marketStatus.session === "post_market";

      if (codeTriggers.length > 0 || llmTriggers.length > 0 || eventTriggers.length > 0) {
        if (!isMarketActive) {
          console.log(`[heartbeat] market ${marketStatus.session} — skipping ${codeTriggers.length + llmTriggers.length + eventTriggers.length} code/llm/event trigger(s) until ${marketStatus.next_open}`);
        } else {
          snapshot = await buildSnapshot(this.broker, activeOnly);
          const delta = await this.buildEventDelta(snapshot, eventTriggers);
          [codeFired, llmFired, eventFired] = await Promise.all([
            Promise.resolve(evaluateCodeTriggers(snapshot, codeTriggers, delta)),
            evaluateLlmTriggers(snapshot, llmTriggers),
            evaluateEventTriggers(snapshot, delta, eventTriggers),
          ]);
          // Update previous positions after tick
          this.previousPositions = snapshot.positions;
        }
      }

      const firedIds = [...new Set([...oneShotFired, ...cronFired, ...codeFired, ...llmFired, ...eventFired])];

      if (firedIds.length > 0) {
        console.log(`[heartbeat] fired: ${firedIds.join(", ")}`);
      }

      const hasReasoningJob = firedIds.some(id =>
        activeOnly.find(t => t.id === id)?.action.type === "reasoning_job"
      );
      if (hasReasoningJob && this.tradeStore) {
        const r = await syncOrders(this.broker, this.tradeStore);
        if (r.fillsUpdated + r.rejectedOrCancelled > 0) {
          console.log(`[heartbeat] order-sync: ${r.fillsUpdated} filled, ${r.rejectedOrCancelled} rejected/cancelled`);
        }
      }

      for (const id of firedIds) {
        const trigger = activeOnly.find(t => t.id === id);
        if (!trigger) continue;

        const nowIso = new Date().toISOString();

        // If snapshot is null (only time triggers fired), build minimal snapshot
        if (!snapshot) {
          snapshot = await buildSnapshot(this.broker, []);
        }

        if (trigger.action.type === "hard_order") {
          // Capital enforcement: reject if portfolio allocation would be exceeded
          if (trigger.portfolioId && this.portfolioStore && this.tradeStore) {
            const portfolio = await this.portfolioStore.get(trigger.portfolioId).catch(() => null);
            if (portfolio) {
              const filledTrades = await this.tradeStore.list({ portfolioId: portfolio.id, status: "filled" });
              const deployed = computeDeployedCapital(filledTrades);
              const tradeArgs = trigger.action.tradeArgs;
              let price = tradeArgs.price;
              if (!price) {
                try {
                  const quotes = await this.broker.getQuote([tradeArgs.symbol]);
                  price = Object.values(quotes)[0]?.lastPrice;
                } catch { /* ignore */ }
              }
              const tradeCost = tradeArgs.quantity * (price ?? 0);
              if (price && deployed + tradeCost > portfolio.allocation) {
                const shortfall = +(deployed + tradeCost - portfolio.allocation).toFixed(2);
                const reason = `Capital limit exceeded for portfolio "${portfolio.name}": deployed ₹${deployed.toFixed(2)} + trade ₹${tradeCost.toFixed(2)} > allocation ₹${portfolio.allocation}. Shortfall: ₹${shortfall}.`;
                console.warn(`[heartbeat] hard_order blocked: ${reason}`);
                await this.triggerAudit.append({
                  id: randomUUID(), triggerId: trigger.id, triggerName: trigger.name,
                  firedAt: nowIso, snapshotAtFire: snapshot, action: trigger.action,
                  outcome: { type: "hard_order_failed", error: reason },
                  portfolioId: trigger.portfolioId,
                });
                continue;
              }
            }
          }

          // Mark as fired immediately (hard orders are always one-shot)
          await this.triggers.setStatus(trigger.id, "fired", { firedAt: nowIso });
          try {
            const tradeArgs = trigger.action.tradeArgs;
            const securityId = await getSecurityId(tradeArgs.symbol).catch(() => tradeArgs.symbol);
            const orderResult = await this.broker.placeOrder({
              symbol: tradeArgs.symbol,
              side: tradeArgs.transaction_type,
              quantity: tradeArgs.quantity,
              orderType: tradeArgs.order_type,
              productType: "INTRADAY",
              price: tradeArgs.price,
            });
            const orderId = orderResult.orderId ?? randomUUID();
            await this.triggers.setStatus(trigger.id, "fired", { firedAt: nowIso, outcomeId: orderId });
            await this.triggerAudit.append({
              id: randomUUID(), triggerId: trigger.id, triggerName: trigger.name,
              firedAt: nowIso, snapshotAtFire: snapshot, action: trigger.action,
              outcome: { type: "hard_order_placed", orderId },
            });
            if (this.tradeStore) {
              await this.tradeStore.append({
                id: randomUUID(),
                orderId,
                symbol: tradeArgs.symbol.toUpperCase(),
                securityId,
                transactionType: tradeArgs.transaction_type,
                quantity: tradeArgs.quantity,
                orderType: tradeArgs.order_type,
                requestedPrice: tradeArgs.price,
                status: "pending",
                strategyId: trigger.strategyId,
                portfolioId: trigger.portfolioId,
                note: `Auto-placed by trigger: ${trigger.name}`,
                createdAt: nowIso,
              });
            }
            console.log(`[heartbeat] hard_order placed: ${orderId} for trigger ${trigger.id}`);
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            await this.triggerAudit.append({
              id: randomUUID(), triggerId: trigger.id, triggerName: trigger.name,
              firedAt: nowIso, snapshotAtFire: snapshot, action: trigger.action,
              outcome: { type: "hard_order_failed", error },
            });
            console.error(`[heartbeat] hard_order failed for trigger ${trigger.id}:`, err);
          }
        } else {
          // reasoning_job
          if (this.activeJobs >= 3) {
            console.warn(`[heartbeat] max concurrent jobs reached, skipping trigger ${trigger.id}`);
            continue;
          }

          const isCronTrigger = !!(trigger.condition as { mode: "time"; cron?: string }).cron;
          const isRecurring = trigger.recurring === true;

          if (isCronTrigger) {
            // Cron triggers: stay active, update nextFireAt before launching
            const cron = (trigger.condition as { mode: "time"; cron: string }).cron;
            const tradingDaysOnly = trigger.tradingDaysOnly ?? false;
            const nextFireAt = tradingDaysOnly
              ? computeNextTradingRunAt(cron, now)
              : computeNextRunAt(cron, now);
            await this.triggers.updateNextFireAt(trigger.id, nextFireAt, nowIso);
            console.log(`[heartbeat] cron trigger "${trigger.name}" fired, next: ${nextFireAt}`);
          } else if (isRecurring && trigger.cooldownMs) {
            // Recurring code/llm/event: check cooldown
            if (trigger.lastFiredAt) {
              const elapsed = Date.now() - new Date(trigger.lastFiredAt).getTime();
              if (elapsed < trigger.cooldownMs) {
                console.log(`[heartbeat] recurring trigger "${trigger.name}" in cooldown, skipping`);
                continue;
              }
            }
            // Re-arm: update lastFiredAt, keep active
            await this.triggers.setStatus(trigger.id, "active", { lastFiredAt: nowIso });
          } else {
            // One-shot: mark as fired
            await this.triggers.setStatus(trigger.id, "fired", { firedAt: nowIso });
          }

          this.activeJobs++;
          console.log(`[heartbeat] reasoning job started for trigger ${trigger.id}`);
          runReasoningJob(trigger, snapshot, this.broker, this.triggers, this.approvals, this.triggerAudit, this.memory, this.strategyStore, this.portfolioStore, this.tradeStore)
            .catch(async err => {
              const error = err instanceof Error ? err.message : String(err);
              console.error(`[heartbeat] reasoning job error for ${trigger.id}:`, err);
              await this.triggerAudit.append({
                id: randomUUID(), triggerId: trigger.id, triggerName: trigger.name,
                firedAt: nowIso, snapshotAtFire: snapshot!, action: trigger.action,
                outcome: { type: "reasoning_job_no_action", reason: `Job threw an error: ${error}` },
              }).catch(() => {});
            })
            .finally(() => { this.activeJobs--; });
        }
      }
    } catch (err) {
      console.error("[heartbeat] tick error:", err);
    } finally {
      this.ticking = false;
    }
  }
}
