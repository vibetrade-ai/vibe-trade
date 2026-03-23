"use client";
import { useEffect, useState, useCallback } from "react";
import { api, type PendingApproval } from "@/lib/api";
import { ApprovalCard } from "@/components/ApprovalCard";
import { TopBar, BrokerPill } from "@/components/TopBar";

export default function ApprovalsPage() {
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"pending" | "history">("pending");

  const load = useCallback(async () => {
    try {
      const data = await api.approvals.list(tab === "history" ? "all" : "pending");
      setApprovals(data);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => {
    setLoading(true);
    void load();
    const interval = setInterval(() => void load(), 5000);
    return () => clearInterval(interval);
  }, [load]);

  const handleDecided = (id: string) => {
    if (tab === "pending") {
      setApprovals(prev => prev.filter(a => a.id !== id));
    } else {
      void load();
    }
  };

  const pendingCount = approvals.filter(a => a.status === "pending").length;

  return (
    <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column" }}>
      <TopBar title="Approvals" right={<BrokerPill />} />

      <div style={{ padding: "28px 32px", flex: 1 }}>
        {/* Tab switcher */}
        <div style={{
          display: "inline-flex",
          background: "var(--gray-150)",
          borderRadius: "var(--radius-xs)",
          padding: "3px",
          marginBottom: "24px",
          gap: "2px",
        }}>
          {(["pending", "history"] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                padding: "6px 16px",
                borderRadius: "6px",
                border: "none",
                background: tab === t ? "white" : "transparent",
                color: tab === t ? "var(--gray-900)" : "var(--gray-500)",
                fontSize: "13px",
                fontWeight: "600",
                cursor: "pointer",
                boxShadow: tab === t ? "var(--shadow-xs)" : "none",
                transition: "all 0.15s",
              }}
            >
              {t === "pending" ? `Pending${pendingCount > 0 ? ` (${pendingCount})` : ""}` : "History"}
            </button>
          ))}
        </div>

        {loading ? (
          <div style={{ textAlign: "center", padding: "60px", color: "var(--gray-400)" }}>Loading...</div>
        ) : approvals.length === 0 ? (
          <div style={{ textAlign: "center", padding: "60px 20px" }}>
            <p style={{ fontSize: "16px", fontWeight: "600", color: "var(--gray-500)", margin: "0 0 8px" }}>
              {tab === "pending" ? "No pending approvals" : "No approval history"}
            </p>
            <p style={{ fontSize: "14px", color: "var(--gray-400)", margin: 0 }}>
              Approvals appear here when triggers propose trades
            </p>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {approvals.map(approval => (
              <ApprovalCard key={approval.id} approval={approval} onDecided={handleDecided} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
