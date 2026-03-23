import { join } from "path";
import type { StrategyStore, Strategy } from "../types.js";
import { JsonArrayStore } from "./base.js";

export class LocalStrategyStore extends JsonArrayStore<Strategy> implements StrategyStore {
  constructor(dataDir: string) {
    super(join(dataDir, "strategies.json"));
  }

  async list(): Promise<Strategy[]> {
    return this.load();
  }

  async get(id: string): Promise<Strategy | null> {
    const all = await this.load();
    return all.find(s => s.id === id) ?? null;
  }

  async upsert(strategy: Strategy): Promise<void> {
    const all = await this.load();
    const idx = all.findIndex(s => s.id === strategy.id);
    if (idx >= 0) all[idx] = strategy;
    else all.push(strategy);
    await this.save(all);
  }

  async delete(id: string): Promise<void> {
    const all = await this.load();
    await this.save(all.filter(s => s.id !== id));
  }

  async updatePlan(id: string, plan: string): Promise<void> {
    const all = await this.load();
    const idx = all.findIndex(s => s.id === id);
    if (idx < 0) return;
    all[idx] = { ...all[idx], plan, updatedAt: new Date().toISOString() };
    await this.save(all);
  }
}
