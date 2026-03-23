"use client";
import { useState } from "react";
import type { PendingApproval } from "@/lib/api";
import { api } from "@/lib/api";

interface Props {
  approval: PendingApproval;
  onDecided: (id: string) => void;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function ApprovalCard({ approval, onDecided }: Props) {
  const [loading, setLoading] = useState<"approved" | "rejected" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: "approved" | "rejected") => {
    if (loading) return;
    setLoading(decision);
    setError(null);
    try {
      await api.approvals.decide(approval.id, decision);
      onDecided(approval.id);
    } catch (err) {
      setError((err as Error).message);
      setLoading(null);
    }
  };

  const isExpired = new Date(approval.expiresAt) < new Date();
  const isPending = approval.status === "pending" && !isExpired;
  const isBuy = approval.tradeArgs?.transaction_type === "BUY";

  return (
    <div style={{
      background: "white",
      borderRadius: "var(--radius)",
      border: "1px solid var(--gray-200)",
      borderLeft: isPending ? "3px solid var(--amber)" : "1px solid var(--gray-200)",
      boxShadow: "var(--shadow-xs)",
      padding: "16px 20px",
      display: "grid",
      gridTemplateColumns: "auto 1fr auto",
      gap: "16px",
      alignItems: "center",
      opacity: !isPending ? 0.65 : 1,
      transition: "opacity 0.2s",
    }}>
      {/* Left: type badge */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "6px" }}>
        {approval.kind === "trade" && approval.tradeArgs ? (
          <div style={{
            padding: "5px 10px",
            borderRadius: "var(--radius-xs)",
            background: isBuy ? "var(--green-light)" : "var(--red-light)",
            color: isBuy ? "var(--green)" : "var(--red)",
            fontSize: "12px",
            fontWeight: "700",
            fontFamily: "var(--font-mono)",
            letterSpacing: "0.05em",
          }}>
            {approval.tradeArgs.transaction_type}
          </div>
        ) : (
          <div style={{
            padding: "5px 10px",
            borderRadius: "var(--radius-xs)",
            background: "var(--amber-light)",
            color: "var(--amber)",
            fontSize: "11px",
            fontWeight: "700",
            letterSpacing: "0.04em",
          }}>
            TRIGGER
          </div>
        )}
      </div>

      {/* Center: details */}
      <div style={{ minWidth: 0 }}>
        {approval.kind === "trade" && approval.tradeArgs ? (
          <>
            <p style={{ margin: "0 0 3px", fontSize: "15px", fontWeight: "700", color: "var(--gray-900)", letterSpacing: "-0.01em" }}>
              {approval.tradeArgs.quantity} × <span style={{ fontFamily: "var(--font-mono)" }}>{approval.tradeArgs.symbol}</span>
              {approval.tradeArgs.price ? ` @ ₹${approval.tradeArgs.price.toLocaleString("en-IN")}` : ""}
            </p>
            <p style={{ margin: "0 0 6px", fontSize: "12px", color: "var(--gray-400)" }}>
              {approval.tradeArgs.order_type}
              {approval.triggerName ? ` · via ${approval.triggerName}` : ""}
            </p>
          </>
        ) : (
          <p style={{ margin: "0 0 6px", fontSize: "15px", fontWeight: "700", color: "var(--gray-900)" }}>
            Create trigger from {approval.originatingTriggerName ?? "unknown"}
          </p>
        )}
        <p style={{
          margin: 0,
          fontSize: "13px",
          color: "var(--gray-500)",
          lineHeight: "1.5",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}>
          {approval.reasoning}
        </p>
        {error && <p style={{ margin: "6px 0 0", fontSize: "12px", color: "var(--red)" }}>{error}</p>}
      </div>

      {/* Right: time + actions */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "10px", flexShrink: 0 }}>
        <span style={{ fontSize: "11px", color: isExpired ? "var(--red)" : "var(--gray-400)" }}>
          {timeAgo(approval.createdAt)}
        </span>
        {isPending ? (
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              onClick={() => void decide("rejected")}
              disabled={!!loading}
              style={{
                padding: "6px 14px",
                borderRadius: "var(--radius-xs)",
                border: "1.5px solid var(--gray-200)",
                background: "white",
                color: "var(--gray-700)",
                fontSize: "13px",
                fontWeight: "600",
                cursor: loading ? "not-allowed" : "pointer",
                opacity: loading === "approved" ? 0.5 : 1,
              }}
            >
              {loading === "rejected" ? "Denying..." : "Deny"}
            </button>
            <button
              onClick={() => void decide("approved")}
              disabled={!!loading}
              style={{
                padding: "6px 14px",
                borderRadius: "var(--radius-xs)",
                border: "none",
                background: "var(--gray-900)",
                color: "white",
                fontSize: "13px",
                fontWeight: "600",
                cursor: loading ? "not-allowed" : "pointer",
                opacity: loading === "rejected" ? 0.5 : 1,
              }}
            >
              {loading === "approved" ? "Approving..." : "Approve"}
            </button>
          </div>
        ) : (
          <span style={{
            padding: "4px 10px",
            borderRadius: "999px",
            fontSize: "11px",
            fontWeight: "700",
            background: approval.status === "approved" ? "var(--green-light)" :
                        approval.status === "rejected" ? "var(--red-light)" : "var(--gray-100)",
            color: approval.status === "approved" ? "var(--green)" :
                   approval.status === "rejected" ? "var(--red)" : "var(--gray-400)",
          }}>
            {isExpired ? "Expired" : approval.status}
          </span>
        )}
      </div>
    </div>
  );
}
