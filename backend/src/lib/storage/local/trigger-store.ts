import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import type { TriggerStore } from "../types.js";
import type { Trigger, TriggerStatus } from "../../heartbeat/types.js";

export class LocalTriggerStore implements TriggerStore {
  private filePath: string;
  private cache: Trigger[] | null = null;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "triggers.json");
  }

  private async load(): Promise<Trigger[]> {
    if (this.cache) return this.cache;
    try {
      const content = await readFile(this.filePath, "utf-8");
      this.cache = JSON.parse(content) as Trigger[];
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  private async save(triggers: Trigger[]): Promise<void> {
    this.cache = triggers;
    await writeFile(this.filePath, JSON.stringify(triggers, null, 2), "utf-8");
  }

  async list(filter?: { status?: TriggerStatus }): Promise<Trigger[]> {
    const all = await this.load();
    const status = filter?.status ?? "active";
    return all.filter(t => t.status === status);
  }

  async get(id: string): Promise<Trigger | null> {
    const all = await this.load();
    return all.find(t => t.id === id) ?? null;
  }

  async upsert(trigger: Trigger): Promise<void> {
    const all = await this.load();
    const idx = all.findIndex(t => t.id === trigger.id);
    if (idx >= 0) all[idx] = trigger;
    else all.push(trigger);
    await this.save(all);
  }

  async setStatus(id: string, status: TriggerStatus, extra?: Partial<Trigger>): Promise<void> {
    const all = await this.load();
    const idx = all.findIndex(t => t.id === id);
    if (idx < 0) return;
    all[idx] = { ...all[idx], status, active: status === "active", ...extra };
    await this.save(all);
  }

  async pruneExpired(): Promise<void> {
    const all = await this.load();
    const now = new Date().toISOString();
    let changed = false;
    for (const t of all) {
      if (t.status === "active" && t.expiresAt && t.expiresAt < now) {
        t.status = "expired";
        t.active = false;
        changed = true;
      }
    }
    if (changed) await this.save(all);
  }
}
