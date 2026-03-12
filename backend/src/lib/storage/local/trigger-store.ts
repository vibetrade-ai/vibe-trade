import { join } from "path";
import type { TriggerStore } from "../types.js";
import type { Trigger, TriggerStatus } from "../../heartbeat/types.js";
import { JsonArrayStore } from "./base.js";

export class LocalTriggerStore extends JsonArrayStore<Trigger> implements TriggerStore {
  constructor(dataDir: string) {
    super(join(dataDir, "triggers.json"));
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
