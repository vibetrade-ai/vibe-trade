"use client";

import { useEffect, useState } from "react";
import type { PendingApproval } from "../hooks/useApprovals";

// ── Countdown helper ───────────────────────────────────────────────────────────

function useCountdown(expiresAt: string) {
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000))
  );

  useEffect(() => {
    const id = setInterval(() => {
      setRemaining(Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000)));
    }, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  return remaining;
}

function CountdownBadge({ expiresAt }: { expiresAt: string }) {
  const secs = useCountdown(expiresAt);
  const mins = Math.floor(secs / 60);
  const s = secs % 60;
  const isUrgent = secs < 300; // < 5 minutes

  const label =
    secs === 0
      ? "Expired"
      : `${mins}m ${String(s).padStart(2, "0")}s`;

  return (
    <span className={`text-xs font-mono ${isUrgent ? "text-red-400" : "text-gray-500"}`}>
      {label}
    </span>
  );
}

// ── Status badge (for non-pending approvals) ───────────────────────────────────

function StatusBadge({ status }: { status: "approved" | "rejected" | "expired" | "pending" }) {
  const config = {
    approved: "bg-green-900/50 text-green-400 border border-green-700/50",
    rejected: "bg-red-900/50 text-red-400 border border-red-800/50",
    expired: "bg-gray-800 text-gray-500 border border-gray-700",
    pending: "bg-amber-900/40 text-amber-400 border border-amber-700/40",
  }[status];

  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${config}`}>
      {status}
    </span>
  );
}

// ── Trade args detail table ────────────────────────────────────────────────────

interface TradeArgs {
  symbol: string;
  transaction_type: "BUY" | "SELL";
  quantity: number;
  order_type: "MARKET" | "LIMIT";
  price?: number;
}

function TradeDetail({ args }: { args: TradeArgs }) {
  return (
    <div className="bg-gray-900/60 rounded-lg p-3 text-xs font-mono space-y-1.5 border border-gray-800">
      <div className="flex justify-between gap-4">
        <span className="text-gray-500">Symbol</span>
        <span className="text-white font-semibold">{args.symbol}</span>
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-gray-500">Direction</span>
        <span
          className={`font-bold ${
            args.transaction_type === "BUY" ? "text-green-400" : "text-red-400"
          }`}
        >
          {args.transaction_type}
        </span>
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-gray-500">Quantity</span>
        <span className="text-gray-100">{args.quantity}</span>
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-gray-500">Order Type</span>
        <span className="text-gray-100">{args.order_type}</span>
      </div>
      {args.price !== undefined && (
        <div className="flex justify-between gap-4">
          <span className="text-gray-500">Price</span>
          <span className="text-gray-100">{args.price}</span>
        </div>
      )}
    </div>
  );
}

// ── Collapsible reasoning block ────────────────────────────────────────────────

function Reasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const isLong = text.length > 200;

  if (!isLong) {
    return <p className="text-gray-300 text-xs leading-relaxed">{text}</p>;
  }

  return (
    <div>
      <p className="text-gray-300 text-xs leading-relaxed">
        {open ? text : `${text.slice(0, 200)}…`}
      </p>
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-blue-500 hover:text-blue-400 text-xs mt-1 transition-colors"
      >
        {open ? "Show less" : "Show more"}
      </button>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

interface ApprovalItemProps {
  approval: PendingApproval;
  onDecide: (id: string, decision: "approved" | "rejected") => Promise<void>;
}

export function ApprovalItem({ approval, onDecide }: ApprovalItemProps) {
  const [busy, setBusy] = useState(false);

  const handleDecide = async (decision: "approved" | "rejected") => {
    setBusy(true);
    try {
      await onDecide(approval.id, decision);
    } finally {
      setBusy(false);
    }
  };

  const isPending = approval.status === "pending";

  return (
    <div className="rounded-xl border border-gray-700 bg-gray-800/60 p-4 space-y-3">
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          {approval.kind === "trade" ? (
            <>
              <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">
                Trade Approval
              </p>
              <p className="text-sm font-semibold text-white">{approval.triggerName}</p>
            </>
          ) : (
            <>
              <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">
                New Trigger Approval
              </p>
              <p className="text-sm font-semibold text-white">
                {approval.proposedTrigger.name}
              </p>
              <p className="text-xs text-gray-500">
                from: {approval.originatingTriggerName}
              </p>
            </>
          )}
        </div>
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          {isPending ? (
            <CountdownBadge expiresAt={approval.expiresAt} />
          ) : (
            <StatusBadge status={approval.status} />
          )}
        </div>
      </div>

      {/* Trade details */}
      {approval.kind === "trade" && <TradeDetail args={approval.tradeArgs} />}

      {/* Hard trigger: proposed trigger info */}
      {approval.kind === "hard_trigger" && (
        <div className="bg-gray-900/60 rounded-lg p-3 text-xs border border-gray-800 space-y-1.5">
          <div className="flex justify-between gap-4">
            <span className="text-gray-500 font-mono">Scope</span>
            <span className="text-gray-100">{approval.proposedTrigger.scope}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-gray-500 font-mono">Symbols</span>
            <span className="text-gray-100">
              {approval.proposedTrigger.watchSymbols.join(", ")}
            </span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-gray-500 font-mono">Condition</span>
            <span className="text-gray-100 text-right max-w-[60%] truncate">
              {approval.proposedTrigger.condition.mode === "code"
                ? approval.proposedTrigger.condition.expression
                : approval.proposedTrigger.condition.description}
            </span>
          </div>
          {approval.proposedTrigger.action.type === "hard_order" && (
            <div className="pt-1 mt-1 border-t border-gray-700">
              <p className="text-gray-500 font-mono mb-1">Will Place Order</p>
              <TradeDetail args={approval.proposedTrigger.action.tradeArgs} />
            </div>
          )}
        </div>
      )}

      {/* Reasoning */}
      <Reasoning text={approval.reasoning} />

      {/* Action buttons or status */}
      {isPending ? (
        <div className="flex gap-2 pt-1">
          <button
            onClick={() => handleDecide("approved")}
            disabled={busy}
            className="flex-1 rounded-lg bg-green-600 hover:bg-green-700 active:bg-green-800 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-2 px-3 text-sm transition-colors"
          >
            {busy ? "…" : "Approve"}
          </button>
          <button
            onClick={() => handleDecide("rejected")}
            disabled={busy}
            className="flex-1 rounded-lg bg-red-900/50 hover:bg-red-900 active:bg-red-950 disabled:opacity-50 disabled:cursor-not-allowed text-red-400 font-semibold py-2 px-3 text-sm transition-colors border border-red-800/40"
          >
            {busy ? "…" : "Reject"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
