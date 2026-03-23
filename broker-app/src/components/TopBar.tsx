"use client";
import { useState, useEffect } from "react";
import type { ReactNode } from "react";
import { api } from "@/lib/api";

interface Props {
  title: string;
  right?: ReactNode;
}

export function TopBar({ title, right }: Props) {
  return (
    <div style={{
      background: "rgba(255,255,255,0.82)",
      backdropFilter: "blur(20px)",
      WebkitBackdropFilter: "blur(20px)",
      borderBottom: "1px solid var(--gray-200)",
      minHeight: "64px",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "0 32px",
      flexShrink: 0,
      position: "sticky",
      top: 0,
      zIndex: 10,
    }}>
      <h1 style={{
        margin: 0,
        fontSize: "17px",
        fontWeight: "700",
        color: "var(--gray-900)",
        letterSpacing: "-0.02em",
      }}>
        {title}
      </h1>
      {right && (
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          {right}
        </div>
      )}
    </div>
  );
}

type BrokerState = "loading" | "connected" | "expired" | "not_configured" | "error";

export function BrokerPill() {
  const [state, setState] = useState<BrokerState>("loading");

  useEffect(() => {
    api.settings.getBrokerStatus()
      .then(r => {
        if (!r.configured) setState("not_configured");
        else if (r.expired) setState("expired");
        else if (r.connected) setState("connected");
        else setState("error");
      })
      .catch(() => setState("error"));
  }, []);

  const config: Record<BrokerState, { dot: string; label: string; bg: string; color: string }> = {
    loading:        { dot: "var(--gray-300)", label: "Dhan",          bg: "var(--gray-100)", color: "var(--gray-400)" },
    connected:      { dot: "var(--green)",    label: "Dhan",          bg: "var(--gray-100)", color: "var(--gray-600)" },
    expired:        { dot: "#F59E0B",         label: "Token Expired", bg: "#FFFBEB",         color: "#B45309" },
    not_configured: { dot: "var(--gray-300)", label: "Not connected", bg: "var(--gray-100)", color: "var(--gray-400)" },
    error:          { dot: "var(--red)",      label: "Dhan error",    bg: "var(--red-light)", color: "var(--red)" },
  };

  const { dot, label, bg, color } = config[state];

  return (
    <div
      title={state === "expired" ? "Dhan access token has expired — update it in Settings" : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "6px",
        padding: "5px 12px",
        background: bg,
        borderRadius: "999px",
        fontSize: "12px",
        fontWeight: "600",
        color,
        cursor: state === "expired" ? "pointer" : "default",
      }}
      onClick={state === "expired" ? () => { window.location.href = "/settings"; } : undefined}
    >
      <span style={{
        width: "6px",
        height: "6px",
        borderRadius: "50%",
        background: dot,
        display: "inline-block",
        flexShrink: 0,
      }} />
      {label}
    </div>
  );
}
