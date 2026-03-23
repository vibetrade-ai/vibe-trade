"use client";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Props {
  plan: string;
  summary: string;
  onApprove: () => Promise<void>;
  onRequestChanges: (feedback: string) => Promise<void>;
  submitted?: boolean;
}

export function PlanProposalWidget({ plan, summary, onApprove, onRequestChanges, submitted }: Props) {
  const [mode, setMode] = useState<"idle" | "requesting_changes">("idle");
  const [feedback, setFeedback] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<"approved" | "changes_requested" | null>(null);
  const [planExpanded, setPlanExpanded] = useState(false);

  const handleApprove = async () => {
    setSubmitting(true);
    try {
      await onApprove();
      setResult("approved");
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmitFeedback = async () => {
    if (!feedback.trim()) return;
    setSubmitting(true);
    try {
      await onRequestChanges(feedback.trim());
      setResult("changes_requested");
    } finally {
      setSubmitting(false);
    }
  };

  const isDone = submitted || result !== null;

  return (
    <div>
      {/* Badge */}
      <div style={{ marginBottom: "10px" }}>
        <span style={{
          display: "inline-block",
          fontSize: "10px",
          fontWeight: "700",
          letterSpacing: "0.08em",
          color: "var(--violet)",
          background: "var(--violet-light)",
          padding: "2px 8px",
          borderRadius: "4px",
        }}>
          IMPLEMENTATION PLAN
        </span>
      </div>

      {/* Summary */}
      <p style={{ fontSize: "14px", fontWeight: "700", color: "var(--gray-900)", margin: "0 0 10px 0", lineHeight: "1.4" }}>
        {summary}
      </p>

      {/* Toggle */}
      <button
        onClick={() => setPlanExpanded(v => !v)}
        style={{ fontSize: "12px", color: "var(--gray-400)", background: "none", border: "none", padding: "0 0 12px 0", cursor: "pointer", textDecoration: "underline" }}
      >
        {planExpanded ? "Hide ↑" : "See full plan ↓"}
      </button>

      {/* Plan text — collapsed by default */}
      {planExpanded && (
        <div style={{
          maxHeight: "280px",
          overflowY: "auto",
          background: "var(--gray-50)",
          borderRadius: "var(--radius-xs)",
          padding: "12px 14px",
          marginBottom: "14px",
          border: "1px solid var(--gray-200)",
        }}>
          <div style={{
            fontSize: "13px",
            color: "var(--gray-700)",
            fontFamily: "inherit",
            lineHeight: "1.6",
          }} className="plan-markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{plan}</ReactMarkdown>
          </div>
        </div>
      )}

      {/* Footer */}
      {isDone ? (
        <p style={{ fontSize: "13px", color: result === "approved" ? "var(--green)" : "var(--violet)", margin: 0, fontWeight: "600" }}>
          {result === "approved" ? "Plan approved ✓" : "Changes requested ✓"}
        </p>
      ) : mode === "idle" ? (
        <div style={{ display: "flex", gap: "8px" }}>
          <button
            onClick={() => setMode("requesting_changes")}
            disabled={submitting}
            style={{
              padding: "7px 14px",
              fontSize: "13px",
              borderRadius: "var(--radius-xs)",
              border: "1.5px solid var(--gray-200)",
              background: "white",
              color: "var(--gray-700)",
              fontWeight: "600",
              cursor: submitting ? "not-allowed" : "pointer",
            }}
          >
            Request Changes
          </button>
          <button
            onClick={() => void handleApprove()}
            disabled={submitting}
            style={{
              padding: "7px 14px",
              fontSize: "13px",
              borderRadius: "var(--radius-xs)",
              border: "none",
              background: submitting ? "var(--gray-300)" : "var(--gray-900)",
              color: "white",
              fontWeight: "600",
              cursor: submitting ? "not-allowed" : "pointer",
            }}
          >
            {submitting ? "Approving..." : "Approve Plan"}
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <textarea
            value={feedback}
            onChange={e => setFeedback(e.target.value)}
            placeholder="Describe what you'd like changed..."
            rows={3}
            style={{
              width: "100%",
              padding: "8px 12px",
              borderRadius: "var(--radius-xs)",
              border: "1.5px solid var(--gray-200)",
              fontSize: "13px",
              color: "var(--gray-700)",
              resize: "vertical",
              outline: "none",
              boxSizing: "border-box",
              background: "var(--gray-50)",
            }}
            onFocus={e => e.target.style.borderColor = "var(--blue)"}
            onBlur={e => e.target.style.borderColor = "var(--gray-200)"}
          />
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              onClick={() => setMode("idle")}
              disabled={submitting}
              style={{
                padding: "7px 14px",
                fontSize: "13px",
                borderRadius: "var(--radius-xs)",
                border: "1.5px solid var(--gray-200)",
                background: "white",
                color: "var(--gray-600)",
                fontWeight: "600",
                cursor: submitting ? "not-allowed" : "pointer",
              }}
            >
              Cancel
            </button>
            <button
              onClick={() => void handleSubmitFeedback()}
              disabled={submitting || !feedback.trim()}
              style={{
                padding: "7px 14px",
                fontSize: "13px",
                borderRadius: "var(--radius-xs)",
                border: "none",
                background: feedback.trim() && !submitting ? "var(--gray-900)" : "var(--gray-200)",
                color: feedback.trim() && !submitting ? "white" : "var(--gray-400)",
                fontWeight: "600",
                cursor: feedback.trim() && !submitting ? "pointer" : "not-allowed",
              }}
            >
              {submitting ? "Submitting..." : "Submit Feedback"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
