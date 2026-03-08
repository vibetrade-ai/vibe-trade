import fs from "fs";
import path from "path";
import type { StorageProvider } from "./types.js";
import { LocalStorageProvider } from "./local/index.js";

export { type StorageProvider } from "./types.js";
export { type ConversationStore } from "./types.js";
export { type MemoryStore } from "./types.js";
export { type TriggerStore } from "./types.js";
export { type ApprovalStore } from "./types.js";
export { type TriggerAuditStore } from "./types.js";

export function createStorageProvider(): StorageProvider {
  // Later: if (process.env.DATABASE_URL) return new DatabaseStorageProvider(...)
  const dataDir = path.join(process.cwd(), "data");
  fs.mkdirSync(dataDir, { recursive: true });
  return new LocalStorageProvider(dataDir);
}
