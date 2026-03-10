"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getBackendHttpUrl } from "@/lib/backend-url";

// ── Types ──────────────────────────────────────────────────────────────────────

type TriggerStatus = "active" | "fired" | "expired" | "cancelled";

interface TriggerCondition {
  mode: "code" | "llm";
  expression?: string;
  description?: string;
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
  action: { type: "reasoning_job" } | { type: "hard_order"; tradeArgs: TradeArgs };
  expiresAt?: string;
  createdAt: string;
  active: boolean;
  status: TriggerStatus;
  firedAt?: string;
  outcomeId?: string;
  strategyId?: string;
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
    | { type: "reasoning_job_no_action"; reason: string };
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
    <span className="px-1.5 py-0.5 rounded text-xs bg-blue-900/40 text-blue-300 border border-blue-800/40 font-mono">
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

// ── Active Triggers Tab ────────────────────────────────────────────────────────

function ActiveTriggerCard({ trigger, strategyName }: { trigger: Trigger; strategyName?: string }) {
  const conditionLabel =
    trigger.condition.mode === "code"
      ? trigger.condition.expression
      : trigger.condition.description;

  return (
    <div className="rounded-xl border border-gray-700 bg-gray-800/60 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1 min-w-0">
          <p className="text-sm font-semibold text-white truncate">{trigger.name}</p>
          <div className="flex flex-wrap gap-1.5 items-center">
            <ScopeBadge scope={trigger.scope} />
            <ActionTypeBadge type={trigger.action.type} />
            {strategyName && <StrategyTag name={strategyName} />}
          </div>
        </div>
        <span className="flex-shrink-0 w-2 h-2 rounded-full bg-green-400 mt-1.5" title="Active" />
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
      {conditionLabel && (
        <div className="bg-gray-900/60 rounded-lg px-3 py-2 border border-gray-800">
          <p className="text-xs text-gray-500 mb-0.5">
            {trigger.condition.mode === "code" ? "Code condition" : "LLM condition"}
          </p>
          <p className="text-xs text-gray-300 font-mono leading-relaxed">{conditionLabel}</p>
        </div>
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

      {/* Expiry */}
      {trigger.expiresAt && (
        <p className="text-xs text-gray-600">
          Expires: <span className="text-gray-500">{formatTs(trigger.expiresAt)}</span>
        </p>
      )}
    </div>
  );
}

// ── Audit entry ────────────────────────────────────────────────────────────────

function outcomeConfig(outcome: TriggerAuditEntry["outcome"]) {
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
        className: "text-blue-400",
        dot: "bg-blue-400",
      };
    case "reasoning_job_no_action":
      return {
        label: `No action: ${outcome.reason}`,
        className: "text-gray-400",
        dot: "bg-gray-500",
      };
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
                ? "border-b-2 border-blue-500 text-white -mb-px"
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
                sub="Triggers created by the heartbeat agent will appear here while active."
              />
            ) : (
              <div className="p-4 space-y-3">
                {triggers.map((t) => (
                  <ActiveTriggerCard key={t.id} trigger={t} strategyName={t.strategyId ? strategyMap[t.strategyId] : undefined} />
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
