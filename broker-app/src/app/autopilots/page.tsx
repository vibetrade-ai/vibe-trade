"use client";
import { useState, useEffect, useCallback } from "react";
import { api, type Intent } from "@/lib/api";
import { IntentCard } from "@/components/IntentCard";
import { TopBar, BrokerPill } from "@/components/TopBar";

export default function AutopilotsPage() {
  const [intents, setIntents] = useState<Intent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadIntents = useCallback(async () => {
    try {
      const data = await api.intents.list();
      setIntents(data.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadIntents();
    const interval = setInterval(() => void loadIntents(), 5000);
    return () => clearInterval(interval);
  }, [loadIntents]);

  const handleCancel = (id: string) => {
    setIntents(prev => prev.filter(i => i.id !== id));
  };

  const active = intents.filter(i => ["active", "processing", "clarifying", "planning"].includes(i.status));
  const past = intents.filter(i => i.status === "completed");

  return (
    <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column" }}>
      <TopBar title="Autopilots" right={<BrokerPill />} />

      <div style={{ padding: "28px 32px", flex: 1 }}>
        {error && (
          <div style={{
            padding: "12px 16px",
            background: "var(--red-light)",
            borderRadius: "var(--radius-xs)",
            color: "var(--red)",
            fontSize: "14px",
            marginBottom: "24px",
          }}>
            Failed to load: {error}
          </div>
        )}

        {loading ? (
          <div style={{ textAlign: "center", padding: "60px", color: "var(--gray-400)" }}>Loading...</div>
        ) : intents.length === 0 ? (
          <div style={{ textAlign: "center", padding: "80px 20px" }}>
            <p style={{ fontSize: "16px", fontWeight: "600", color: "var(--gray-500)", margin: "0 0 8px" }}>No autopilots yet</p>
            <p style={{ fontSize: "14px", color: "var(--gray-400)", margin: "0 0 20px" }}>Create one from the Chat page by describing a trading strategy</p>
            <a href="/" style={{
              display: "inline-block",
              padding: "9px 20px",
              background: "var(--gray-900)",
              color: "white",
              borderRadius: "var(--radius-xs)",
              textDecoration: "none",
              fontSize: "14px",
              fontWeight: "600",
            }}>
              Go to Chat →
            </a>
          </div>
        ) : (
          <>
            {active.length > 0 && (
              <section style={{ marginBottom: "40px" }}>
                <h2 style={{
                  fontSize: "12px",
                  fontWeight: "700",
                  color: "var(--gray-400)",
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  margin: "0 0 16px",
                }}>
                  Active ({active.length})
                </h2>
                <div style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(330px, 1fr))",
                  gap: "16px",
                }}>
                  {active.map(intent => (
                    <IntentCard key={intent.id} intent={intent} onCancel={handleCancel} onClarified={() => void loadIntents()} />
                  ))}
                </div>
              </section>
            )}

            {past.length > 0 && (
              <section>
                <h2 style={{
                  fontSize: "12px",
                  fontWeight: "700",
                  color: "var(--gray-400)",
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  margin: "0 0 16px",
                }}>
                  History ({past.length})
                </h2>
                <div style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(330px, 1fr))",
                  gap: "16px",
                  opacity: 0.75,
                }}>
                  {past.map(intent => (
                    <IntentCard key={intent.id} intent={intent} />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
