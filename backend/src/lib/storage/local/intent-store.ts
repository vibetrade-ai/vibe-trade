import { join } from "path";
import type { IntentStore, Intent, IntentStatus } from "../types.js";
import { JsonArrayStore } from "./base.js";

export class LocalIntentStore extends JsonArrayStore<Intent> implements IntentStore {
  constructor(dataDir: string) {
    super(join(dataDir, "intents.json"));
  }

  async append(intent: Intent): Promise<void> {
    const all = await this.load();
    all.push(intent);
    await this.save(all);
  }

  async list(filter?: { status?: IntentStatus | IntentStatus[] }): Promise<Intent[]> {
    const all = await this.load();
    if (!filter?.status) return all;
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    return all.filter(i => statuses.includes(i.status));
  }

  async get(id: string): Promise<Intent | null> {
    const all = await this.load();
    return all.find(i => i.id === id) ?? null;
  }

  async update(id: string, patch: Partial<Intent>): Promise<void> {
    const all = await this.load();
    const idx = all.findIndex(i => i.id === id);
    if (idx < 0) return;
    all[idx] = { ...all[idx], ...patch };
    await this.save(all);
  }
}
