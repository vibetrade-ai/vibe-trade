import { join } from "path";
import type { Portfolio, PortfolioStore, PortfolioStatus } from "../types.js";
import { JsonArrayStore } from "./base.js";

export class LocalPortfolioStore extends JsonArrayStore<Portfolio> implements PortfolioStore {
  constructor(dataDir: string) {
    super(join(dataDir, "portfolios.json"));
  }

  async list(filter?: { status?: PortfolioStatus | PortfolioStatus[] }): Promise<Portfolio[]> {
    let all = await this.load();
    if (filter?.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      all = all.filter(p => statuses.includes(p.status));
    }
    return all;
  }

  async get(id: string): Promise<Portfolio | null> {
    const all = await this.load();
    return all.find(p => p.id === id) ?? null;
  }

  async upsert(portfolio: Portfolio): Promise<void> {
    const all = await this.load();
    const idx = all.findIndex(p => p.id === portfolio.id);
    if (idx >= 0) {
      all[idx] = portfolio;
    } else {
      all.push(portfolio);
    }
    await this.save(all);
  }

  async setStatus(id: string, status: PortfolioStatus): Promise<void> {
    const all = await this.load();
    const idx = all.findIndex(p => p.id === id);
    if (idx < 0) return;
    all[idx] = { ...all[idx], status, updatedAt: new Date().toISOString() };
    await this.save(all);
  }

  async addStrategy(portfolioId: string, strategyId: string): Promise<void> {
    const all = await this.load();
    const idx = all.findIndex(p => p.id === portfolioId);
    if (idx < 0) return;
    if (!all[idx].strategyIds.includes(strategyId)) {
      all[idx] = {
        ...all[idx],
        strategyIds: [...all[idx].strategyIds, strategyId],
        updatedAt: new Date().toISOString(),
      };
      await this.save(all);
    }
  }

  async removeStrategy(portfolioId: string, strategyId: string): Promise<void> {
    const all = await this.load();
    const idx = all.findIndex(p => p.id === portfolioId);
    if (idx < 0) return;
    all[idx] = {
      ...all[idx],
      strategyIds: all[idx].strategyIds.filter(id => id !== strategyId),
      updatedAt: new Date().toISOString(),
    };
    await this.save(all);
  }
}
