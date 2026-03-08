import type Anthropic from "@anthropic-ai/sdk";
import type { Trigger, TriggerStatus, PendingApproval, ApprovalStatus, TriggerAuditEntry } from "../heartbeat/types.js";

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
  list(filter?: { status?: TriggerStatus }): Promise<Trigger[]>;
  get(id: string): Promise<Trigger | null>;
  upsert(trigger: Trigger): Promise<void>;
  setStatus(id: string, status: TriggerStatus, extra?: Partial<Trigger>): Promise<void>;
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

export interface StorageProvider {
  conversations: ConversationStore;
  memory: MemoryStore;
  triggers: TriggerStore;
  approvals: ApprovalStore;
  triggerAudit: TriggerAuditStore;
}
