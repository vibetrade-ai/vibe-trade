"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getBackendHttpUrl } from "@/lib/backend-url";

// ── Types ──────────────────────────────────────────────────────────────────────

type TriggerStatus = "active" | "fired" | "expired" | "cancelled" | "paused";

interface TriggerCondition {
  mode: "code" | "llm" | "time" | "event";
  expression?: string;
  description?: string;
  at?: string;
  cron?: string;
  fireAt?: string;
}

interface TradeArgs {
  symbol: string;
  transaction_type: "BUY" | "SELL";
  quantity: number;
  order_type: "MARKET" | "LIMIT";
  price?: number;
}

interface Trigger {
  id: string;
  name: string;
  scope: string;
  watchSymbols: string[];
  condition: TriggerCondition;
  action: { type: "reasoning_job"; prompt?: string } | { type: "hard_order"; tradeArgs: TradeArgs };
  expiresAt?: string;
  createdAt: string;
  active: boolean;
  status: TriggerStatus;
  firedAt?: string;
  outcomeId?: string;
  strategyId?: string;
  tradingDaysOnly?: boolean;
  nextFireAt?: string;
  lastFiredAt?: string;
}

interface Strategy {
  id: string;
  name: string;
}

interface TriggerAuditEntry {
  id: string;
  triggerId: string;
  triggerName: string;
  firedAt: string;
  action: { type: "reasoning_job" } | { type: "hard_order"; tradeArgs: TradeArgs };
  outcome:
    | { type: "hard_order_placed"; orderId: string }
    | { type: "hard_order_failed"; error: string }
    | { type: "reasoning_job_queued"; approvalId?: string }
    | { type: "reasoning_job_no_action"; reason: string }
    | { type: "reasoning_job_completed"; summary: string; approvalIds: string[]; durationMs: number };
}

// ── Constants ──────────────────────────────────────────────────────────────────

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

function ScopeBadge({ scope }: { scope: string }) {
  return (
    <span className="px-1.5 py-0.5 rounded text-xs bg-[#4DFF4D]/10 text-[#4DFF4D] border border-[#4DFF4D]/30 font-mono">
      {scope}
    </span>
  );
}

function StrategyTag({ name }: { name: string }) {
  return (
    <span className="px-1.5 py-0.5 rounded text-xs bg-violet-900/40 text-violet-300 border border-violet-800/40 flex items-center gap-1">
      <span className="opacity-60">↗</span>{name}
    </span>
  );
}

function ActionTypeBadge({ type }: { type: string }) {
  const isHard = type === "hard_order";
  return (
    <span
      className={`px-1.5 py-0.5 rounded text-xs font-medium ${
        isHard
          ? "bg-amber-900/40 text-amber-300 border border-amber-800/40"
          : "bg-purple-900/40 text-purple-300 border border-purple-800/40"
      }`}
    >
      {isHard ? "Hard Order" : "Reasoning Job"}
    </span>
  );
}

function CronBadge({ cron }: { cron: string }) {
  return (
    <span className="px-2 py-0.5 rounded bg-gray-700/60 text-gray-300 text-xs font-mono border border-gray-600/50">
      {cron}
    </span>
  );
}

// ── Active Triggers Tab ────────────────────────────────────────────────────────

