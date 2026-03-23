"use client";
import { useState } from "react";
import type { ClarificationQuestion } from "@/lib/api";

interface Props {
  questions: ClarificationQuestion[];
  onConfirm: (answers: Record<string, string>) => Promise<void>;
  answered?: boolean;
  variant?: "chat" | "card";
}

const THEMES = {
  chat: {
    accent: "var(--blue)",
    selectedBg: "var(--blue)",
    selectedText: "white",
    confirmBg: "var(--gray-900)",
  },
  card: {
    accent: "var(--amber)",
    selectedBg: "var(--amber-light)",
    selectedText: "var(--amber)",
    confirmBg: "var(--gray-900)",
  },
};

export function ClarificationWidget({ questions, onConfirm, answered, variant = "chat" }: Props) {
  const theme = THEMES[variant];

  const [selected, setSelected] = useState<Record<string, string>>(() => {
    const defaults: Record<string, string> = {};
    for (const q of questions) {
      const rec = q.options.find(o => o.recommended);
      if (rec) defaults[q.id] = rec.value;
    }
    return defaults;
  });
  const [submitting, setSubmitting] = useState(false);

  const isCustom = (qId: string) => {
    const val = selected[qId];
    if (val === undefined) return false;
    const q = questions.find(q => q.id === qId);
    return !q?.options.some(o => o.value === val);
  };

  const allAnswered = questions.every(q => {
    const val = selected[q.id];
    return val !== undefined && val.trim() !== "";
  });

  return (
    <div>
      {variant === "chat" && (
        <p style={{ fontSize: "14px", color: "var(--gray-600)", margin: "0 0 16px 0" }}>I need a few details:</p>
      )}
      {questions.map(q => (
        <div key={q.id} style={{ marginBottom: "16px" }}>
          <p style={{ fontSize: "13px", fontWeight: "600", color: "var(--gray-700)", margin: "0 0 8px 0" }}>
            {q.question}
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "7px" }}>
            {q.options.map(opt => {
              const isSelected = !isCustom(q.id) && selected[q.id] === opt.value;
              return (
                <button
                  key={opt.value}
                  disabled={answered || submitting}
                  onClick={() => {
                    if (!answered && !submitting)
                      setSelected(prev => ({ ...prev, [q.id]: opt.value }));
                  }}
                  style={{
                    padding: "5px 13px",
                    fontSize: "13px",
                    borderRadius: "999px",
                    border: isSelected ? `2px solid ${theme.accent}` : "1.5px solid var(--gray-200)",
                    background: isSelected ? theme.selectedBg : "white",
                    color: isSelected ? theme.selectedText : "var(--gray-600)",
                    cursor: answered || submitting ? "default" : "pointer",
                    fontWeight: isSelected ? "600" : "400",
                    transition: "all 0.15s",
                  }}
                >
                  {opt.label}{opt.recommended ? " ★" : ""}
                </button>
              );
            })}
            <button
              disabled={answered || submitting}
              onClick={() => {
                if (!answered && !submitting)
                  setSelected(prev => ({ ...prev, [q.id]: "" }));
              }}
              style={{
                padding: "5px 13px",
                fontSize: "13px",
                borderRadius: "999px",
                border: isCustom(q.id) ? `2px solid ${theme.accent}` : "1.5px solid var(--gray-200)",
                background: isCustom(q.id) ? "var(--blue-light)" : "white",
                color: isCustom(q.id) ? "var(--blue)" : "var(--gray-500)",
                cursor: answered || submitting ? "default" : "pointer",
                fontWeight: isCustom(q.id) ? "600" : "400",
                transition: "all 0.15s",
              }}
            >
              Other...
            </button>
          </div>
          {isCustom(q.id) && !answered && (
            <input
              autoFocus
              placeholder="Type your answer..."
              value={selected[q.id] ?? ""}
              onChange={e => setSelected(prev => ({ ...prev, [q.id]: e.target.value }))}
              style={{
                marginTop: "8px",
                width: "100%",
                padding: "7px 12px",
                fontSize: "13px",
                borderRadius: "var(--radius-xs)",
                border: "1.5px solid var(--gray-200)",
                outline: "none",
                boxSizing: "border-box",
              }}
              onFocus={e => e.target.style.borderColor = "var(--blue)"}
              onBlur={e => e.target.style.borderColor = "var(--gray-200)"}
            />
          )}
        </div>
      ))}
      {!answered ? (
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "10px" }}>
          <button
            disabled={!allAnswered || submitting}
            onClick={async () => {
              if (!allAnswered || submitting) return;
              setSubmitting(true);
              await onConfirm(selected);
            }}
            style={{
              padding: "7px 18px",
              borderRadius: "var(--radius-xs)",
              border: "none",
              background: allAnswered ? theme.confirmBg : "var(--gray-200)",
              color: allAnswered ? "white" : "var(--gray-400)",
              fontSize: "13px",
              fontWeight: "600",
              cursor: allAnswered ? "pointer" : "default",
            }}
          >
            {submitting ? "Confirming..." : "Confirm →"}
          </button>
        </div>
      ) : (
        <p style={{ fontSize: "12px", color: "var(--gray-400)", margin: "8px 0 0 0" }}>Answers submitted ✓</p>
      )}
    </div>
  );
}
