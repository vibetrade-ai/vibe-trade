"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getBackendHttpUrl } from "@/lib/backend-url";

// ── Types ──────────────────────────────────────────────────────────────────────

type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

interface TradeArgs {
  symbol: string;
  transaction_type: "BUY" | "SELL";
  quantity: number;
  order_type: "MARKET" | "LIMIT";
  price?: number;
}

type TriggerStatus = "active" | "fired" | "expired" | "cancelled";

interface TriggerCondition {
  mode: "code" | "llm";
  expression?: string;
  description?: string;
}

export type PendingApproval =
  | {
      id: string;
      kind: "trade";
      triggerId: string;
      triggerName: string;
      reasoning: string;
      tradeArgs: TradeArgs;
      status: ApprovalStatus;
      createdAt: string;
      expiresAt: string;
      decidedAt?: string;
    }
  | {
      id: string;
      kind: "hard_trigger";
      originatingTriggerId: string;
      originatingTriggerName: string;
      reasoning: string;
      proposedTrigger: {
        name: string;
        scope: string;
        watchSymbols: string[];
        condition: TriggerCondition;
        action: { type: "hard_order"; tradeArgs: TradeArgs };
        expiresAt?: string;
        status: TriggerStatus;
      };
      status: ApprovalStatus;
      createdAt: string;
      expiresAt: string;
      decidedAt?: string;
    };

// ── Hook ───────────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 10_000;

export function useApprovals() {
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [loading, setLoading] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${getBackendHttpUrl()}/api/approvals`);
      if (!res.ok) return;
      const data = (await res.json()) as PendingApproval[];
      setApprovals(data);
    } catch {
      // backend unreachable — keep previous state
    } finally {
      setLoading(false);
    }
  }, []);

  const decide = useCallback(
    async (id: string, decision: "approved" | "rejected") => {
      try {
        await fetch(`${getBackendHttpUrl()}/api/approvals/${id}/decide`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision }),
        });
        // Optimistically update local state
        setApprovals((prev) =>
          prev.map((a) => (a.id === id ? { ...a, status: decision } : a))
        );
      } catch {
        // ignore — next poll will sync state
      }
    },
    []
  );

  useEffect(() => {
    refresh();
    intervalRef.current = setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [refresh]);

  const pendingCount = approvals.filter((a) => a.status === "pending").length;

  return { approvals, pendingCount, loading, decide, refresh };
}
