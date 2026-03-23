"use client";
import { useState, useEffect } from "react";
import { api } from "@/lib/api";
import { TopBar } from "@/components/TopBar";

function SectionTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div style={{ marginBottom: "14px" }}>
      <h2 style={{ margin: 0, fontSize: "15px", fontWeight: "700", color: "var(--gray-900)" }}>{title}</h2>
      {sub && <p style={{ margin: "3px 0 0", fontSize: "13px", color: "var(--gray-400)" }}>{sub}</p>}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      background: "white",
      borderRadius: "var(--radius)",
      border: "1px solid var(--gray-200)",
      boxShadow: "var(--shadow-xs)",
      overflow: "hidden",
      marginBottom: "28px",
    }}>
      {children}
    </div>
  );
}

function Row({ children, border = true }: { children: React.ReactNode; border?: boolean }) {
  return (
    <div style={{
      padding: "16px 20px",
      borderBottom: border ? "1px solid var(--gray-100)" : "none",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "16px",
    }}>
      {children}
    </div>
  );
}

const AI_FIELDS = [
  { key: "ANTHROPIC_API_KEY", label: "Anthropic API Key", desc: "Required for AI-powered trading assistant" },
];

const BROKER_FIELDS = [
  { key: "DHAN_ACCESS_TOKEN", label: "Dhan Access Token", desc: "OAuth token from Dhan developer portal" },
  { key: "DHAN_CLIENT_ID", label: "Dhan Client ID", desc: "Your Dhan account client ID" },
];

