"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ── Types ──────────────────────────────────────────────────────────────────────

type ScheduleStatus = "active" | "paused" | "deleted";

interface Schedule {
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

type ScheduleRunOutcome =
  | { type: "completed"; summary: string; approvalIds: string[] }
  | { type: "no_action"; reason: string }
  | { type: "error"; message: string };

interface ScheduleRun {
  id: string;
  scheduleId: string;
  scheduleName: string;
  startedAt: string;
  completedAt: string;
  outcome: ScheduleRunOutcome;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:3001";
const POLL_INTERVAL_MS = 30_000;

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatTs(iso: string) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

// ── Empty state ────────────────────────────────────────────────────────────────

function EmptyState({ message, sub }: { message: string; sub: string }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-20 space-y-2 px-6">
      <div className="w-12 h-12 rounded-full bg-gray-800 flex items-center justify-center mb-2">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="w-6 h-6 text-gray-600"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 6v6l4 2m6-2a10 10 0 11-20 0 10 10 0 0120 0z"
          />
        </svg>
      </div>
      <p className="text-gray-300 font-medium text-sm">{message}</p>
      <p className="text-gray-600 text-xs max-w-xs">{sub}</p>
    </div>
  );
}

// ── Schedule Card ──────────────────────────────────────────────────────────────

function ScheduleCard({ schedule, onRefresh }: { schedule: Schedule; onRefresh: () => void }) {
  const [loading, setLoading] = useState(false);

  const handlePause = async () => {
    setLoading(true);
    try {
      await fetch(`${BACKEND_URL}/api/schedules/${schedule.id}/pause`, { method: "POST" });
      onRefresh();
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  const handleResume = async () => {
    setLoading(true);
    try {
      await fetch(`${BACKEND_URL}/api/schedules/${schedule.id}/resume`, { method: "POST" });
      onRefresh();
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Delete schedule "${schedule.name}"?`)) return;
    setLoading(true);
    try {
      await fetch(`${BACKEND_URL}/api/schedules/${schedule.id}`, { method: "DELETE" });
      onRefresh();
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-xl border border-gray-700 bg-gray-800/60 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1 min-w-0">
          <p className="text-sm font-semibold text-white truncate">{schedule.name}</p>
          <p className="text-xs text-gray-400 line-clamp-2">{schedule.description}</p>
        </div>
        <span
          className={`flex-shrink-0 w-2 h-2 rounded-full mt-1.5 ${
            schedule.status === "active" ? "bg-green-400" : "bg-yellow-500"
          }`}
          title={schedule.status}
        />
      </div>

      {/* Cron + trading days */}
      <div className="flex flex-wrap gap-2 items-center">
        <span className="px-2 py-0.5 rounded bg-gray-700/60 text-gray-300 text-xs font-mono border border-gray-600/50">
          {schedule.cronExpression}
        </span>
        {schedule.tradingDaysOnly && (
          <span className="px-1.5 py-0.5 rounded text-xs bg-blue-900/40 text-blue-300 border border-blue-800/40">
            trading days only
          </span>
        )}
      </div>

      {/* Next / Last run */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <p className="text-gray-500 mb-0.5">Next run</p>
          <p className="text-gray-300">{formatTs(schedule.nextRunAt)}</p>
        </div>
        {schedule.lastRunAt && (
          <div>
            <p className="text-gray-500 mb-0.5">Last run</p>
            <p className="text-gray-300">{formatTs(schedule.lastRunAt)}</p>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-2 pt-1">
        {schedule.status === "active" ? (
          <button
            onClick={handlePause}
            disabled={loading}
            className="px-3 py-1.5 rounded-lg bg-yellow-900/30 text-yellow-300 border border-yellow-800/40 text-xs font-medium hover:bg-yellow-900/50 disabled:opacity-50 transition-colors"
          >
            Pause
          </button>
        ) : (
          <button
            onClick={handleResume}
            disabled={loading}
            className="px-3 py-1.5 rounded-lg bg-green-900/30 text-green-300 border border-green-800/40 text-xs font-medium hover:bg-green-900/50 disabled:opacity-50 transition-colors"
          >
            Resume
          </button>
        )}
        <button
          onClick={handleDelete}
          disabled={loading}
          className="px-3 py-1.5 rounded-lg bg-red-900/30 text-red-400 border border-red-800/40 text-xs font-medium hover:bg-red-900/50 disabled:opacity-50 transition-colors"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

// ── Run History Row ────────────────────────────────────────────────────────────

function RunRow({ run }: { run: ScheduleRun }) {
  const outcomeConfig = () => {
    switch (run.outcome.type) {
      case "completed":
        return {
          label:
            run.outcome.approvalIds.length > 0
              ? `${run.outcome.approvalIds.length} approval(s) queued`
              : run.outcome.summary,
          dot: "bg-green-400",
          className: "text-green-400",
        };
      case "no_action":
        return { label: `No action: ${run.outcome.reason}`, dot: "bg-gray-500", className: "text-gray-400" };
      case "error":
        return { label: `Error: ${run.outcome.message}`, dot: "bg-red-400", className: "text-red-400" };
    }
  };
  const oc = outcomeConfig();

  return (
    <div className="flex items-start gap-3 py-3 border-b border-gray-800 last:border-0">
      <span className={`w-2 h-2 rounded-full flex-shrink-0 mt-1.5 ${oc.dot}`} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-white font-medium truncate">{run.scheduleName}</p>
          <span className="text-xs text-gray-600 flex-shrink-0">{formatTs(run.startedAt)}</span>
        </div>
        <p className={`text-xs ${oc.className}`}>{oc.label}</p>
        {run.outcome.type === "completed" && run.outcome.approvalIds.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-0.5">
            {run.outcome.approvalIds.map((id) => (
              <span key={id} className="px-1.5 py-0.5 rounded bg-gray-700/60 text-gray-400 text-xs font-mono">
                {id.slice(0, 8)}…
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── SchedulesPanel ─────────────────────────────────────────────────────────────

export function SchedulesPanel() {
  const [subTab, setSubTab] = useState<"active" | "history">("active");
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [runs, setRuns] = useState<ScheduleRun[]>([]);
  const [loadingSchedules, setLoadingSchedules] = useState(true);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchSchedules = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/schedules`);
      if (!res.ok) return;
      setSchedules((await res.json()) as Schedule[]);
    } catch {
      // ignore
    } finally {
      setLoadingSchedules(false);
    }
  }, []);

  const fetchRuns = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/schedules/runs`);
      if (!res.ok) return;
      setRuns((await res.json()) as ScheduleRun[]);
    } catch {
      // ignore
    } finally {
      setLoadingRuns(false);
    }
  }, []);

  useEffect(() => {
    fetchSchedules();
    fetchRuns();
    intervalRef.current = setInterval(() => {
      fetchSchedules();
      fetchRuns();
    }, POLL_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchSchedules, fetchRuns]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Sub-tab bar */}
      <div className="flex border-b border-gray-800 px-4 flex-shrink-0">
        {(["active", "history"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setSubTab(tab)}
            className={`px-4 py-2.5 text-sm font-medium transition-colors capitalize ${
              subTab === tab
                ? "border-b-2 border-blue-500 text-white -mb-px"
                : "text-gray-400 hover:text-gray-300"
            }`}
          >
            {tab === "active" ? "Active" : "Run History"}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {subTab === "active" && (
          <>
            {loadingSchedules ? (
              <div className="p-4 space-y-3">
                {[1, 2].map((i) => (
                  <div
                    key={i}
                    className="rounded-xl border border-gray-700 bg-gray-800/40 p-4 h-40 animate-pulse"
                  />
                ))}
              </div>
            ) : schedules.length === 0 ? (
              <EmptyState
                message="No schedules yet"
                sub='Ask Claude to set up a repeating schedule — e.g. "Run a premarket scan every market day at 9:15am"'
              />
            ) : (
              <div className="p-4 space-y-3">
                {schedules.map((s) => (
                  <ScheduleCard key={s.id} schedule={s} onRefresh={fetchSchedules} />
                ))}
              </div>
            )}
          </>
        )}

        {subTab === "history" && (
          <>
            {loadingRuns ? (
              <div className="p-4 space-y-2">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-14 bg-gray-800/40 rounded-lg animate-pulse" />
                ))}
              </div>
            ) : runs.length === 0 ? (
              <EmptyState
                message="No run history yet"
                sub="Schedule runs and their outcomes will appear here."
              />
            ) : (
              <div className="px-4 pt-2">
                {runs.map((r) => (
                  <RunRow key={r.id} run={r} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
