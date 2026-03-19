import type { StorageProvider } from "./types.js";
import { LocalStorageProvider } from "./local/index.js";
import { getDataDir } from "../data-dir.js";

export { type StorageProvider } from "./types.js";
export { type ConversationStore } from "./types.js";
export { type MemoryStore } from "./types.js";
export { type TriggerStore } from "./types.js";
export { type ApprovalStore } from "./types.js";
export { type TriggerAuditStore } from "./types.js";
export { type StrategyStore } from "./types.js";
export { type Strategy, type StrategyState, type StrategyStatus } from "./types.js";
export { type TradeStore } from "./types.js";
export { type TradeRecord, type TradeStatus } from "./types.js";
export { type CredentialsStore } from "./types.js";
export { type PortfolioStore, type Portfolio, type PortfolioStatus } from "./types.js";

export function createStorageProvider(): StorageProvider {
  // Later: if (process.env.DATABASE_URL) return new DatabaseStorageProvider(...)
  return new LocalStorageProvider(getDataDir());
}
