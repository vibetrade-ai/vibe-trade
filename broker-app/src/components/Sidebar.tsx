"use client";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { api, type ConversationMeta } from "@/lib/api";

const NAV_ITEMS = [
  {
    path: "/",
    label: "Chat",
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M14 2H2C1.45 2 1 2.45 1 3v8c0 .55.45 1 1 1h2v2l3-2h7c.55 0 1-.45 1-1V3c0-.55-.45-1-1-1z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
      </svg>
    ),
  },
  {
    path: "/dashboard",
    label: "Dashboard",
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="1" y="1" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
        <rect x="9" y="1" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
        <rect x="1" y="9" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
        <rect x="9" y="9" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
      </svg>
    ),
  },
  {
    path: "/autopilots",
    label: "Autopilots",
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5"/>
        <path d="M8 5v3l2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      </svg>
    ),
  },
  {
    path: "/approvals",
    label: "Approvals",
    badge: true,
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M8 1L10.06 5.26L14.5 5.97L11.25 9.14L12.11 13.56L8 11.37L3.89 13.56L4.75 9.14L1.5 5.97L5.94 5.26L8 1Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
      </svg>
    ),
  },
  {
    path: "/settings",
    label: "Settings",
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.5"/>
        <path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M2.93 2.93l1.06 1.06M12.01 12.01l1.06 1.06M13.07 2.93l-1.06 1.06M3.99 12.01l-1.06 1.06" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      </svg>
    ),
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const [pendingCount, setPendingCount] = useState(0);
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);

  // Poll pending approvals count
  useEffect(() => {
    const fetchCount = async () => {
      try {
        const data = await api.approvals.list("pending");
        setPendingCount(data.length);
      } catch {
        // ignore
      }
    };
    void fetchCount();
    const interval = setInterval(() => void fetchCount(), 10000);
    return () => clearInterval(interval);
  }, []);

  // Load conversations from server
  useEffect(() => {
    const fetchConversations = async () => {
      try {
        const data = await api.conversations.list();
        setConversations(data);
      } catch {
        // ignore
      }
    };
    void fetchConversations();
    const interval = setInterval(() => void fetchConversations(), 10000);
    return () => clearInterval(interval);
  }, []);

  // Track active conversation from localStorage
  useEffect(() => {
    const update = () => {
      setActiveConversationId(localStorage.getItem("chat:conversationId"));
    };
    update();
    window.addEventListener("storage", update);
    return () => window.removeEventListener("storage", update);
  }, []);

  return (
    <aside style={{
      width: "268px",
      flexShrink: 0,
      height: "100vh",
      background: "white",
      borderRight: "1px solid var(--gray-200)",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
    }}>
      {/* Logo */}
      <div style={{
        padding: "20px 20px 16px",
        display: "flex",
        alignItems: "center",
        gap: "10px",
        borderBottom: "1px solid var(--gray-100)",
      }}>
        <div style={{
          width: "34px",
          height: "34px",
          borderRadius: "10px",
          background: "var(--gray-900)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}>
          <span style={{
            color: "white",
            fontSize: "15px",
            fontFamily: "var(--font-serif)",
            fontStyle: "italic",
            fontWeight: "400",
          }}>
            Vt
          </span>
        </div>
        <span style={{
          fontWeight: "700",
          fontSize: "15px",
          color: "var(--gray-900)",
          letterSpacing: "-0.02em",
        }}>
          VibeTrade
        </span>
      </div>

      {/* Nav */}
      <nav style={{ padding: "12px 12px 0" }}>
        {NAV_ITEMS.map(item => {
          const isActive = item.path === "/" ? pathname === "/" : pathname.startsWith(item.path);
          return (
            <a
              key={item.path}
              href={item.path}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                padding: "9px 12px",
                borderRadius: "var(--radius-xs)",
                textDecoration: "none",
                fontSize: "14px",
                fontWeight: "500",
                color: isActive ? "white" : "var(--gray-600)",
                background: isActive ? "var(--gray-900)" : "transparent",
                marginBottom: "2px",
                transition: "background 0.15s, color 0.15s",
                position: "relative",
              }}
            >
              <span style={{ color: isActive ? "white" : "var(--gray-500)", flexShrink: 0 }}>
                {item.icon}
              </span>
              <span style={{ flex: 1 }}>{item.label}</span>
              {item.badge && pendingCount > 0 && (
                <span style={{
                  background: "var(--red)",
                  color: "white",
                  fontSize: "11px",
                  fontWeight: "700",
                  padding: "1px 6px",
                  borderRadius: "999px",
                  minWidth: "18px",
                  textAlign: "center",
                }}>
                  {pendingCount}
                </span>
              )}
            </a>
          );
        })}
      </nav>

      {/* Recent Chats */}
      <div style={{
        margin: "16px 12px 0",
        borderTop: "1px solid var(--gray-100)",
        paddingTop: "16px",
        flex: 1,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}>
        <p style={{
          fontSize: "11px",
          fontWeight: "600",
          color: "var(--gray-400)",
          letterSpacing: "0.07em",
          textTransform: "uppercase",
          margin: "0 0 8px 4px",
        }}>
          Recent Chats
        </p>
        <div style={{ flex: 1, overflowY: "auto" }}>
          {conversations.length === 0 ? (
            <p style={{ fontSize: "13px", color: "var(--gray-400)", padding: "4px", margin: 0 }}>
              No recent chats
            </p>
          ) : (
            conversations.slice(0, 10).map(convo => {
              const isActive = convo.id === activeConversationId;
              return (
                <a
                  key={convo.id}
                  href={`/?conversationId=${convo.id}`}
                  style={{
                    display: "block",
                    padding: "7px 10px",
                    borderRadius: "var(--radius-xs)",
                    textDecoration: "none",
                    fontSize: "13px",
                    color: isActive ? "var(--gray-900)" : "var(--gray-600)",
                    background: isActive ? "var(--gray-100)" : "transparent",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    marginBottom: "1px",
                    fontWeight: isActive ? "600" : "400",
                  }}
                >
                  {convo.title}
                </a>
              );
            })
          )}
        </div>
      </div>

      {/* User avatar at bottom */}
      <div style={{
        padding: "14px 16px",
        borderTop: "1px solid var(--gray-100)",
        display: "flex",
        alignItems: "center",
        gap: "10px",
      }}>
        <div style={{
          width: "32px",
          height: "32px",
          borderRadius: "50%",
          background: "linear-gradient(135deg, #f97316, #ec4899)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}>
          <span style={{ color: "white", fontSize: "12px", fontWeight: "700" }}>SK</span>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: "13px", fontWeight: "600", color: "var(--gray-800)" }}>Broker</p>
          <p style={{ margin: 0, fontSize: "11px", color: "var(--gray-400)" }}>Dhan · Connected</p>
        </div>
      </div>
    </aside>
  );
}
