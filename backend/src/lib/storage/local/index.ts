import type { StorageProvider } from "../types.js";
import { LocalConversationStore } from "./conversation-store.js";
import { LocalMemoryStore } from "./memory-store.js";
import { LocalTriggerStore } from "./trigger-store.js";
import { LocalApprovalStore } from "./approval-store.js";
import { LocalTriggerAuditStore } from "./trigger-audit-store.js";
import { LocalStrategyStore } from "./strategy-store.js";
import { LocalTradeStore } from "./trade-store.js";
import { LocalCredentialsStore } from "./credentials-store.js";

export class LocalStorageProvider implements StorageProvider {
  conversations: LocalConversationStore;
  memory: LocalMemoryStore;
  triggers: LocalTriggerStore;
  approvals: LocalApprovalStore;
  triggerAudit: LocalTriggerAuditStore;
  strategies: LocalStrategyStore;
  trades: LocalTradeStore;
  credentials: LocalCredentialsStore;

  constructor(dataDir: string) {
    this.conversations = new LocalConversationStore(dataDir);
    this.memory = new LocalMemoryStore(dataDir);
    this.triggers = new LocalTriggerStore(dataDir);
    this.approvals = new LocalApprovalStore(dataDir);
    this.triggerAudit = new LocalTriggerAuditStore(dataDir);
    this.strategies = new LocalStrategyStore(dataDir);
    this.trades = new LocalTradeStore(dataDir);
    this.credentials = new LocalCredentialsStore(dataDir);
  }
}
