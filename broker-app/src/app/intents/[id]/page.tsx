"use client";
import { useEffect, useState, use, useCallback } from "react";
import { api, type Intent, type IntentPerformance } from "@/lib/api";
import { PrimitiveList } from "@/components/PrimitiveList";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const STATUS_COLORS: Record<string, string> = {
  processing: "#F59E0B",
  clarifying: "#F59E0B",
  planning: "#6366F1",
  active: "#00C9A7",
  completed: "#6B7280",
  failed: "#EF4444",
  cancelled: "#9CA3AF",
};

export default function IntentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [performance, setPerformance] = useState<IntentPerformance | null>(null);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [perfLoading, setPerfLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [planExpanded, setPlanExpanded] = useState(false);

  const refreshPerformance = useCallback(async () => {
    setPerfLoading(true);
    try {
      const perf = await api.intents.getPerformance(id).catch(() => null);
      setPerformance(perf);
    } finally {
      setPerfLoading(false);
    }
  }, [id]);

  useEffect(() => {
    const load = async () => {
      try {
        const [data, perf] = await Promise.all([
          api.intents.get(id),
          api.intents.getPerformance(id).catch(() => null),
        ]);
        setIntent(data);
        setPerformance(perf);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    };
    void load();

    // Poll intent status only while processing — no performance fetch in the loop
    const interval = setInterval(async () => {
      const data = await api.intents.get(id).catch(() => null);
      if (data) {
        setIntent(data);
        if (data.status !== "processing" && data.status !== "clarifying" && data.status !== "planning") clearInterval(interval);
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [id]);

  const handleCancel = async () => {
    if (!intent || cancelling) return;
    setCancelling(true);
    try {
      await api.intents.cancel(intent.id);
      setIntent(prev => prev ? { ...prev, status: "cancelled" } : prev);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCancelling(false);
    }
  };

  if (loading) return <div style={{ maxWidth: "900px", margin: "0 auto", padding: "32px 24px", textAlign: "center", color: "#9CA3AF" }}>Loading...</div>;
  if (error) return <div style={{ maxWidth: "900px", margin: "0 auto", padding: "32px 24px", color: "#EF4444" }}>Error: {error}</div>;
  if (!intent) return <div style={{ maxWidth: "900px", margin: "0 auto", padding: "32px 24px", color: "#9CA3AF" }}>Intent not found</div>;

  const statusColor = STATUS_COLORS[intent.status] ?? "#6B7280";

  return (
    <div style={{ maxWidth: "900px", margin: "0 auto", padding: "32px 24px" }}>
      <div style={{ marginBottom: "24px" }}>
        <a href="/dashboard" style={{ fontSize: "14px", color: "#00C9A7", textDecoration: "none" }}>← Back to dashboard</a>
      </div>

      {/* Intent header card */}
      <div style={{ background: "white", borderRadius: "16px", padding: "24px", boxShadow: "0 1px 4px rgba(0,0,0,0.08)", marginBottom: "24px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "16px" }}>
          <div style={{ flex: 1, paddingRight: "16px" }}>
            <h1 style={{ fontSize: "20px", fontWeight: "700", color: "#1A1A2E", margin: "0 0 8px 0", lineHeight: "1.4" }}>
              {intent.text}
            </h1>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{
              display: "inline-block",
              padding: "4px 14px",
              borderRadius: "999px",
              fontSize: "12px",
              fontWeight: "700",
              letterSpacing: "0.05em",
              background: `${statusColor}20`,
              color: statusColor,
              textTransform: "uppercase",
            }}>
              {intent.status}
            </span>
          </div>
        </div>

        <div style={{ display: "flex", gap: "24px", fontSize: "13px", color: "#9CA3AF" }}>
          <span>Created: {new Date(intent.createdAt).toLocaleString()}</span>
          {intent.resolvedAt && ["completed", "failed", "cancelled"].includes(intent.status) && <span>Resolved: {new Date(intent.resolvedAt).toLocaleString()}</span>}
        </div>
      </div>

      {/* Primitives */}
      <div style={{ background: "white", borderRadius: "16px", padding: "24px", boxShadow: "0 1px 4px rgba(0,0,0,0.08)", marginBottom: "24px" }}>
        <h2 style={{ fontSize: "16px", fontWeight: "700", color: "#1A1A2E", margin: "0 0 16px 0" }}>
          Automations
        </h2>
        <PrimitiveList primitives={intent.primitives} />
      </div>

      {/* Implementation Plan */}
      {intent.plan && (
        <div style={{ background: "white", borderRadius: "16px", padding: "24px", boxShadow: "0 1px 4px rgba(0,0,0,0.08)", marginBottom: "24px", border: intent.status === "planning" ? "1px solid #6366F1" : "1px solid transparent" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
            <h2 style={{ fontSize: "16px", fontWeight: "700", color: "#1A1A2E", margin: 0 }}>Implementation Plan</h2>
            {intent.status === "planning" && (
              <span style={{
                display: "inline-block",
                fontSize: "10px",
                fontWeight: "700",
                letterSpacing: "0.08em",
                color: "#4338CA",
                background: "#EEF2FF",
                padding: "2px 8px",
                borderRadius: "4px",
              }}>
                AWAITING APPROVAL
              </span>
            )}
          </div>
          <p style={{ fontSize: "14px", fontWeight: "600", color: "#374151", margin: "0 0 8px 0", lineHeight: "1.5" }}>
            {intent.planSummary ?? intent.plan.slice(0, 120) + (intent.plan.length > 120 ? "…" : "")}
          </p>
          <button
            onClick={() => setPlanExpanded(v => !v)}
            style={{ fontSize: "12px", color: "#9CA3AF", background: "none", border: "none", padding: 0, cursor: "pointer", textDecoration: "underline", marginBottom: planExpanded ? "12px" : 0 }}
          >
            {planExpanded ? "Hide ↑" : "See full plan ↓"}
          </button>
          {planExpanded && (
            <div style={{
              fontSize: "13px",
              color: "#374151",
              fontFamily: "inherit",
              lineHeight: "1.6",
              background: "#F8FAFB",
              borderRadius: "8px",
              padding: "12px 14px",
              border: "1px solid #E5E7EB",
            }} className="plan-markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{intent.plan}</ReactMarkdown>
            </div>
          )}
        </div>
      )}

      {/* Performance */}
      {performance && (
        <div style={{ background: "white", borderRadius: "16px", padding: "24px", boxShadow: "0 1px 4px rgba(0,0,0,0.08)", marginBottom: "24px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
            <h2 style={{ fontSize: "16px", fontWeight: "700", color: "#1A1A2E", margin: 0 }}>Performance</h2>
            <button
              onClick={refreshPerformance}
              disabled={perfLoading}
              style={{ fontSize: "12px", color: "#00C9A7", background: "none", border: "none", cursor: perfLoading ? "not-allowed" : "pointer", padding: 0 }}
            >
              {perfLoading ? "Refreshing..." : "Refresh"}
            </button>
          </div>
          <div style={{ display: "flex", gap: "32px", marginBottom: "20px", flexWrap: "wrap" }}>
            <div>
              <p style={{ fontSize: "12px", color: "#9CA3AF", margin: "0 0 4px 0", textTransform: "uppercase", letterSpacing: "0.05em" }}>Realized P&L</p>
              <p style={{
                fontSize: "22px", fontWeight: "700", margin: 0,
                color: performance.realizedPnl >= 0 ? "#00C9A7" : "#EF4444",
              }}>
                {performance.realizedPnl >= 0 ? "+" : ""}₹{performance.realizedPnl.toLocaleString()}
              </p>
            </div>
            <div>
              <p style={{ fontSize: "12px", color: "#9CA3AF", margin: "0 0 4px 0", textTransform: "uppercase", letterSpacing: "0.05em" }}>Unrealized P&L</p>
              <p style={{
                fontSize: "22px", fontWeight: "700", margin: 0,
                color: performance.unrealizedPnl >= 0 ? "#00C9A7" : "#EF4444",
              }}>
                {performance.unrealizedPnl >= 0 ? "+" : ""}₹{performance.unrealizedPnl.toLocaleString()}
              </p>
            </div>
            <div>
              <p style={{ fontSize: "12px", color: "#9CA3AF", margin: "0 0 4px 0", textTransform: "uppercase", letterSpacing: "0.05em" }}>Trades</p>
              <p style={{ fontSize: "22px", fontWeight: "700", margin: 0, color: "#1A1A2E" }}>{performance.tradeCount}</p>
            </div>
          </div>

          {/* Capital row */}
          <div style={{
            display: "flex", gap: "0", marginBottom: "20px",
            background: "#F8FAFB", borderRadius: "10px",
            border: "1px solid #E5E7EB", overflow: "hidden",
          }}>
            {performance.allocation !== undefined && (
              <div style={{ flex: 1, padding: "12px 16px", borderRight: "1px solid #E5E7EB" }}>
                <p style={{ fontSize: "11px", color: "#9CA3AF", margin: "0 0 4px 0", textTransform: "uppercase", letterSpacing: "0.05em" }}>Allocated</p>
                <p style={{ fontSize: "16px", fontWeight: "700", margin: 0, color: "#1A1A2E" }}>
                  ₹{performance.allocation.toLocaleString("en-IN")}
                </p>
              </div>
            )}
            <div style={{ flex: 1, padding: "12px 16px", borderRight: performance.availableCapital !== undefined ? "1px solid #E5E7EB" : undefined }}>
              <p style={{ fontSize: "11px", color: "#9CA3AF", margin: "0 0 4px 0", textTransform: "uppercase", letterSpacing: "0.05em" }}>Deployed</p>
              <p style={{ fontSize: "16px", fontWeight: "700", margin: 0, color: "#F59E0B" }}>
                ₹{performance.deployedCapital.toLocaleString("en-IN")}
              </p>
              {performance.allocation !== undefined && performance.allocation > 0 && (
                <p style={{ fontSize: "11px", color: "#9CA3AF", margin: "4px 0 0 0" }}>
                  {((performance.deployedCapital / performance.allocation) * 100).toFixed(1)}% of allocation
                </p>
              )}
            </div>
            {performance.availableCapital !== undefined && (
              <div style={{ flex: 1, padding: "12px 16px" }}>
                <p style={{ fontSize: "11px", color: "#9CA3AF", margin: "0 0 4px 0", textTransform: "uppercase", letterSpacing: "0.05em" }}>Available</p>
                <p style={{
                  fontSize: "16px", fontWeight: "700", margin: 0,
                  color: performance.availableCapital >= 0 ? "#00C9A7" : "#EF4444",
                }}>
                  ₹{performance.availableCapital.toLocaleString("en-IN")}
                </p>
              </div>
            )}
          </div>

          {performance.openPositions.length > 0 && (
            <>
              <h3 style={{ fontSize: "14px", fontWeight: "600", color: "#374151", margin: "0 0 12px 0" }}>Open Positions</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {performance.openPositions.map((pos) => (
                  <div key={pos.symbol} style={{
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    padding: "10px 14px", background: "#F8FAFB", borderRadius: "8px",
                    border: "1px solid #E5E7EB",
                  }}>
                    <div>
                      <span style={{ fontSize: "14px", fontWeight: "600", color: "#1A1A2E" }}>{pos.symbol}</span>
                      <span style={{ fontSize: "12px", color: "#9CA3AF", marginLeft: "8px" }}>Qty: {pos.quantity}</span>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <p style={{ fontSize: "13px", fontWeight: "600", color: "#374151", margin: 0 }}>Avg: ₹{pos.avgBuyPrice.toLocaleString()}</p>
                      {pos.ltp != null && (
                        <p style={{ fontSize: "12px", color: "#6B7280", margin: 0 }}>LTP: ₹{pos.ltp.toLocaleString()}</p>
                      )}
                      {pos.unrealizedPnl != null && (
                        <p style={{ fontSize: "12px", fontWeight: "600", margin: 0, color: pos.unrealizedPnl >= 0 ? "#00C9A7" : "#EF4444" }}>
                          {pos.unrealizedPnl >= 0 ? "+" : ""}₹{pos.unrealizedPnl.toLocaleString()}
                        </p>
                      )}
                      <p style={{ fontSize: "12px", color: "#9CA3AF", margin: 0 }}>Deployed: ₹{pos.deployedCapital.toLocaleString()}</p>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {performance.tradeCount === 0 && (
            <p style={{ fontSize: "14px", color: "#9CA3AF", fontStyle: "italic", margin: 0 }}>No trades recorded yet</p>
          )}
        </div>
      )}

      {/* Actions */}
      {(intent.status === "active" || intent.status === "processing" || intent.status === "clarifying" || intent.status === "planning") && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "12px" }}>
          <button
            onClick={() => setShowDeleteConfirm(v => !v)}
            disabled={cancelling}
            style={{
              padding: "10px 24px",
              borderRadius: "8px",
              border: "1.5px solid #E5E7EB",
              background: "white",
              color: "#374151",
              fontSize: "14px",
              fontWeight: "600",
              cursor: cancelling ? "not-allowed" : "pointer",
            }}
          >
            Delete Intent
          </button>
          {showDeleteConfirm && (
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <span style={{ fontSize: "13px", color: "#6B7280" }}>Are you sure? This will stop all linked triggers.</span>
              <button
                onClick={handleCancel}
                disabled={cancelling}
                style={{
                  padding: "8px 18px",
                  borderRadius: "8px",
                  border: "none",
                  background: "#EF4444",
                  color: "white",
                  fontSize: "13px",
                  fontWeight: "700",
                  cursor: cancelling ? "not-allowed" : "pointer",
                }}
              >
                {cancelling ? "Deleting..." : "Yes, Delete"}
              </button>
              <button
                onClick={() => setShowDeleteConfirm(false)}
                style={{
                  padding: "8px 18px",
                  borderRadius: "8px",
                  border: "1.5px solid #E5E7EB",
                  background: "white",
                  color: "#374151",
                  fontSize: "13px",
                  fontWeight: "600",
                  cursor: "pointer",
                }}
              >
                Keep
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
