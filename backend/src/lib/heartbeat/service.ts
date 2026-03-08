import { randomUUID } from "crypto";
import type { DhanClient } from "../dhan/client.js";
import type { TriggerStore, ApprovalStore, TriggerAuditStore, MemoryStore } from "../storage/index.js";
import { buildSnapshot } from "./snapshot.js";
import { evaluateCodeTriggers, evaluateLlmTriggers, evaluateTimeTriggers } from "./evaluator.js";
import { runReasoningJob } from "./runner.js";
import { getSecurityId } from "../dhan/instruments.js";
import { getMarketStatus } from "../market-calendar.js";

export class HeartbeatService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private activeJobs = 0;

  constructor(
    private readonly dhan: DhanClient,
    private readonly triggers: TriggerStore,
    private readonly approvals: ApprovalStore,
    private readonly triggerAudit: TriggerAuditStore,
    private readonly memory: MemoryStore,
    private readonly intervalMs: number = 60_000,
  ) {}

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

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      console.log("[heartbeat] tick");

      await this.approvals.pruneExpired();
      await this.triggers.pruneExpired();

      const activeTriggers = await this.triggers.list({ status: "active" });
      if (activeTriggers.length === 0) {
        console.log("[heartbeat] no active triggers, skipping snapshot");
        return;
      }

      const timeTriggers = activeTriggers.filter(t => t.condition.mode === "time");
      const codeTriggers = activeTriggers.filter(t => t.condition.mode === "code");
      const llmTriggers  = activeTriggers.filter(t => t.condition.mode === "llm");

      const timeFired = evaluateTimeTriggers(timeTriggers);

      let codeFired: string[] = [];
      let llmFired: string[] = [];
      let snapshot: import("./types.js").SystemSnapshot | null = null;

      const marketStatus = getMarketStatus();
      const isMarketActive = marketStatus.session === "pre_market"
        || marketStatus.session === "open"
        || marketStatus.session === "post_market";

      if (codeTriggers.length > 0 || llmTriggers.length > 0) {
        if (!isMarketActive) {
          console.log(`[heartbeat] market ${marketStatus.session} — skipping ${codeTriggers.length + llmTriggers.length} code/llm trigger(s) until ${marketStatus.next_open}`);
        } else {
          snapshot = await buildSnapshot(this.dhan, activeTriggers);
          [codeFired, llmFired] = await Promise.all([
            Promise.resolve(evaluateCodeTriggers(snapshot, codeTriggers)),
            evaluateLlmTriggers(snapshot, llmTriggers),
          ]);
        }
      }

      const firedIds = [...new Set([...timeFired, ...codeFired, ...llmFired])];

      if (firedIds.length > 0) {
        console.log(`[heartbeat] fired: ${firedIds.join(", ")}`);
      }

      for (const id of firedIds) {
        const trigger = activeTriggers.find(t => t.id === id);
        if (!trigger) continue;

        const now = new Date().toISOString();

        // If snapshot is null (only time triggers fired), build minimal snapshot
        if (!snapshot) {
          snapshot = await buildSnapshot(this.dhan, []);
        }

        if (trigger.action.type === "hard_order") {
          // Mark as fired immediately
          await this.triggers.setStatus(trigger.id, "fired", { firedAt: now });
          try {
            const tradeArgs = trigger.action.tradeArgs;
            const securityId = await getSecurityId(tradeArgs.symbol);
            const orderResult = await this.dhan.placeOrder({
              symbol: tradeArgs.symbol,
              securityId,
              transactionType: tradeArgs.transaction_type,
              quantity: tradeArgs.quantity,
              orderType: tradeArgs.order_type,
              price: tradeArgs.price,
            });
            const orderId = (orderResult as Record<string, unknown>)["orderId"] as string ?? randomUUID();
            await this.triggers.setStatus(trigger.id, "fired", { firedAt: now, outcomeId: orderId });
            await this.triggerAudit.append({
              id: randomUUID(), triggerId: trigger.id, triggerName: trigger.name,
              firedAt: now, snapshotAtFire: snapshot, action: trigger.action,
              outcome: { type: "hard_order_placed", orderId },
            });
            console.log(`[heartbeat] hard_order placed: ${orderId} for trigger ${trigger.id}`);
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            await this.triggerAudit.append({
              id: randomUUID(), triggerId: trigger.id, triggerName: trigger.name,
              firedAt: now, snapshotAtFire: snapshot, action: trigger.action,
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
          await this.triggers.setStatus(trigger.id, "fired", { firedAt: now });
          this.activeJobs++;
          console.log(`[heartbeat] reasoning job started for trigger ${trigger.id}`);
          runReasoningJob(trigger, snapshot, this.dhan, this.triggers, this.approvals, this.triggerAudit, this.memory)
            .catch(err => console.error(`[heartbeat] reasoning job error for ${trigger.id}:`, err))
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
