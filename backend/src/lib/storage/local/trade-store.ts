import { join } from "path";
import type { TradeStore, TradeRecord, TradeStatus } from "../types.js";
import { JsonArrayStore } from "./base.js";

export class LocalTradeStore extends JsonArrayStore<TradeRecord> implements TradeStore {
  constructor(dataDir: string) {
    super(join(dataDir, "trades.json"));
  }

  async append(trade: TradeRecord): Promise<void> {
    const all = await this.load();
    if (all.some(t => t.orderId === trade.orderId)) {
      console.warn(`[trade-store] duplicate orderId ${trade.orderId} — skipping`);
      return;
    }
    all.push(trade);
    await this.save(all);
  }

  async list(filter?: {
    strategyId?: string;
    portfolioId?: string;
    symbol?: string;
    fromDate?: string;
    toDate?: string;
    status?: TradeStatus;
  }): Promise<TradeRecord[]> {
    let all = await this.load();
    if (filter?.strategyId) all = all.filter(t => t.strategyId === filter.strategyId);
    if (filter?.portfolioId) all = all.filter(t => t.portfolioId === filter.portfolioId);
    if (filter?.symbol) all = all.filter(t => t.symbol === filter.symbol!.toUpperCase());
    if (filter?.status) all = all.filter(t => t.status === filter.status);
    if (filter?.fromDate) all = all.filter(t => t.createdAt >= filter.fromDate!);
    if (filter?.toDate) all = all.filter(t => t.createdAt <= filter.toDate! + "T23:59:59Z");
    return all.slice().reverse(); // newest first
  }

  async get(id: string): Promise<TradeRecord | null> {
    const all = await this.load();
    return all.find(t => t.id === id) ?? null;
  }

  async update(id: string, patch: Partial<TradeRecord>): Promise<void> {
    const all = await this.load();
    const idx = all.findIndex(t => t.id === id);
    if (idx < 0) return;
    all[idx] = { ...all[idx], ...patch };
    await this.save(all);
  }
}
