"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { StrategyDashboard } from "./StrategyDashboard";

// ── Types ──────────────────────────────────────────────────────────────────────

type StrategyState = "scanning" | "accumulating" | "holding" | "exiting" | "paused";
type StrategyStatus = "active" | "archived";

interface Strategy {
  id: string;
  name: string;
  description: string;
  plan: string;
  allocation: number;
  state: StrategyState;
  status: StrategyStatus;
  createdAt: string;
  updatedAt: string;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:3001";
const POLL_INTERVAL_MS = 30_000;

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatAllocation(n: number) {
  return "₹" + n.toLocaleString("en-IN");
}

// ── State badge ────────────────────────────────────────────────────────────────

const STATE_COLORS: Record<StrategyState, string> = {
  scanning: "bg-blue-900/40 text-blue-300 border-blue-800/40",
  accumulating: "bg-green-900/40 text-green-300 border-green-800/40",
  holding: "bg-amber-900/40 text-amber-300 border-amber-800/40",
  exiting: "bg-red-900/40 text-red-300 border-red-800/40",
  paused: "bg-gray-700/60 text-gray-400 border-gray-600/40",
};

function StateBadge({ state }: { state: StrategyState }) {
  return (
    <span
      className={`px-2 py-0.5 rounded text-xs font-medium border capitalize ${STATE_COLORS[state]}`}
    >
      {state}
    </span>
  );
}

// ── Empty state ────────────────────────────────────────────────────────────────

function EmptyState() {
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
            d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
          />
        </svg>
      </div>
      <p className="text-gray-300 font-medium text-sm">No strategies yet</p>
      <p className="text-gray-600 text-xs max-w-xs">
        Create a strategy via chat — e.g. &quot;Create a momentum strategy for large caps with ₹5L allocation&quot;
      </p>
    </div>
  );
}

// ── Strategy Card ──────────────────────────────────────────────────────────────

function StrategyCard({ strategy, onRefresh, onViewPerformance }: { strategy: Strategy; onRefresh: () => void; onViewPerformance: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  const handleArchive = async () => {
    if (!confirm(`Archive "${strategy.name}"?\n\nThis will cancel all linked triggers and delete all linked schedules. The strategy will no longer appear in the active list.\n\nContinue?`)) return;
    setArchiving(true);
    setArchiveError(null);
    try {
      const res = await fetch(`${BACKEND_URL}/api/strategies/${strategy.id}`, { method: "DELETE" });
      if (res.status === 409) {
        const body = await res.json() as { openPositions?: { symbol: string; quantity: number }[]; hint?: string };
        const positions = body.openPositions ?? [];
        const lines = positions.map(p => `• ${p.symbol} × ${p.quantity}`).join("\n");
        setArchiveError(`Can't archive — open positions:\n${lines}\n${body.hint ?? "Close them in Dhan first."}`);
        return;
      }
      if (res.ok) onRefresh();
    } catch {
      // ignore network errors
    } finally {
      setArchiving(false);
    }
  };

  return (
    <div className="rounded-xl border border-gray-700 bg-gray-800/60 p-4 space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1 min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold text-white">{strategy.name}</p>
            <StateBadge state={strategy.state} />
          </div>
          <p className="text-xs text-gray-400 line-clamp-2">{strategy.description}</p>
        </div>
        <div className="flex-shrink-0 text-right">
          <p className="text-xs text-gray-500">Allocation</p>
          <p className="text-sm font-medium text-white">{formatAllocation(strategy.allocation)}</p>
        </div>
      </div>

      {/* Plan (collapsible) */}
      <div>
        <button
          onClick={() => setExpanded(e => !e)}
          className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className={`w-3.5 h-3.5 transition-transform ${expanded ? "rotate-90" : ""}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          {expanded ? "Hide plan" : "Show plan"}
        </button>
        {expanded && (
          <pre className="mt-2 text-xs text-gray-300 whitespace-pre-wrap font-mono bg-gray-900/60 rounded-lg p-3 border border-gray-700/50 max-h-48 overflow-y-auto">
            {strategy.plan}
          </pre>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between pt-1">
        <p className="text-xs text-gray-600">
          ID: <span className="font-mono">{strategy.id.slice(0, 8)}…</span>
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onViewPerformance(strategy.id)}
            className="px-3 py-1.5 rounded-lg bg-blue-900/30 text-blue-400 border border-blue-800/40 text-xs font-medium hover:bg-blue-900/50 hover:text-blue-300 transition-colors"
          >
            Performance
          </button>
          <button
            onClick={handleArchive}
            disabled={archiving}
            className="px-3 py-1.5 rounded-lg bg-gray-700/40 text-gray-400 border border-gray-600/40 text-xs font-medium hover:bg-red-900/30 hover:text-red-400 hover:border-red-800/40 disabled:opacity-50 transition-colors"
          >
            Archive
          </button>
        </div>
      </div>

      {/* Archive error callout */}
      {archiveError && (
        <div className="rounded-lg bg-red-950/40 border border-red-800/40 p-2.5 mt-1">
          <pre className="text-xs text-red-300 whitespace-pre-wrap font-sans">{archiveError}</pre>
        </div>
      )}
    </div>
  );
}

// ── StrategiesPanel ────────────────────────────────────────────────────────────

export function StrategiesPanel() {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedStrategyId, setSelectedStrategyId] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStrategies = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/strategies`);
      if (!res.ok) return;
      setStrategies((await res.json()) as Strategy[]);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStrategies();
    intervalRef.current = setInterval(fetchStrategies, POLL_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchStrategies]);

  // Show performance dashboard for a selected strategy
  if (selectedStrategyId) {
    return (
      <StrategyDashboard
        strategyId={selectedStrategyId}
        onBack={() => setSelectedStrategyId(null)}
      />
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-4 space-y-3">
            {[1, 2].map((i) => (
              <div
                key={i}
                className="rounded-xl border border-gray-700 bg-gray-800/40 p-4 h-40 animate-pulse"
              />
            ))}
          </div>
        ) : strategies.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="p-4 space-y-3">
            {strategies.map((s) => (
              <StrategyCard
                key={s.id}
                strategy={s}
                onRefresh={fetchStrategies}
                onViewPerformance={setSelectedStrategyId}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