export default function SettingsPage() {
  const [credStatus, setCredStatus] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [saveResult, setSaveResult] = useState<Record<string, "ok" | "err">>({});
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testLoading, setTestLoading] = useState(false);
  const [showKillConfirm, setShowKillConfirm] = useState(false);

  useEffect(() => {
    api.settings.getStatus()
      .then(r => setCredStatus(r.status))
      .catch(() => {});
  }, []);

  const startEdit = (key: string) => {
    setEditing(prev => ({ ...prev, [key]: "true" }));
    setEditValues(prev => ({ ...prev, [key]: "" }));
    setSaveResult(prev => ({ ...prev, [key]: undefined as unknown as "ok" }));
  };

  const cancelEdit = (key: string) => {
    setEditing(prev => { const n = { ...prev }; delete n[key]; return n; });
  };

  const saveCredential = async (key: string) => {
    const value = editValues[key] ?? "";
    if (!value.trim()) return;
    setSaving(prev => ({ ...prev, [key]: true }));
    try {
      const result = await api.settings.save({ [key]: value });
      setCredStatus(result.status);
      setSaveResult(prev => ({ ...prev, [key]: "ok" }));
      cancelEdit(key);
    } catch {
      setSaveResult(prev => ({ ...prev, [key]: "err" }));
    } finally {
      setSaving(prev => ({ ...prev, [key]: false }));
    }
  };

  const testConnection = async () => {
    setTestLoading(true);
    setTestResult(null);
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"}/health`);
      if (res.ok) {
        const data = await res.json() as { status?: string };
        setTestResult(`Connected — ${data.status ?? "ok"}`);
      } else {
        setTestResult(`Backend returned ${res.status}`);
      }
    } catch {
      setTestResult("Cannot reach backend");
    } finally {
      setTestLoading(false);
    }
  };

  return (
    <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column" }}>
      <TopBar title="Settings" />

      <div style={{ padding: "28px 32px", maxWidth: "680px" }}>

        {/* AI Configuration */}
        <SectionTitle title="AI Configuration" sub="API key for the trading assistant" />
        <Card>
          {AI_FIELDS.map((field, i) => {
            const configured = credStatus[field.key] === true;
            const isEditing = editing[field.key] === "true";
            const isSaving = saving[field.key] === true;
            const result = saveResult[field.key];
            const isLast = i === AI_FIELDS.length - 1;

            return (
              <div key={field.key} style={{ borderBottom: isLast ? "none" : "1px solid var(--gray-100)" }}>
                <Row border={false}>
                  <div>
                    <p style={{ margin: 0, fontSize: "14px", fontWeight: "600", color: "var(--gray-900)" }}>{field.label}</p>
                    <p style={{ margin: "2px 0 0", fontSize: "12px", color: "var(--gray-400)" }}>{field.desc}</p>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    <span style={{
                      padding: "3px 9px",
                      borderRadius: "999px",
                      fontSize: "12px",
                      fontWeight: "600",
                      background: configured ? "var(--green-light)" : "var(--gray-100)",
                      color: configured ? "var(--green)" : "var(--gray-400)",
                    }}>
                      {configured ? "Configured" : "Not set"}
                    </span>
                    {!isEditing && (
                      <button
                        onClick={() => startEdit(field.key)}
                        style={{
                          padding: "5px 12px",
                          borderRadius: "var(--radius-xs)",
                          border: "1.5px solid var(--gray-200)",
                          background: "white",
                          color: "var(--gray-700)",
                          fontSize: "12px",
                          fontWeight: "600",
                          cursor: "pointer",
                        }}
                      >
                        {configured ? "Update" : "Set"}
                      </button>
                    )}
                  </div>
                </Row>
                {isEditing && (
                  <div style={{ padding: "0 20px 14px", display: "flex", alignItems: "center", gap: "8px" }}>
                    <input
                      type="password"
                      autoFocus
                      value={editValues[field.key] ?? ""}
                      onChange={e => setEditValues(prev => ({ ...prev, [field.key]: e.target.value }))}
                      onKeyDown={e => { if (e.key === "Enter") void saveCredential(field.key); if (e.key === "Escape") cancelEdit(field.key); }}
                      placeholder={`Enter ${field.label}`}
                      style={{
                        flex: 1,
                        padding: "7px 12px",
                        borderRadius: "var(--radius-xs)",
                        border: "1.5px solid var(--gray-200)",
                        fontSize: "13px",
                        fontFamily: "var(--font-mono)",
                        outline: "none",
                      }}
                    />
                    <button
                      onClick={() => void saveCredential(field.key)}
                      disabled={isSaving}
                      style={{
                        padding: "7px 14px",
                        borderRadius: "var(--radius-xs)",
                        border: "none",
                        background: "var(--gray-900)",
                        color: "white",
                        fontSize: "12px",
                        fontWeight: "700",
                        cursor: isSaving ? "not-allowed" : "pointer",
                      }}
                    >
                      {isSaving ? "Saving..." : "Save"}
                    </button>
                    <button
                      onClick={() => cancelEdit(field.key)}
                      style={{
                        padding: "7px 12px",
                        borderRadius: "var(--radius-xs)",
                        border: "1.5px solid var(--gray-200)",
                        background: "white",
                        color: "var(--gray-600)",
                        fontSize: "12px",
                        fontWeight: "600",
                        cursor: "pointer",
                      }}
                    >
                      Cancel
                    </button>
                    {result === "err" && (
                      <span style={{ fontSize: "12px", color: "var(--red)" }}>Failed to save</span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </Card>

        {/* Broker Connection */}
        <SectionTitle title="Broker Connection" sub="Connect your trading account" />
        <Card>
          {/* Broker label row */}
          <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--gray-100)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <p style={{ margin: 0, fontSize: "14px", fontWeight: "700", color: "var(--gray-900)" }}>Dhan</p>
              <p style={{ margin: "2px 0 0", fontSize: "12px", color: "var(--gray-400)" }}>More brokers coming soon</p>
            </div>
            <span style={{
              padding: "4px 10px",
              background: "var(--gray-100)",
              color: "var(--gray-400)",
              borderRadius: "6px",
              fontSize: "12px",
              fontWeight: "600",
            }}>
              Only supported broker
            </span>
          </div>

          {BROKER_FIELDS.map((field, i) => {
            const configured = credStatus[field.key] === true;
            const isEditing = editing[field.key] === "true";
            const isSaving = saving[field.key] === true;
            const result = saveResult[field.key];
            const isLast = i === BROKER_FIELDS.length - 1;

            return (
              <div key={field.key} style={{ borderBottom: isLast ? "none" : "1px solid var(--gray-100)" }}>
                <Row border={false}>
                  <div>
                    <p style={{ margin: 0, fontSize: "14px", fontWeight: "600", color: "var(--gray-900)" }}>{field.label}</p>
                    <p style={{ margin: "2px 0 0", fontSize: "12px", color: "var(--gray-400)" }}>{field.desc}</p>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    <span style={{
                      padding: "3px 9px",
                      borderRadius: "999px",
                      fontSize: "12px",
                      fontWeight: "600",
                      background: configured ? "var(--green-light)" : "var(--gray-100)",
                      color: configured ? "var(--green)" : "var(--gray-400)",
                    }}>
                      {configured ? "Configured" : "Not set"}
                    </span>
                    {!isEditing && (
                      <button
                        onClick={() => startEdit(field.key)}
                        style={{
                          padding: "5px 12px",
                          borderRadius: "var(--radius-xs)",
                          border: "1.5px solid var(--gray-200)",
                          background: "white",
                          color: "var(--gray-700)",
                          fontSize: "12px",
                          fontWeight: "600",
                          cursor: "pointer",
                        }}
                      >
                        {configured ? "Update" : "Set"}
                      </button>
                    )}
                  </div>
                </Row>
                {isEditing && (
                  <div style={{ padding: "0 20px 14px", display: "flex", alignItems: "center", gap: "8px" }}>
                    <input
                      type="password"
                      autoFocus
                      value={editValues[field.key] ?? ""}
                      onChange={e => setEditValues(prev => ({ ...prev, [field.key]: e.target.value }))}
                      onKeyDown={e => { if (e.key === "Enter") void saveCredential(field.key); if (e.key === "Escape") cancelEdit(field.key); }}
                      placeholder={`Enter ${field.label}`}
                      style={{
                        flex: 1,
                        padding: "7px 12px",
                        borderRadius: "var(--radius-xs)",
                        border: "1.5px solid var(--gray-200)",
                        fontSize: "13px",
                        fontFamily: "var(--font-mono)",
                        outline: "none",
                      }}
                    />
                    <button
                      onClick={() => void saveCredential(field.key)}
                      disabled={isSaving}
                      style={{
                        padding: "7px 14px",
                        borderRadius: "var(--radius-xs)",
                        border: "none",
                        background: "var(--gray-900)",
                        color: "white",
                        fontSize: "12px",
                        fontWeight: "700",
                        cursor: isSaving ? "not-allowed" : "pointer",
                      }}
                    >
                      {isSaving ? "Saving..." : "Save"}
                    </button>
                    <button
                      onClick={() => cancelEdit(field.key)}
                      style={{
                        padding: "7px 12px",
                        borderRadius: "var(--radius-xs)",
                        border: "1.5px solid var(--gray-200)",
                        background: "white",
                        color: "var(--gray-600)",
                        fontSize: "12px",
                        fontWeight: "600",
                        cursor: "pointer",
                      }}
                    >
                      Cancel
                    </button>
                    {result === "err" && (
                      <span style={{ fontSize: "12px", color: "var(--red)" }}>Failed to save</span>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {/* Test Connection */}
          <div style={{ padding: "14px 20px", borderTop: "1px solid var(--gray-100)", display: "flex", alignItems: "center", gap: "12px" }}>
            <button
              onClick={() => void testConnection()}
              disabled={testLoading}
              style={{
                padding: "7px 16px",
                borderRadius: "var(--radius-xs)",
                border: "1.5px solid var(--gray-200)",
                background: "white",
                color: "var(--gray-700)",
                fontSize: "13px",
                fontWeight: "600",
                cursor: testLoading ? "not-allowed" : "pointer",
              }}
            >
              {testLoading ? "Testing..." : "Test Connection"}
            </button>
            {testResult && (
              <span style={{
                fontSize: "13px",
                fontWeight: "600",
                color: testResult.startsWith("Connected") ? "var(--green)" : "var(--red)",
              }}>
                {testResult}
              </span>
            )}
          </div>
        </Card>

        {/* Emergency Kill Switch */}
        <SectionTitle title="Emergency" sub="Halt all trading immediately" />
        <div style={{
          background: "white",
          borderRadius: "var(--radius)",
          border: "1.5px solid var(--red-light)",
          boxShadow: "var(--shadow-xs)",
          overflow: "hidden",
          marginBottom: "28px",
        }}>
          <Row border={showKillConfirm}>
            <div>
              <p style={{ margin: 0, fontSize: "14px", fontWeight: "700", color: "var(--red)" }}>Kill Switch</p>
              <p style={{ margin: "2px 0 0", fontSize: "12px", color: "var(--gray-400)" }}>Cancel all orders and halt all autopilots immediately</p>
            </div>
            <button
              onClick={() => setShowKillConfirm(true)}
              style={{
                padding: "8px 18px",
                borderRadius: "var(--radius-xs)",
                border: "none",
                background: "var(--red)",
                color: "white",
                fontSize: "13px",
                fontWeight: "700",
                cursor: "pointer",
              }}
            >
              Halt All
            </button>
          </Row>
          {showKillConfirm && (
            <div style={{ padding: "16px 20px", background: "#fff5f5" }}>
              <p style={{ margin: "0 0 14px", fontSize: "13px", color: "var(--red)", fontWeight: "600" }}>
                Are you sure? This will cancel all pending orders and stop all autopilots.
              </p>
              <div style={{ display: "flex", gap: "10px" }}>
                <button
                  onClick={() => setShowKillConfirm(false)}
                  style={{
                    padding: "7px 16px",
                    borderRadius: "var(--radius-xs)",
                    border: "1.5px solid var(--gray-200)",
                    background: "white",
                    color: "var(--gray-700)",
                    fontSize: "13px",
                    fontWeight: "600",
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => setShowKillConfirm(false)}
                  style={{
                    padding: "7px 16px",
                    borderRadius: "var(--radius-xs)",
                    border: "none",
                    background: "var(--red)",
                    color: "white",
                    fontSize: "13px",
                    fontWeight: "700",
                    cursor: "pointer",
                  }}
                >
                  Yes, Halt All Trading
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
