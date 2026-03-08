"use client";

import { useCallback, useEffect, useState } from "react";
import { Chat } from "./Chat";
import { Sidebar } from "./Sidebar";
import { ConnectionBadge } from "./ConnectionBadge";

export function ChatLayout() {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [sidebarRefreshKey, setSidebarRefreshKey] = useState(0);

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

        {/* Chat takes remaining height */}
        <main className="flex-1 overflow-hidden">
          <Chat conversationId={conversationId} onTurnComplete={handleTurnComplete} />
        </main>
      </div>
    </div>
  );
}
