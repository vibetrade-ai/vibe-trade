export type ScheduleStatus = "active" | "paused" | "deleted";

export interface Schedule {
  id: string;
  name: string;
  description: string;
  cronExpression: string;
  tradingDaysOnly: boolean;
  prompt: string;
  status: ScheduleStatus;
  lastRunAt?: string;
  nextRunAt: string;
  createdAt: string;
}

export type ScheduleRunOutcome =
  | { type: "completed"; summary: string; approvalIds: string[] }
  | { type: "no_action"; reason: string }
  | { type: "error"; message: string };

export interface ScheduleRun {
  id: string;
  scheduleId: string;
  scheduleName: string;
  startedAt: string;
  completedAt: string;
  outcome: ScheduleRunOutcome;
}
