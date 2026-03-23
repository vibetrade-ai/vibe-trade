const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export function getWsUrl(): string {
  return API_URL.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");
}

export type IntentType = "atomic" | "conditional" | "scheduled" | "agentic" | "composite";
export type IntentStatus = "processing" | "clarifying" | "planning" | "active" | "completed" | "failed" | "cancelled";

export interface ClarificationOption {
  value: string;
  label: string;
  recommended?: boolean;
}

export interface ClarificationQuestion {
  id: string;
  question: string;
  options: ClarificationOption[];
}

export interface IntentPrimitive {
  type: "order" | "trigger" | "portfolio" | "strategy";
  id: string;
  trigger?: { name: string; status: string; nextFireAt?: string; scheduledAt?: string; lastFiredAt?: string } | null;
  portfolio?: { name: string; allocation: number; status: string } | null;
  strategy?: { name: string } | null;
  trade?: { symbol: string; status: string; quantity: number; transactionType?: string; executedPrice?: number } | null;
}

export interface OpenPosition {
  symbol: string;
  securityId: string;
  quantity: number;
  avgBuyPrice: number;
  deployedCapital: number;
  ltp?: number;
  unrealizedPnl?: number;
}

export interface TradeRecord {
  id: string;
  orderId: string;
  symbol: string;
  securityId: string;
  transactionType: "BUY" | "SELL";
  quantity: number;
  orderType: "MARKET" | "LIMIT";
  requestedPrice?: number;
  executedPrice?: number;
  status: "pending" | "filled" | "cancelled" | "rejected";
  strategyId?: string;
  portfolioId?: string;
  intentId?: string;
  note?: string;
  realizedPnl?: number;
  createdAt: string;
  filledAt?: string;
  rejectionReason?: string;
}

export interface IntentPerformance {
  intentId: string;
  portfolioId?: string;
  allocation?: number;
  deployedCapital: number;
  availableCapital?: number;
  trades: TradeRecord[];
  openPositions: OpenPosition[];
  realizedPnl: number;
  unrealizedPnl: number;
  tradeCount: number;
}

export interface Intent {
  id: string;
  text: string;
  type?: IntentType;
  status: IntentStatus;
  summary?: string;
  entryCondition?: string;
  exitCondition?: string;
  primitives: IntentPrimitive[];
  portfolioId?: string;
  clarifications?: ClarificationQuestion[];
  plan?: string;
  planSummary?: string;
  planFeedback?: string;
  createdAt: string;
  resolvedAt?: string;
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface PendingApproval {
  id: string;
  kind: "trade" | "hard_trigger";
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  reasoning: string;
  // trade specific
  triggerId?: string;
  triggerName?: string;
  tradeArgs?: {
    symbol: string;
    transaction_type: "BUY" | "SELL";
    quantity: number;
    order_type: "MARKET" | "LIMIT";
    price?: number;
  };
  // hard_trigger specific
  originatingTriggerId?: string;
  originatingTriggerName?: string;
  proposedTrigger?: Record<string, unknown>;
}

export interface Portfolio {
  id: string;
  name: string;
  allocation: number;
  deployedCapital: number;
  availableCapital: number;
  status: string;
  intentId?: string;
  createdAt: string;
}

export interface PortfolioPerformance {
  portfolioId: string;
  allocation?: number;
  deployedCapital: number;
  availableCapital?: number;
  totalRealizedPnl: number;
  unrealizedPnl: number;
  winRate?: number;
  openPositions: OpenPosition[];
  bestTrade?: TradeRecord;
  worstTrade?: TradeRecord;
  totalTrades: number;
  trades: TradeRecord[];
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (init?.body != null) headers["Content-Type"] = "application/json";
  const res = await fetch(`${API_URL}${path}`, { headers, ...init });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${path} failed (${res.status}): ${body}`);
  }
  return res.json() as Promise<T>;
}

export interface ConversationMeta {
  id: string;
  title: string;
  updatedAt: string;
}

export interface MessageView {
  role: "user" | "assistant" | "tool";
  text: string;
  toolName?: string;
}

export const api = {
  conversations: {
    list: () => apiFetch<ConversationMeta[]>("/api/conversations"),
    getMessages: (id: string) => apiFetch<MessageView[]>(`/api/conversations/${id}/messages`),
  },
  intents: {
    create: (text: string) =>
      apiFetch<{ intentId: string }>("/api/intents", {
        method: "POST",
        body: JSON.stringify({ text }),
      }),
    list: (status?: string) =>
      apiFetch<Intent[]>(`/api/intents${status ? `?status=${status}` : ""}`),
    get: (id: string) => apiFetch<Intent>(`/api/intents/${id}`),
    cancel: (id: string) =>
      apiFetch<{ ok: boolean }>(`/api/intents/${id}`, { method: "DELETE" }),
    clarify: (id: string, answers: Record<string, string>) =>
      apiFetch<{ ok: boolean }>(`/api/intents/${id}/clarify`, {
        method: "POST",
        body: JSON.stringify({ answers }),
      }),
    getPerformance: (id: string) =>
      apiFetch<IntentPerformance>(`/api/intents/${id}/performance`),
    approvePlan: (id: string, approved: boolean, feedback?: string) =>
      apiFetch<{ ok: boolean }>(`/api/intents/${id}/approve-plan`, {
        method: "POST",
        body: JSON.stringify({ approved, feedback }),
      }),
  },
  approvals: {
    list: (status?: string) =>
      apiFetch<PendingApproval[]>(`/api/approvals${status ? `?status=${status}` : ""}`),
    decide: (id: string, decision: "approved" | "rejected") =>
      apiFetch<{ ok: boolean }>(`/api/approvals/${id}/decide`, {
        method: "POST",
        body: JSON.stringify({ decision }),
      }),
  },
  portfolios: {
    list: () => apiFetch<Portfolio[]>("/api/portfolios"),
    getPerformance: (id: string) =>
      apiFetch<PortfolioPerformance>(`/api/portfolios/${id}/performance`),
    getTrades: (id: string) =>
      apiFetch<TradeRecord[]>(`/api/portfolios/${id}/trades`),
  },
  settings: {
    getStatus: () =>
      apiFetch<{ status: Record<string, boolean>; allConfigured: boolean }>("/api/settings"),
    save: (patch: Record<string, string>) =>
      apiFetch<{ success: boolean; status: Record<string, boolean> }>("/api/settings", {
        method: "POST",
        body: JSON.stringify(patch),
      }),
    getBrokerStatus: () =>
      apiFetch<{ configured: boolean; connected: boolean; expired: boolean; error?: string }>("/api/settings/broker-status"),
  },
};
