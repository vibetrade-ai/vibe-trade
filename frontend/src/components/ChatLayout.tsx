"use client";

import { useCallback, useEffect, useState } from "react";
import { Chat } from "./Chat";
import { Sidebar } from "./Sidebar";
import { ConnectionBadge } from "./ConnectionBadge";
import { ApprovalsPanel } from "./ApprovalsPanel";
import { TriggersPanel } from "./TriggersPanel";
import { useApprovals } from "../hooks/useApprovals";

type Tab = "chat" | "approvals" | "triggers";

function PendingBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="ml-1.5 inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white text-[10px] font-bold leading-none">
      {count > 9 ? "9+" : count}
    </span>
  );
}

export function ChatLayout() {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [sidebarRefreshKey, setSidebarRefreshKey] = useState(0);
  const [activeTab, setActiveTab] = useState<Tab>("chat");

  const { pendingCount } = useApprovals();

  // Initialise conversationId from localStorage on first client render
  useEffect(() => {
    let id = localStorage.getItem("conversationId");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("conversationId", id);
    }
    setConversationId(id);
    setSidebarRefreshKey((k) => k + 1);
  }, []);

  const handleSwitch = useCallback((id: string) => {
    localStorage.setItem("conversationId", id);
    setConversationId(id);
  }, []);

  const handleNew = useCallback(() => {
    const newId = crypto.randomUUID();
    localStorage.setItem("conversationId", newId);
    setConversationId(newId);
  }, []);

  const handleTurnComplete = useCallback(() => {
    // Refresh sidebar so newly created conversations appear and titles update
    setSidebarRefreshKey((k) => k + 1);
  }, []);

  const tabs: { id: Tab; label: string }[] = [
    { id: "chat", label: "Chat" },
    { id: "approvals", label: "Approvals" },
    { id: "triggers", label: "Triggers" },
  ];

  return (
    <div className="flex h-screen">
      <Sidebar
        conversationId={conversationId}
        onSwitch={handleSwitch}
        onNew={handleNew}
        refreshKey={sidebarRefreshKey}
      />

      {/* Main pane */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="flex items-center justify-between px-6 py-4 border-b border-gray-800 flex-shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-xl font-bold text-white tracking-tight">VibeTrade</span>
            <span className="text-xs text-gray-500 hidden sm:block">AI-powered broker</span>
          </div>
          <ConnectionBadge />
        </header>

        {/* Tab bar */}
        <div className="flex border-b border-gray-800 px-4 flex-shrink-0 bg-gray-900/50">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center px-4 py-3 text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? "border-b-2 border-blue-500 text-white -mb-px"
                  : "text-gray-400 hover:text-gray-300"
              }`}
            >
              {tab.label}
              {tab.id === "approvals" && <PendingBadge count={pendingCount} />}
            </button>
          ))}
        </div>

        {/* Panel area */}
        <main className="flex-1 overflow-hidden flex flex-col">
          {/* Chat: always mounted (preserves WebSocket), hidden when not active */}
          <div className={activeTab === "chat" ? "flex-1 overflow-hidden" : "hidden"}>
            <Chat conversationId={conversationId} onTurnComplete={handleTurnComplete} />
          </div>

          {/* Approvals panel */}
          {activeTab === "approvals" && (
            <div className="flex-1 overflow-hidden flex flex-col">
              <ApprovalsPanel />
            </div>
          )}

          {/* Triggers panel */}
          {activeTab === "triggers" && (
            <div className="flex-1 overflow-hidden flex flex-col">
              <TriggersPanel />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
