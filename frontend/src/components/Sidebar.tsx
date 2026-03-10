"use client";

import { useEffect, useState, useCallback } from "react";
import { getBackendHttpUrl } from "@/lib/backend-url";

interface ConversationMeta {
  id: string;
  title: string;
  updatedAt: string; // ISO string from JSON serialisation
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (diffDays < 7) {
    return date.toLocaleDateString([], { weekday: "short" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

interface SidebarProps {
  conversationId: string | null;
  onSwitch: (id: string) => void;
  onNew: () => void;
  /** Increment to trigger a refresh of the conversation list */
  refreshKey: number;
}

export function Sidebar({ conversationId, onSwitch, onNew, refreshKey }: SidebarProps) {
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);

  const fetchList = useCallback(async () => {
    try {
      const url = getBackendHttpUrl();
      const res = await fetch(`${url}/api/conversations`);
      if (res.ok) {
        setConversations(await res.json() as ConversationMeta[]);
      }
    } catch {
      // backend unreachable — keep existing list
    }
  }, []);

  useEffect(() => {
    fetchList();
  }, [fetchList, refreshKey]);

  return (
    <aside className="w-60 flex-shrink-0 flex flex-col bg-gray-900 border-r border-gray-800 h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-3 border-b border-gray-800">
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Chats</span>
        <button
          onClick={onNew}
          title="New chat"
          className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
          </svg>
        </button>
      </div>

      {/* List */}
      <nav className="flex-1 overflow-y-auto py-1">
        {conversations.length === 0 ? (
          <p className="px-3 py-4 text-xs text-gray-600 text-center">No conversations yet</p>
        ) : (
          conversations.map((conv) => {
            const isActive = conv.id === conversationId;
            return (
              <button
                key={conv.id}
                onClick={() => onSwitch(conv.id)}
                className={`w-full text-left px-3 py-2.5 flex flex-col gap-0.5 transition-colors ${
                  isActive
                    ? "bg-gray-700/80 text-white"
                    : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"
                }`}
              >
                <span className="text-xs font-medium truncate leading-snug">
                  {conv.title}
                </span>
                <span className="text-[12px] font-semibold text-gray-600">
                  {formatDate(conv.updatedAt)}
                </span>
              </button>
            );
          })
        )}
      </nav>

      {/* Bottom avatar */}
      <div className="flex-shrink-0 px-3 py-3 border-t border-gray-800">
        <img src="/logo-icon.png" alt="VibeTrade" className="w-8 h-8 rounded-full object-cover" />
      </div>
    </aside>
  );
}
