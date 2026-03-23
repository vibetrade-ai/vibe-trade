"use client";
import { useState } from "react";
import { api } from "@/lib/api";

interface Props {
  onCreated: (intentId: string) => void;
}

export function IntentInput({ onCreated }: Props) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || loading) return;
    setLoading(true);
    setError(null);
    try {
      const { intentId } = await api.intents.create(text.trim());
      setText("");
      onCreated(intentId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ background: "white", borderRadius: "16px", padding: "32px", boxShadow: "0 1px 4px rgba(0,0,0,0.08)", marginBottom: "32px" }}>
      <h1 style={{ fontSize: "22px", fontWeight: "700", color: "#1A1A2E", marginBottom: "8px" }}>What do you want to do?</h1>
      <p style={{ fontSize: "14px", color: "#6B7280", marginBottom: "20px" }}>Express your trading intent in plain English</p>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder='e.g. "Buy 2 RELIANCE now" or "Sell TCS if RSI goes above 75" or "Buy ₹5000 NIFTYBEES every Monday"'
          rows={3}
          style={{
            width: "100%",
            padding: "12px 16px",
            borderRadius: "10px",
            border: "1.5px solid #E5E7EB",
            fontSize: "15px",
            resize: "vertical",
            outline: "none",
            fontFamily: "inherit",
            boxSizing: "border-box",
            transition: "border-color 0.2s",
          }}
          onFocus={e => (e.target.style.borderColor = "#00C9A7")}
          onBlur={e => (e.target.style.borderColor = "#E5E7EB")}
          disabled={loading}
        />
        {error && <p style={{ color: "#EF4444", fontSize: "13px" }}>{error}</p>}
        <button
          type="submit"
          disabled={!text.trim() || loading}
          style={{
            alignSelf: "flex-end",
            padding: "10px 28px",
            background: loading || !text.trim() ? "#D1FAF3" : "#00C9A7",
            color: "white",
            border: "none",
            borderRadius: "8px",
            fontSize: "14px",
            fontWeight: "600",
            cursor: loading || !text.trim() ? "not-allowed" : "pointer",
            transition: "background 0.2s",
          }}
        >
          {loading ? "Processing..." : "Submit Intent"}
        </button>
      </form>
    </div>
  );
}
