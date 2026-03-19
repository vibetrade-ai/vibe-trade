import type Anthropic from "@anthropic-ai/sdk";
import type { Trigger, TriggerStatus, PendingApproval, ApprovalStatus, TriggerAuditEntry } from "../heartbeat/types.js";

export type StrategyState = "scanning" | "accumulating" | "holding" | "exiting" | "paused";
export type StrategyStatus = "active" | "archived";

export interface Strategy {
  id: string;
  name: string;
  description: string;
  plan: string;
  state: StrategyState;
  status: StrategyStatus;
  createdAt: string;
  updatedAt: string;
}

export type PortfolioStatus = "active" | "paused" | "archived";

export interface Portfolio {
  id: string;
  name: string;
  description: string;
  allocation: number;
  benchmark?: string;
  strategyIds: string[];
  status: PortfolioStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PortfolioStore {
  list(filter?: { status?: PortfolioStatus | PortfolioStatus[] }): Promise<Portfolio[]>;
  get(id: string): Promise<Portfolio | null>;
  upsert(portfolio: Portfolio): Promise<void>;
  setStatus(id: string, status: PortfolioStatus): Promise<void>;
  addStrategy(portfolioId: string, strategyId: string): Promise<void>;
  removeStrategy(portfolioId: string, strategyId: string): Promise<void>;
}

export interface StrategyStore {
  list(filter?: { status?: StrategyStatus }): Promise<Strategy[]>;
  get(id: string): Promise<Strategy | null>;
  upsert(strategy: Strategy): Promise<void>;
  setStatus(id: string, status: StrategyStatus): Promise<void>;
  setState(id: string, state: StrategyState): Promise<void>;
  updatePlan(id: string, plan: string): Promise<void>;
}

export interface ConversationMeta {
  id: string;
  title: string;
  updatedAt: Date;
}

export interface ConversationStore {
  load(conversationId: string): Promise<Anthropic.MessageParam[]>;
  append(conversationId: string, messages: Anthropic.MessageParam[]): Promise<void>;
  list(): Promise<ConversationMeta[]>;
}

export interface MemoryStore {
  read(): Promise<string>;
  write(content: string): Promise<void>;
}

export interface TriggerStore {
  list(filter?: { status?: TriggerStatus | TriggerStatus[] }): Promise<Trigger[]>;
  get(id: string): Promise<Trigger | null>;
  upsert(trigger: Trigger): Promise<void>;
  setStatus(id: string, status: TriggerStatus, extra?: Partial<Trigger>): Promise<void>;
  updateNextFireAt(id: string, nextFireAt: string, lastFiredAt?: string): Promise<void>;
  pruneExpired(): Promise<void>;
}

export interface ApprovalStore {
  list(filter?: { status?: ApprovalStatus }): Promise<PendingApproval[]>;
  get(id: string): Promise<PendingApproval | null>;
  add(approval: PendingApproval): Promise<void>;
  updateStatus(id: string, status: ApprovalStatus, decidedAt?: string): Promise<void>;
  pruneExpired(): Promise<void>;
}

export interface TriggerAuditStore {
  append(entry: TriggerAuditEntry): Promise<void>;
  list(): Promise<TriggerAuditEntry[]>;
}

export type TradeStatus = "pending" | "filled" | "cancelled" | "rejected";

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
  status: TradeStatus;
  strategyId?: string;
  portfolioId?: string;
  note?: string;
  realizedPnl?: number;
  createdAt: string;
  filledAt?: string;
  rejectionReason?: string;
}

export interface TradeStore {
  append(trade: TradeRecord): Promise<void>;
  list(filter?: {
    strategyId?: string;
    portfolioId?: string;
    symbol?: string;
    fromDate?: string;
    toDate?: string;
    status?: TradeStatus;
  }): Promise<TradeRecord[]>;
  get(id: string): Promise<TradeRecord | null>;
  update(id: string, patch: Partial<TradeRecord>): Promise<void>;
}

export interface CredentialsStore {
  read(): Promise<Record<string, string> | null>;
  write(data: Record<string, string>): Promise<void>;
}

export interface StorageProvider {
  conversations: ConversationStore;
  memory: MemoryStore;
  triggers: TriggerStore;
  approvals: ApprovalStore;
  triggerAudit: TriggerAuditStore;
  strategies: StrategyStore;
  trades: TradeStore;
  credentials: CredentialsStore;
  portfolios: PortfolioStore;
}
