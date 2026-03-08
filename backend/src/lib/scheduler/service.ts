import { parseExpression } from "cron-parser";
import type { DhanClient } from "../dhan/client.js";
import type { ApprovalStore, MemoryStore, TriggerStore } from "../storage/index.js";
import type { ScheduleStore, ScheduleRunStore } from "./store.js";
import { isTradingDay } from "../market-calendar.js";
import { runScheduleJob } from "./runner.js";

function computeNextRunAt(cron: string, after = new Date()): string {
  return parseExpression(cron, { tz: "Asia/Kolkata", currentDate: after })
    .next().toISOString();
}

function computeNextTradingRunAt(cron: string, after = new Date()): string {
  const interval = parseExpression(cron, { tz: "Asia/Kolkata", currentDate: after });
  while (true) {
    const candidate = interval.next().toDate();
    const dateStr = candidate.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    if (isTradingDay(dateStr).is_trading_day) return candidate.toISOString();
  }
}

export { computeNextRunAt, computeNextTradingRunAt };

export class SchedulerService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private activeJobs = 0;

  constructor(
    private readonly dhan: DhanClient,
    private readonly scheduleStore: ScheduleStore,
    private readonly scheduleRunStore: ScheduleRunStore,
    private readonly triggerStore: TriggerStore,
    private readonly approvalStore: ApprovalStore,
    private readonly memory: MemoryStore,
    private readonly intervalMs: number = 60_000,
  ) {}

  start(): void {
    if (this.timer) return;
    console.log("[scheduler] started");
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    setTimeout(() => { void this.tick(); }, 5000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log("[scheduler] stopped");
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      console.log("[scheduler] tick");

      const now = new Date();
      const nowIso = now.toISOString();

      const activeSchedules = await this.scheduleStore.list({ status: "active" });
      const dueSchedules = activeSchedules.filter(s => s.nextRunAt <= nowIso);

      if (dueSchedules.length === 0) return;

      console.log(`[scheduler] due schedules: ${dueSchedules.map(s => s.name).join(", ")}`);

      for (const schedule of dueSchedules) {
        if (this.activeJobs >= 3) {
          console.warn(`[scheduler] max concurrent jobs reached, skipping schedule ${schedule.id}`);
          continue;
        }

        // Check trading day constraint
        if (schedule.tradingDaysOnly) {
          const todayStr = now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
          const { is_trading_day } = isTradingDay(todayStr);
          if (!is_trading_day) {
            // Advance nextRunAt without updating lastRunAt
            const nextRunAt = computeNextTradingRunAt(schedule.cronExpression, now);
            await this.scheduleStore.updateNextRunAt(schedule.id, nextRunAt);
            console.log(`[scheduler] skipping ${schedule.id} (non-trading day), next: ${nextRunAt}`);
            continue;
          }
        }

        const nextRunAt = schedule.tradingDaysOnly
          ? computeNextTradingRunAt(schedule.cronExpression, now)
          : computeNextRunAt(schedule.cronExpression, now);

        // Update lastRunAt + nextRunAt BEFORE launching (prevents double-fire on restart)
        await this.scheduleStore.updateLastRun(schedule.id, nowIso, nextRunAt);

        this.activeJobs++;
        console.log(`[scheduler] launching job for schedule ${schedule.id}: ${schedule.name}`);

        runScheduleJob(schedule, this.dhan, this.triggerStore, this.approvalStore, this.scheduleRunStore, this.memory)
          .catch(err => console.error(`[scheduler] job error for ${schedule.id}:`, err))
          .finally(() => { this.activeJobs--; });
      }
    } catch (err) {
      console.error("[scheduler] tick error:", err);
    } finally {
      this.ticking = false;
    }
  }
}
