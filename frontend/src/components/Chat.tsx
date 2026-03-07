"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ApprovalCard } from "./ApprovalCard";

type Role = "user" | "assistant" | "system";

interface ApprovalRequest {
  requestId: string;
  tool: string;
  args: Record<string, unknown>;
  description: string;
}

interface ChatItem {
  id: string;
  role: Role;
  content: string;
  approval?: ApprovalRequest;
  approvalState?: "pending" | "approved" | "denied";
  toolName?: string;
  toolResult?: string;
  toolIsError?: boolean;
}

type ServerMessage =
  | { type: "text_delta"; content: string }
  | { type: "tool_use_start"; tool: string; args: object }
  | { type: "tool_use_result"; tool: string; result: string; isError: boolean }
  | { type: "tool_approval_request"; requestId: string; tool: string; args: object; description: string }
  | { type: "done" }
  | { type: "token_expired" }
  | { type: "error"; message: string };

function uid() {
  return Math.random().toString(36).slice(2);
}

function AssistantMessage({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
        ul: ({ children }) => <ul className="list-disc pl-4 mb-2 space-y-0.5">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal pl-4 mb-2 space-y-0.5">{children}</ol>,
        li: ({ children }) => <li className="text-gray-100">{children}</li>,
        strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
        em: ({ children }) => <em className="italic text-gray-300">{children}</em>,
        code: ({ children, className }) => {
          const isBlock = className?.includes("language-");
          return isBlock ? (
            <code className="block bg-gray-900 rounded-lg px-3 py-2 text-xs font-mono text-green-300 overflow-x-auto my-2 whitespace-pre">
              {children}
            </code>
          ) : (
            <code className="bg-gray-900 rounded px-1 py-0.5 text-xs font-mono text-green-300">
              {children}
            </code>
          );
        },
        pre: ({ children }) => <>{children}</>,
        blockquote: ({ children }) => (
          <blockquote className="border-l-2 border-gray-600 pl-3 text-gray-400 italic my-2">
            {children}
          </blockquote>
        ),
        table: ({ children }) => (
          <div className="overflow-x-auto my-2">
            <table className="text-xs border-collapse w-full">{children}</table>
          </div>
        ),
        thead: ({ children }) => <thead className="bg-gray-900">{children}</thead>,
        th: ({ children }) => (
          <th className="border border-gray-700 px-3 py-1.5 text-left text-gray-300 font-semibold">
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td className="border border-gray-700 px-3 py-1.5 text-gray-200">{children}</td>
        ),
        tr: ({ children }) => <tr className="even:bg-gray-900/40">{children}</tr>,
        h1: ({ children }) => <h1 className="text-base font-bold text-white mb-2 mt-1">{children}</h1>,
        h2: ({ children }) => <h2 className="text-sm font-bold text-white mb-1.5 mt-1">{children}</h2>,
        h3: ({ children }) => <h3 className="text-sm font-semibold text-gray-200 mb-1 mt-1">{children}</h3>,
        a: ({ href, children }) => (
          <a href={href} className="text-blue-400 underline hover:text-blue-300" target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        ),
        hr: () => <hr className="border-gray-700 my-3" />,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

export function Chat() {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [connected, setConnected] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [tokenExpired, setTokenExpired] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const currentAssistantIdRef = useRef<string | null>(null);

  const appendText = useCallback((text: string) => {
    setItems((prev) => {
      const id = currentAssistantIdRef.current;
      if (!id) return prev;
      return prev.map((item) =>
        item.id === id ? { ...item, content: item.content + text } : item
      );
    });
  }, []);

  const addItem = useCallback((item: ChatItem) => {
    setItems((prev) => [...prev, item]);
  }, []);

  useEffect(() => {
    const wsUrl = process.env.NEXT_PUBLIC_BACKEND_WS_URL ?? "ws://localhost:3001";
    const ws = new WebSocket(`${wsUrl}/ws/chat`);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data as string) as ServerMessage;

      switch (msg.type) {
        case "text_delta": {
          if (!currentAssistantIdRef.current) {
            const id = uid();
            currentAssistantIdRef.current = id;
            addItem({ id, role: "assistant", content: "" });
          }
          appendText(msg.content);
          break;
        }
        case "tool_use_start":
          break;
        case "tool_use_result": {
          addItem({
            id: uid(),
            role: "system",
            content: "",
            toolName: msg.tool,
            toolResult: msg.result,
            toolIsError: msg.isError,
          });
          break;
        }
        case "tool_approval_request": {
          addItem({
            id: uid(),
            role: "system",
            content: "",
            approval: {
              requestId: msg.requestId,
              tool: msg.tool,
              args: msg.args as Record<string, unknown>,
              description: msg.description,
            },
            approvalState: "pending",
          });
          break;
        }
        case "done": {
          currentAssistantIdRef.current = null;
          setThinking(false);
          break;
        }
        case "token_expired": {
          setTokenExpired(true);
          break;
        }
        case "error": {
          currentAssistantIdRef.current = null;
          setThinking(false);
          addItem({ id: uid(), role: "system", content: msg.message });
          break;
        }
      }
    };

    return () => ws.close();
  }, [addItem, appendText]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [items]);

  const sendMessage = useCallback(() => {
    const text = input.trim();
    if (!text || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    const id = uid();
    addItem({ id, role: "user", content: text });
    setInput("");
    setThinking(true);
    currentAssistantIdRef.current = null;

    wsRef.current.send(
      JSON.stringify({
        type: "message",
        messages: [{ role: "user", content: text }],
      })
    );
  }, [input, addItem, tokenExpired]);

  const handleApprove = useCallback((requestId: string) => {
    wsRef.current?.send(
      JSON.stringify({ type: "tool_approval_response", requestId, approved: true })
    );
    setItems((prev) =>
      prev.map((item) =>
        item.approval?.requestId === requestId ? { ...item, approvalState: "approved" } : item
      )
    );
  }, []);

  const handleDeny = useCallback((requestId: string) => {
    wsRef.current?.send(
      JSON.stringify({ type: "tool_approval_response", requestId, approved: false })
    );
    setItems((prev) =>
      prev.map((item) =>
        item.approval?.requestId === requestId ? { ...item, approvalState: "denied" } : item
      )
    );
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const isDisabled = !connected || thinking;

  return (
    <div className="flex flex-col h-full">
      {/* Token expired banner */}
      {tokenExpired && (
        <div className="flex items-center gap-3 px-4 py-3 bg-amber-950/60 border-b border-amber-800/50 text-sm">
          <span className="text-amber-400 text-base flex-shrink-0">⚠</span>
          <div>
            <p className="text-amber-300 font-medium">Dhan token expired</p>
            <p className="text-amber-500 text-xs mt-0.5">
              Update <code className="font-mono bg-amber-950 px-1 rounded">DHAN_ACCESS_TOKEN</code> in{" "}
              <code className="font-mono bg-amber-950 px-1 rounded">backend/.env</code> and restart the server.
            </p>
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6 space-y-3">
        {items.length === 0 && (
          <div className="text-center text-gray-500 text-sm mt-20">
            <div className="text-3xl mb-4">📈</div>
            <p className="font-medium text-gray-400 text-base mb-1">VibeTrade is ready</p>
            <p className="text-gray-600">Ask about market prices, your positions, or place trades.</p>
          </div>
        )}

        {items.map((item) => {
          // Approval card
          if (item.approval) {
            if (item.approvalState === "pending") {
              return (
                <ApprovalCard
                  key={item.id}
                  requestId={item.approval.requestId}
                  tool={item.approval.tool}
                  args={item.approval.args}
                  description={item.approval.description}
                  onApprove={handleApprove}
                  onDeny={handleDeny}
                />
              );
            }
            return (
              <div key={item.id} className="flex items-center gap-1.5 text-xs text-gray-600 pl-1">
                <span className={item.approvalState === "approved" ? "text-emerald-600" : "text-gray-600"}>
                  {item.approvalState === "approved" ? "✓" : "✗"}
                </span>
                <span>
                  {item.approvalState === "approved" ? "Approved" : "Denied"}: {item.approval.description}
                </span>
              </div>
            );
          }

          // Tool result (collapsible)
          if (item.toolName) {
            const isError = item.toolIsError;
            return (
              <details key={item.id} className="text-xs pl-1 group" open={isError}>
                <summary className={`cursor-pointer list-none flex items-center gap-1.5 transition-colors select-none ${isError ? "text-red-500 hover:text-red-400" : "text-gray-600 hover:text-gray-400"}`}>
                  <span className="transition-transform group-open:rotate-90 inline-block">▶</span>
                  {isError && <span>⚠</span>}
                  <span className="font-mono">{item.toolName}</span>
                  {isError && <span className="text-red-600">— failed</span>}
                </summary>
                <pre className={`mt-1.5 ml-4 p-3 border rounded-lg overflow-x-auto max-h-48 text-xs leading-relaxed ${isError ? "bg-red-950/30 border-red-900/40 text-red-400" : "bg-gray-900/80 border-gray-800 text-gray-400"}`}>
                  {item.toolResult}
                </pre>
              </details>
            );
          }

          // System error
          if (item.role === "system") {
            return (
              <div key={item.id} className="flex justify-start pl-1">
                <div className="flex items-start gap-2 text-xs text-red-400 bg-red-950/40 border border-red-900/40 rounded-lg px-3 py-2 max-w-md">
                  <span className="flex-shrink-0 mt-0.5">⚠</span>
                  <span>{item.content}</span>
                </div>
              </div>
            );
          }

          // User message
          if (item.role === "user") {
            return (
              <div key={item.id} className="flex justify-end">
                <div className="max-w-[75%] bg-blue-600 text-white rounded-2xl rounded-br-sm px-4 py-2.5 text-sm leading-relaxed">
                  {item.content}
                </div>
              </div>
            );
          }

          // Assistant message — markdown rendered
          return (
            <div key={item.id} className="flex justify-start">
              <div className="max-w-[80%] bg-gray-800/80 text-gray-100 rounded-2xl rounded-bl-sm px-4 py-3 text-sm leading-relaxed">
                {item.content ? (
                  <AssistantMessage content={item.content} />
                ) : (
                  <span className="inline-block w-1.5 h-4 bg-gray-400 animate-pulse rounded-sm align-middle" />
                )}
              </div>
            </div>
          );
        })}

        {thinking && !currentAssistantIdRef.current && (
          <div className="flex justify-start">
            <div className="bg-gray-800/80 rounded-2xl rounded-bl-sm px-4 py-3">
              <span className="flex gap-1 items-center">
                <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
              </span>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input bar */}
      <div className="border-t border-gray-800/60 bg-gray-950 px-4 py-4">
        <div className="flex gap-2 items-end max-w-3xl mx-auto">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={connected ? "Message VibeTrade..." : "Connecting to backend..."}
            disabled={isDisabled}
            rows={1}
            className="flex-1 resize-none rounded-xl bg-gray-800 border border-gray-700 text-gray-100 placeholder-gray-500 px-4 py-3 text-sm focus:outline-none focus:border-blue-500/60 focus:ring-1 focus:ring-blue-500/20 transition-all disabled:opacity-40 disabled:cursor-not-allowed leading-relaxed"
            style={{ minHeight: "48px", maxHeight: "160px" }}
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = "auto";
              el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
            }}
          />
          <button
            onClick={sendMessage}
            disabled={isDisabled || !input.trim()}
            className="rounded-xl bg-blue-600 hover:bg-blue-500 active:scale-95 disabled:bg-gray-800 disabled:text-gray-600 disabled:cursor-not-allowed text-white w-11 h-11 flex items-center justify-center transition-all flex-shrink-0"
            title="Send (Enter)"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 rotate-90">
              <path d="M3.105 2.289a.75.75 0 00-.826.95l1.414 4.925A1.5 1.5 0 005.135 9.25h6.115a.75.75 0 010 1.5H5.135a1.5 1.5 0 00-1.442 1.086l-1.414 4.926a.75.75 0 00.826.95 28.896 28.896 0 0015.293-7.154.75.75 0 000-1.115A28.897 28.897 0 003.105 2.289z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
