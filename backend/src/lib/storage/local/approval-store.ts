import { join } from "path";
import type { ApprovalStore } from "../types.js";
import type { PendingApproval, ApprovalStatus } from "../../heartbeat/types.js";
import { JsonArrayStore } from "./base.js";

export class LocalApprovalStore extends JsonArrayStore<PendingApproval> implements ApprovalStore {
  constructor(dataDir: string) {
    super(join(dataDir, "approvals.json"));
  }

  async list(filter?: { status?: ApprovalStatus }): Promise<PendingApproval[]> {
    const all = await this.load();
    if (!filter?.status) return [...all].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return all.filter(a => a.status === filter.status).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(id: string): Promise<PendingApproval | null> {
    const all = await this.load();
    return all.find(a => a.id === id) ?? null;
  }

  async add(approval: PendingApproval): Promise<void> {
    const all = await this.load();
    all.push(approval);
    await this.save(all);
  }

  async updateStatus(id: string, status: ApprovalStatus, decidedAt?: string): Promise<void> {
    const all = await this.load();
    const idx = all.findIndex(a => a.id === id);
    if (idx < 0) return;
    all[idx] = { ...all[idx], status, ...(decidedAt ? { decidedAt } : {}) };
    await this.save(all);
  }

  async pruneExpired(): Promise<void> {
    const all = await this.load();
    const now = new Date().toISOString();
    let changed = false;
    for (const a of all) {
      if (a.status === "pending" && a.expiresAt < now) {
        a.status = "expired";
        changed = true;
      }
    }
    if (changed) await this.save(all);
  }
}
