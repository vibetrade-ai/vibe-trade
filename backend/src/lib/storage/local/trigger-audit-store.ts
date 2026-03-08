import { readFile, appendFile } from "fs/promises";
import { join } from "path";
import type { TriggerAuditStore } from "../types.js";
import type { TriggerAuditEntry } from "../../heartbeat/types.js";

export class LocalTriggerAuditStore implements TriggerAuditStore {
  private filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "trigger-audit.jsonl");
  }

  async append(entry: TriggerAuditEntry): Promise<void> {
    await appendFile(this.filePath, JSON.stringify(entry) + "\n", "utf-8");
  }

  async list(): Promise<TriggerAuditEntry[]> {
    try {
      const content = await readFile(this.filePath, "utf-8");
      const entries = content
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(line => JSON.parse(line) as TriggerAuditEntry);
      return entries.reverse(); // newest first
    } catch {
      return [];
    }
  }
}