function ActiveTriggerCard({
  trigger,
  strategyName,
  onRefresh,
}: {
  trigger: Trigger;
  strategyName?: string;
  onRefresh: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const isCron = trigger.condition.mode === "time" && !!trigger.condition.cron;
  const isPaused = trigger.status === "paused";

  const conditionLabel =
    trigger.condition.mode === "code"
      ? trigger.condition.expression
      : trigger.condition.mode === "llm"
      ? trigger.condition.description
      : trigger.condition.mode === "time"
      ? (trigger.condition.cron ?? trigger.condition.at ?? trigger.condition.fireAt)
      : undefined;

  const handlePause = async () => {
    setLoading(true);
    try {
      await fetch(`${getBackendHttpUrl()}/api/triggers/${trigger.id}/pause`, { method: "POST" });
      onRefresh();
    } catch { /* ignore */ } finally { setLoading(false); }
  };

  const handleResume = async () => {
    setLoading(true);
    try {
      await fetch(`${getBackendHttpUrl()}/api/triggers/${trigger.id}/resume`, { method: "POST" });
      onRefresh();
    } catch { /* ignore */ } finally { setLoading(false); }
  };

  const handleCancel = async () => {
    if (!confirm(`Cancel trigger "${trigger.name}"?`)) return;
    setLoading(true);
    try {
      await fetch(`${getBackendHttpUrl()}/api/triggers/${trigger.id}`, { method: "DELETE" });
      onRefresh();
    } catch { /* ignore */ } finally { setLoading(false); }
  };

  return (
    <div className="rounded-xl border border-gray-700 bg-gray-800/60 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1 min-w-0">
          <p className="text-sm font-semibold text-white truncate">{trigger.name}</p>
          <div className="flex flex-wrap gap-1.5 items-center">
            <ScopeBadge scope={trigger.scope} />
            <ActionTypeBadge type={trigger.action.type} />
            {isCron && (
              <span className="px-1.5 py-0.5 rounded text-xs bg-blue-900/40 text-blue-300 border border-blue-800/40">
                recurring
              </span>
            )}
            {trigger.tradingDaysOnly && (
              <span className="px-1.5 py-0.5 rounded text-xs bg-[#4DFF4D]/10 text-[#4DFF4D] border border-[#4DFF4D]/30">
                trading days only
              </span>
            )}
            {strategyName && <StrategyTag name={strategyName} />}
          </div>
        </div>
        <span
          className={`flex-shrink-0 w-2 h-2 rounded-full mt-1.5 ${isPaused ? "bg-yellow-500" : "bg-green-400"}`}
          title={trigger.status}
        />
      </div>

      {/* Watch symbols */}
      {trigger.watchSymbols.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {trigger.watchSymbols.map((sym) => (
            <span
              key={sym}
              className="px-2 py-0.5 rounded bg-gray-700/60 text-gray-300 text-xs font-mono border border-gray-600/50"
            >
              {sym}
            </span>
          ))}
        </div>
      )}

      {/* Condition */}
      {isCron ? (
        <div className="space-y-2">
          <CronBadge cron={trigger.condition.cron!} />
          <div className="grid grid-cols-2 gap-2 text-xs">
            {trigger.nextFireAt && (
              <div>
                <p className="text-gray-500 mb-0.5">Next fire</p>
                <p className="text-gray-300">{formatTs(trigger.nextFireAt)}</p>
              </div>
            )}
            {trigger.lastFiredAt && (
              <div>
                <p className="text-gray-500 mb-0.5">Last fired</p>
                <p className="text-gray-300">{formatTs(trigger.lastFiredAt)}</p>
              </div>
            )}
          </div>
        </div>
      ) : (
        conditionLabel && (
          <div className="bg-gray-900/60 rounded-lg px-3 py-2 border border-gray-800">
            <p className="text-xs text-gray-500 mb-0.5">
              {trigger.condition.mode === "code"
                ? "Code condition"
                : trigger.condition.mode === "llm"
                ? "LLM condition"
                : "Fire at"}
            </p>
            <p className="text-xs text-gray-300 font-mono leading-relaxed">{conditionLabel}</p>
          </div>
        )
      )}

      {/* Action detail for hard orders */}
      {trigger.action.type === "hard_order" && (
        <div className="flex items-center gap-3 text-xs">
          <span className="text-gray-500">Will place:</span>
          <span
            className={`font-bold ${
              trigger.action.tradeArgs.transaction_type === "BUY"
                ? "text-green-400"
                : "text-red-400"
            }`}
          >
            {trigger.action.tradeArgs.transaction_type}
          </span>
          <span className="text-gray-300">{trigger.action.tradeArgs.quantity}x</span>
          <span className="text-white font-mono">{trigger.action.tradeArgs.symbol}</span>
        </div>
      )}

      {/* Expiry (for non-cron) */}
      {!isCron && trigger.expiresAt && (
        <p className="text-xs text-gray-600">
          Expires: <span className="text-gray-500">{formatTs(trigger.expiresAt)}</span>
        </p>
      )}

      {/* Actions for cron triggers */}
      {isCron && (
        <div className="flex gap-2 pt-1">
          {isPaused ? (
            <button
              onClick={handleResume}
              disabled={loading}
              className="px-3 py-1.5 rounded-lg bg-green-900/30 text-green-300 border border-green-800/40 text-xs font-medium hover:bg-green-900/50 disabled:opacity-50 transition-colors"
            >
              Resume
            </button>
          ) : (
            <button
              onClick={handlePause}
              disabled={loading}
              className="px-3 py-1.5 rounded-lg bg-yellow-900/30 text-yellow-300 border border-yellow-800/40 text-xs font-medium hover:bg-yellow-900/50 disabled:opacity-50 transition-colors"
            >
              Pause
            </button>
          )}
          <button
            onClick={handleCancel}
            disabled={loading}
            className="px-3 py-1.5 rounded-lg bg-red-900/30 text-red-400 border border-red-800/40 text-xs font-medium hover:bg-red-900/50 disabled:opacity-50 transition-colors"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

// ── Audit entry ────────────────────────────────────────────────────────────────

function outcomeConfig(outcome: TriggerAuditEntry["outcome"] | undefined) {
  if (!outcome) {
    return { label: "Unknown outcome", className: "text-gray-500", dot: "bg-gray-600" };
  }
  switch (outcome.type) {
    case "hard_order_placed":
      return {
        label: `Order placed (${outcome.orderId})`,
        className: "text-green-400",
        dot: "bg-green-400",
      };
    case "hard_order_failed":
      return {
        label: `Failed: ${outcome.error}`,
        className: "text-red-400",
        dot: "bg-red-400",
      };
    case "reasoning_job_queued":
      return {
        label: outcome.approvalId
          ? `Queued — approval ${outcome.approvalId.slice(0, 8)}…`
          : "Reasoning queued",
        className: "text-[#4DFF4D]",
        dot: "bg-[#4DFF4D]",
      };
    case "reasoning_job_completed":
      return {
        label: outcome.approvalIds.length > 0
          ? `${outcome.approvalIds.length} approval(s) queued — ${outcome.summary}`
          : outcome.summary,
        className: "text-[#4DFF4D]",
        dot: "bg-[#4DFF4D]",
      };
    case "reasoning_job_no_action":
      return {
        label: `No action: ${outcome.reason}`,
        className: "text-gray-400",
        dot: "bg-gray-500",
      };
    default:
      return { label: "Unknown outcome", className: "text-gray-500", dot: "bg-gray-600" };
  }
}

function AuditEntryRow({ entry }: { entry: TriggerAuditEntry }) {
  const oc = outcomeConfig(entry.outcome);
  return (
    <div className="flex items-start gap-3 py-3 border-b border-gray-800 last:border-0">
      <span className={`w-2 h-2 rounded-full flex-shrink-0 mt-1.5 ${oc.dot}`} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-white font-medium truncate">{entry.triggerName}</p>
          <span className="text-xs text-gray-600 flex-shrink-0">{formatTs(entry.firedAt)}</span>
        </div>
        <div className="flex items-center gap-2">
          <ActionTypeBadge type={entry.action.type} />
          <span className={`text-xs ${oc.className}`}>{oc.label}</span>
        </div>
        {entry.outcome.type === "reasoning_job_completed" && entry.outcome.approvalIds.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-0.5">
            {entry.outcome.approvalIds.map((id) => (
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

// ── Empty states ───────────────────────────────────────────────────────────────

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

// ── TriggersPanel ──────────────────────────────────────────────────────────────

export function TriggersPanel() {
  const [subTab, setSubTab] = useState<"active" | "history">("active");
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [audit, setAudit] = useState<TriggerAuditEntry[]>([]);
  const [strategyMap, setStrategyMap] = useState<Record<string, string>>({});
  const [loadingTriggers, setLoadingTriggers] = useState(true);
  const [loadingAudit, setLoadingAudit] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchTriggers = useCallback(async () => {
    try {
      const [triggersRes, strategiesRes] = await Promise.all([
        fetch(`${getBackendHttpUrl()}/api/triggers`),
        fetch(`${getBackendHttpUrl()}/api/strategies`),
      ]);
      if (triggersRes.ok) setTriggers((await triggersRes.json()) as Trigger[]);
      if (strategiesRes.ok) {
        const strategies = (await strategiesRes.json()) as Strategy[];
        setStrategyMap(Object.fromEntries(strategies.map(s => [s.id, s.name])));
      }
    } catch {
      // ignore
    } finally {
      setLoadingTriggers(false);
    }
  }, []);

  const fetchAudit = useCallback(async () => {
    try {
      const res = await fetch(`${getBackendHttpUrl()}/api/triggers/audit`);
      if (!res.ok) return;
      const data = (await res.json()) as TriggerAuditEntry[];
      setAudit(data);
    } catch {
      // ignore
    } finally {
      setLoadingAudit(false);
    }
  }, []);

  useEffect(() => {
    fetchTriggers();
    fetchAudit();
    intervalRef.current = setInterval(() => {
      fetchTriggers();
      fetchAudit();
    }, POLL_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchTriggers, fetchAudit]);

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
                ? "border-b-2 border-[#4DFF4D] text-white -mb-px"
                : "text-gray-400 hover:text-gray-300"
            }`}
          >
            {tab === "active" ? "Active" : "History"}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {subTab === "active" && (
          <>
            {loadingTriggers ? (
              <div className="p-4 space-y-3">
                {[1, 2].map((i) => (
                  <div
                    key={i}
                    className="rounded-xl border border-gray-700 bg-gray-800/40 p-4 h-32 animate-pulse"
                  />
                ))}
              </div>
            ) : triggers.length === 0 ? (
              <EmptyState
                message="No active triggers"
                sub='Ask Claude to set up a trigger — e.g. "Monitor RELIANCE for a PE drop below 20" or "Run a premarket scan every market day at 9:15am"'
              />
            ) : (
              <div className="p-4 space-y-3">
                {triggers.map((t) => (
                  <ActiveTriggerCard
                    key={t.id}
                    trigger={t}
                    strategyName={t.strategyId ? strategyMap[t.strategyId] : undefined}
                    onRefresh={fetchTriggers}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {subTab === "history" && (
          <>
            {loadingAudit ? (
              <div className="p-4 space-y-2">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-14 bg-gray-800/40 rounded-lg animate-pulse" />
                ))}
              </div>
            ) : audit.length === 0 ? (
              <EmptyState
                message="No trigger history yet"
                sub="A log of all trigger firings and their outcomes will appear here."
              />
            ) : (
              <div className="px-4 pt-2">
                {audit.map((entry) => (
                  <AuditEntryRow key={entry.id} entry={entry} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
