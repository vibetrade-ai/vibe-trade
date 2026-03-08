import type { StorageProvider } from "../types.js";
import { LocalConversationStore } from "./conversation-store.js";
import { LocalMemoryStore } from "./memory-store.js";

export class LocalStorageProvider implements StorageProvider {
  conversations: LocalConversationStore;
  memory: LocalMemoryStore;

  constructor(dataDir: string) {
    this.conversations = new LocalConversationStore(dataDir);
    this.memory = new LocalMemoryStore(dataDir);
  }
}
