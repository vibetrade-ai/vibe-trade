import type { StorageProvider } from "../types.js";
import { LocalConversationStore } from "./conversation-store.js";

export class LocalStorageProvider implements StorageProvider {
  conversations: LocalConversationStore;

  constructor(dataDir: string) {
    this.conversations = new LocalConversationStore(dataDir);
  }
}
