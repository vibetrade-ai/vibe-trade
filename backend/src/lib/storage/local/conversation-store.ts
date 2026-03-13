import fs from "fs/promises";
import path from "path";
import type Anthropic from "@anthropic-ai/sdk";
import type { ConversationMeta, ConversationStore } from "../types.js";

const SYSTEM_FILES = new Set(["trigger-audit", "triggers", "approvals", "trades", "memory"]);

function isSystemFile(id: string): boolean {
  return SYSTEM_FILES.has(id);
}

export class LocalConversationStore implements ConversationStore {
  constructor(private readonly dataDir: string) {}

  async load(conversationId: string): Promise<Anthropic.MessageParam[]> {
    if (isSystemFile(conversationId)) return [];
    const filePath = path.join(this.dataDir, `${conversationId}.jsonl`);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return raw
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Anthropic.MessageParam)
      .filter((msg) => msg.role === "user" || msg.role === "assistant");
  }

  async append(conversationId: string, messages: Anthropic.MessageParam[]): Promise<void> {
    if (messages.length === 0) return;
    if (isSystemFile(conversationId)) return;
    const filePath = path.join(this.dataDir, `${conversationId}.jsonl`);
    const data = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
    try {
      await fs.appendFile(filePath, data, "utf8");
    } catch (err) {
      console.error(`[storage] Failed to append to ${filePath}:`, err);
    }
  }

  async list(): Promise<ConversationMeta[]> {
    let files: string[];
    try {
      files = await fs.readdir(this.dataDir);
    } catch {
      return [];
    }

    const metas: ConversationMeta[] = [];
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const id = file.slice(0, -6);
      if (isSystemFile(id)) continue;
      const filePath = path.join(this.dataDir, file);
      try {
        const [stat, raw] = await Promise.all([
          fs.stat(filePath),
          fs.readFile(filePath, "utf8"),
        ]);
        let title = "New conversation";
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line) as Anthropic.MessageParam;
          if (msg.role === "user") {
            if (typeof msg.content === "string") {
              title = msg.content.slice(0, 80);
            } else if (Array.isArray(msg.content)) {
              const textBlock = msg.content.find((b) => b.type === "text");
              if (textBlock && "text" in textBlock) {
                title = (textBlock.text as string).slice(0, 80);
              }
            }
            break;
          }
        }
        metas.push({ id, title, updatedAt: stat.mtime });
      } catch {
        // skip malformed files
      }
    }
    return metas.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }
}
