"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Chat } from "./Chat";
import { Sidebar } from "./Sidebar";
import { ConnectionBadge } from "./ConnectionBadge";
import { ApprovalsPanel } from "./ApprovalsPanel";
import { TriggersPanel } from "./TriggersPanel";
import { StrategiesPanel } from "./StrategiesPanel";
import { SettingsModal } from "./SettingsModal";
import { SettingsPanel } from "./SettingsPanel";
import { useApprovals } from "../hooks/useApprovals";
import { useSettings } from "../hooks/useSettings";
import { ChatsCircle, CheckCircle, Lightning, GameController, GearSix } from "@phosphor-icons/react";

type Tab = "chat" | "approvals" | "triggers" | "strategies" | "settings";

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
  const { loading: settingsLoading, allConfigured } = useSettings();
  const [showSetupModal, setShowSetupModal] = useState(false);
  const [connectionRefreshKey, setConnectionRefreshKey] = useState(0);

  useEffect(() => {
    if (!settingsLoading && !allConfigured) setShowSetupModal(true);
  }, [settingsLoading, allConfigured]);

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

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "chat", label: "Chat", icon: <ChatsCircle weight="bold" size={16} /> },
    { id: "approvals", label: "Approvals", icon: <CheckCircle weight="bold" size={16} /> },
    { id: "triggers", label: "Triggers", icon: <Lightning weight="bold" size={16} /> },
    { id: "strategies", label: "Strategies", icon: <GameController weight="bold" size={16} /> },
    { id: "settings", label: "Settings", icon: <GearSix weight="bold" size={16} /> },
  ];

  return (
    <>
    {showSetupModal && (
      <SettingsModal
        onSaved={() => { setShowSetupModal(false); setConnectionRefreshKey(k => k + 1); }}
        onSkip={() => setShowSetupModal(false)}
      />
    )}
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
            <img src="/logo-icon.png" alt="VibeTrade" className="h-8 w-8 rounded-full object-cover flex-shrink-0" />
            <img src="/logo-text.png" alt="VibeTrade" className="h-7 object-contain hidden sm:block" />
            <span className="text-xs text-gray-500 hidden sm:block">Your AI Broker</span>
          </div>
          <ConnectionBadge refreshKey={connectionRefreshKey} />
        </header>

        {/* Tab bar */}
        <div className="flex border-b border-gray-800 px-4 flex-shrink-0 bg-gray-900/50">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-4 py-3 text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? "border-b-2 border-[#4DFF4D] text-white -mb-px"
                  : "text-gray-400 hover:text-gray-300"
              }`}
            >
              {tab.icon}
              {tab.label}
              {tab.id === "approvals" && <PendingBadge count={pendingCount} />}
            </button>
          ))}
        </div>

        {/* Panel area */}
        <main className="flex-1 overflow-hidden flex flex-col">
          {/* Chat: always mounted (preserves WebSocket), hidden when not active */}
          <div className={activeTab === "chat" ? "flex-1 overflow-hidden" : "hidden"}>
            <Chat conversationId={conversationId} onTurnComplete={handleTurnComplete} credentialsVersion={connectionRefreshKey} />
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

          {/* Strategies panel */}
          {activeTab === "strategies" && (
            <div className="flex-1 overflow-hidden flex flex-col">
              <StrategiesPanel />
            </div>
          )}

          {/* Settings panel */}
          {activeTab === "settings" && (
            <div className="flex-1 overflow-hidden flex flex-col">
              <SettingsPanel onSaved={() => setConnectionRefreshKey(k => k + 1)} />
            </div>
          )}
        </main>
      </div>
    </div>
    </>
  );
}
