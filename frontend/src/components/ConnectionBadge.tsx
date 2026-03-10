"use client";

import { useEffect, useState } from "react";
import { getBackendHttpUrl } from "@/lib/backend-url";

type ConnectionStatus = "checking" | "connected" | "token_expired" | "error";

export function ConnectionBadge({ refreshKey = 0 }: { refreshKey?: number }) {
  const [status, setStatus] = useState<ConnectionStatus>("checking");
  const [message, setMessage] = useState("");

  useEffect(() => {
    setStatus("checking");
    const url = getBackendHttpUrl();

    fetch(`${url}/status`)
      .then(async (res) => {
        const data = await res.json() as { status: string; message?: string };
        if (data.status === "connected") {
          setStatus("connected");
          setMessage("Dhan connected");
        } else if (data.status === "token_expired") {
          setStatus("token_expired");
          setMessage("Token expired");
        } else {
          setStatus("error");
          setMessage(data.message ?? "Connection error");
        }
      })
      .catch(() => {
        setStatus("error");
        setMessage("Backend unreachable");
      });
  }, [refreshKey]);

  const config = {
    checking: { dot: "bg-gray-400 animate-pulse", text: "text-gray-400", label: "Checking..." },
    connected: { dot: "bg-emerald-400", text: "text-emerald-400", label: message },
    token_expired: { dot: "bg-amber-400", text: "text-amber-400", label: message },
    error: { dot: "bg-red-400", text: "text-red-400", label: message },
  }[status];

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={`inline-block w-2 h-2 rounded-full ${config.dot}`} />
      <span className={config.text}>{config.label}</span>
    </div>
  );
}
