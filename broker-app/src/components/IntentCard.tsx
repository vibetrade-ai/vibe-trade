"use client";
import { useState, useEffect } from "react";
import { api, type Intent, type IntentPerformance } from "@/lib/api";
import { ClarificationWidget } from "@/components/ClarificationWidget";

const STATUS_CONFIG: Record<string, { bg: string; color: string; label: string }> = {
  processing: { bg: "var(--amber-light)", color: "var(--amber)", label: "Processing" },
  clarifying: { bg: "var(--amber-light)", color: "var(--amber)", label: "Needs Input" },
  planning: { bg: "var(--violet-light)", color: "var(--violet)", label: "Planning" },
  active: { bg: "var(--green-light)", color: "var(--green)", label: "Active" },
  completed: { bg: "var(--gray-100)", color: "var(--gray-500)", label: "Completed" },
  failed: { bg: "var(--red-light)", color: "var(--red)", label: "Failed" },
  cancelled: { bg: "var(--gray-100)", color: "var(--gray-400)", label: "Cancelled" },
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

interface Props {
  intent: Intent;
  onCancel?: (id: string) => void;
  onClarified?: (id: string) => void;
}

export function IntentCard({ intent, onCancel, onClarified }: Props) {
  const [cancelling, setCancelling] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [clarifySubmitted, setClarifySubmitted] = useState(false);
  const [perf, setPerf] = useState<IntentPerformance | null>(null);

  const sc = STATUS_CONFIG[intent.status] ?? STATUS_CONFIG.completed;
  const isActive = intent.status === "active";
  const isClarifying = intent.status === "clarifying";
  const isPlanning = intent.status === "planning";
  const isProcessing = intent.status === "processing";

  useEffect(() => {
    if (!isActive) return;
    api.intents.getPerformance(intent.id).then(setPerf).catch(() => {});
  }, [intent.id, isActive]);

  return (
    <div style={{
      background: "white",
      borderRadius: "var(--radius-lg)",
      border: "1px solid var(--gray-200)",
      boxShadow: "var(--shadow-xs)",
      overflow: "hidden",
      transition: "box-shadow 0.2s, transform 0.2s",
    }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLDivElement).style.boxShadow = "var(--shadow-lg)";
        (e.currentTarget as HTMLDivElement).style.transform = "translateY(-2px)";
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLDivElement).style.boxShadow = "var(--shadow-xs)";
        (e.currentTarget as HTMLDivElement).style.transform = "none";
      }}
    >
      {/* Header */}
      <div style={{ padding: "16px 18px 14px" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "10px" }}>
          <span style={{
            display: "inline-block",
            padding: "3px 9px",
            borderRadius: "999px",
            fontSize: "11px",
            fontWeight: "700",
            letterSpacing: "0.04em",
            background: sc.bg,
            color: sc.color,
          }}>
            {sc.label}
          </span>
          {isProcessing && (
            <div style={{ display: "flex", gap: "3px", alignItems: "center", marginTop: "4px" }}>
              {[0, 1, 2].map(i => (
                <div key={i} style={{
                  width: "4px",
                  height: "4px",
                  borderRadius: "50%",
                  background: "var(--amber)",
                  animation: `apPulse 1.2s ease-in-out ${i * 0.2}s infinite`,
                }} />
              ))}
            </div>
          )}
        </div>
        <p style={{
          margin: "0 0 6px",
          fontSize: "14px",
          fontWeight: "700",
          color: "var(--gray-900)",
          letterSpacing: "-0.02em",
          lineHeight: "1.35",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}>
          {intent.text}
        </p>
      </div>

      {/* Clarification */}
      {isClarifying && intent.clarifications && intent.clarifications.length > 0 && (
        <div style={{ padding: "0 18px 16px" }}>
          <div style={{
            background: "var(--amber-light)",
            borderRadius: "var(--radius-xs)",
            padding: "14px",
            border: "1px solid #fde68a",
          }}>
            <span style={{
              display: "inline-block",
              fontSize: "10px",
              fontWeight: "700",
              letterSpacing: "0.08em",
              color: "var(--amber)",
              marginBottom: "10px",
            }}>
              NEEDS YOUR INPUT
            </span>
            <ClarificationWidget
              questions={intent.clarifications}
              answered={clarifySubmitted}
              onConfirm={async (answers) => {
                await api.intents.clarify(intent.id, answers);
                setClarifySubmitted(true);
                onClarified?.(intent.id);
              }}
              variant="card"
            />
          </div>
        </div>
      )}

      {/* Planning */}
      {isPlanning && intent.planSummary && (
        <div style={{ padding: "0 18px 16px" }}>
          <div style={{
            background: "var(--violet-light)",
            borderRadius: "var(--radius-xs)",
            padding: "14px",
          }}>
            <span style={{
              display: "inline-block",
              fontSize: "10px",
              fontWeight: "700",
              letterSpacing: "0.08em",
              color: "var(--violet)",
              marginBottom: "8px",
            }}>
              AWAITING APPROVAL
            </span>
            <p style={{ margin: 0, fontSize: "13px", color: "var(--gray-700)", lineHeight: "1.5", fontWeight: "600" }}>
              {intent.planSummary}
            </p>
          </div>
        </div>
      )}

      {/* Entry/Exit — active state */}
      {!isClarifying && !isPlanning && (isActive || isProcessing) && (
        <div style={{ padding: "0 18px 16px", display: "flex", gap: "10px" }}>
          <div style={{ flex: 1, background: "var(--green-light)", borderRadius: "var(--radius-xs)", padding: "10px 12px" }}>
            <p style={{ margin: "0 0 4px", fontSize: "10px", fontWeight: "700", letterSpacing: "0.06em", color: "var(--green)" }}>ENTRY</p>
            <p style={{ margin: 0, fontSize: "12px", color: "var(--gray-700)", lineHeight: 1.5 }}>
              {isProcessing ? "Processing..." : (intent.entryCondition ?? "—")}
            </p>
          </div>
          <div style={{ flex: 1, background: "var(--violet-light)", borderRadius: "var(--radius-xs)", padding: "10px 12px" }}>
            <p style={{ margin: "0 0 4px", fontSize: "10px", fontWeight: "700", letterSpacing: "0.06em", color: "var(--violet)" }}>EXIT</p>
            <p style={{ margin: 0, fontSize: "12px", color: "var(--gray-700)", lineHeight: 1.5 }}>
              {isProcessing ? "Processing..." : (intent.exitCondition ?? "—")}
            </p>
          </div>
        </div>
      )}

      {/* Performance mini-grid */}
      {perf && (perf.deployedCapital > 0 || perf.tradeCount > 0) && (
        <div style={{
          padding: "12px 18px",
          borderTop: "1px solid var(--gray-100)",
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: "8px",
        }}>
          <div>
            <p style={{ margin: "0 0 2px", fontSize: "10px", color: "var(--gray-400)", fontWeight: "600", letterSpacing: "0.05em" }}>TRADES</p>
            <p style={{ margin: 0, fontSize: "13px", fontWeight: "700", color: "var(--gray-900)" }}>{perf.tradeCount}</p>
          </div>
          <div>
            <p style={{ margin: "0 0 2px", fontSize: "10px", color: "var(--gray-400)", fontWeight: "600", letterSpacing: "0.05em" }}>P&L</p>
            <p style={{ margin: 0, fontSize: "13px", fontWeight: "700", color: perf.realizedPnl >= 0 ? "var(--green)" : "var(--red)" }}>
              {perf.realizedPnl >= 0 ? "+" : ""}₹{perf.realizedPnl.toLocaleString("en-IN")}
            </p>
          </div>
          <div>
            <p style={{ margin: "0 0 2px", fontSize: "10px", color: "var(--gray-400)", fontWeight: "600", letterSpacing: "0.05em" }}>DEPLOYED</p>
            <p style={{ margin: 0, fontSize: "13px", fontWeight: "700", color: "var(--gray-900)" }}>₹{perf.deployedCapital.toLocaleString("en-IN")}</p>
          </div>
        </div>
      )}

      {/* Footer */}
      <div style={{
        padding: "10px 18px",
        borderTop: "1px solid var(--gray-100)",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}>
        <p style={{ margin: 0, fontSize: "12px", color: "var(--gray-400)" }}>
          {timeAgo(intent.createdAt)}
        </p>
        <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
          {(isActive || isProcessing || isClarifying || isPlanning) && onCancel && (
            showDeleteConfirm ? (
              <>
                <span style={{ fontSize: "11px", color: "var(--gray-500)" }}>Delete this intent?</span>
                <button
                  onClick={async () => {
                    if (cancelling) return;
                    setCancelling(true);
                    try {
                      await api.intents.cancel(intent.id);
                      onCancel(intent.id);
                    } catch { /* ignore */ } finally {
                      setCancelling(false);
                      setShowDeleteConfirm(false);
                    }
                  }}
                  style={{
                    padding: "4px 10px",
                    fontSize: "12px",
                    color: "white",
                    border: "none",
                    borderRadius: "6px",
                    background: "var(--red)",
                    cursor: "pointer",
                    fontWeight: "600",
                  }}
                >
                  {cancelling ? "Deleting..." : "Confirm Delete"}
                </button>
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  style={{
                    padding: "4px 10px",
                    fontSize: "12px",
                    color: "var(--gray-500)",
                    border: "1px solid var(--gray-200)",
                    borderRadius: "6px",
                    background: "none",
                    cursor: "pointer",
                    fontWeight: "600",
                  }}
                >
                  Keep
                </button>
              </>
            ) : (
              <button
                onClick={() => setShowDeleteConfirm(true)}
                style={{
                  padding: "4px 12px",
                  fontSize: "12px",
                  color: "var(--gray-500)",
                  border: "1px solid var(--gray-200)",
                  borderRadius: "6px",
                  background: "none",
                  cursor: "pointer",
                  fontWeight: "600",
                }}
              >
                Delete
              </button>
            )
          )}
          <a href={`/intents/${intent.id}`} style={{
            padding: "4px 12px",
            fontSize: "12px",
            color: "var(--gray-900)",
            border: "1px solid var(--gray-200)",
            borderRadius: "6px",
            textDecoration: "none",
            fontWeight: "600",
          }}>
            View →
          </a>
        </div>
      </div>

      <style>{`
        @keyframes apPulse {
          0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
          40% { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </div>
  );
}
