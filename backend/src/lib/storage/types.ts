import type Anthropic from "@anthropic-ai/sdk";

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

export interface StorageProvider {
  conversations: ConversationStore;
  memory: MemoryStore;
  // strategies: StrategyStore;   — future phase
  // portfolio: PortfolioStore;   — future phase
}
