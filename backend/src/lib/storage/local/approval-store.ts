import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import type { ApprovalStore } from "../types.js";
import type { PendingApproval, ApprovalStatus } from "../../heartbeat/types.js";

export class LocalApprovalStore implements ApprovalStore {
  private filePath: string;
  private cache: PendingApproval[] | null = null;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "approvals.json");
  }

  private async load(): Promise<PendingApproval[]> {
    if (this.cache) return this.cache;
    try {
      const content = await readFile(this.filePath, "utf-8");
      this.cache = JSON.parse(content) as PendingApproval[];
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  private async save(approvals: PendingApproval[]): Promise<void> {
    this.cache = approvals;
    await writeFile(this.filePath, JSON.stringify(approvals, null, 2), "utf-8");
  }

  async list(filter?: { status?: ApprovalStatus }): Promise<PendingApproval[]> {
    const all = await this.load();
    const status = filter?.status ?? "pending";
    if ((status as string) === "all") return [...all].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return all.filter(a => a.status === status).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
