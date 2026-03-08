export type TriggerScope = "symbol" | "market" | "portfolio";
export type TriggerStatus = "active" | "fired" | "expired" | "cancelled";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface TradeArgs {
  symbol: string;
  transaction_type: "BUY" | "SELL";
  quantity: number;
  order_type: "MARKET" | "LIMIT";
  price?: number;
}

export type TriggerCondition =
  | { mode: "code"; expression: string }
  | { mode: "llm"; description: string }
  | { mode: "time"; fireAt: string };

export type TriggerAction =
  | { type: "reasoning_job" }
  | { type: "hard_order"; tradeArgs: TradeArgs };

export interface Trigger {
  id: string;
  name: string;
  scope: TriggerScope;
  watchSymbols: string[];
  condition: TriggerCondition;
  action: TriggerAction;
  expiresAt?: string;
  createdAt: string;
  active: boolean;
  status: TriggerStatus;
  firedAt?: string;
  outcomeId?: string;
}

export interface QuoteEntry {
  symbol: string;
  securityId: string;
  lastPrice: number;
  previousClose: number;
  changePercent: number;
  open: number;
  high: number;
  low: number;
}

export interface PositionEntry {
  symbol: string;
  quantity: number;
  avgCostPrice: number;
  lastPrice: number;
  unrealizedPnl: number;
  pnlPercent: number;
}

export interface SystemSnapshot {
  capturedAt: string;
  marketStatus: { phase: string; istTime: string };
  quotes: Record<string, QuoteEntry>;
  positions: PositionEntry[];
  funds: { availableBalance: number; usedMargin: number } | null;
  nifty50: QuoteEntry | null;
  banknifty: QuoteEntry | null;
}

export type PendingApproval =
  | {
      id: string;
      kind: "trade";
      triggerId: string;
      triggerName: string;
      reasoning: string;
      tradeArgs: TradeArgs;
      status: ApprovalStatus;
      createdAt: string;
      expiresAt: string;
      decidedAt?: string;
    }
  | {
      id: string;
      kind: "hard_trigger";
      originatingTriggerId: string;
      originatingTriggerName: string;
      reasoning: string;
      proposedTrigger: Omit<Trigger, "id" | "createdAt" | "active">;
      status: ApprovalStatus;
      createdAt: string;
      expiresAt: string;
      decidedAt?: string;
    };

export interface TriggerAuditEntry {
  id: string;
  triggerId: string;
  triggerName: string;
  firedAt: string;
  snapshotAtFire: SystemSnapshot;
  action: TriggerAction;
  outcome:
    | { type: "hard_order_placed"; orderId: string }
    | { type: "hard_order_failed"; error: string }
    | { type: "reasoning_job_queued"; approvalId?: string }
    | { type: "reasoning_job_no_action"; reason: string };
}
