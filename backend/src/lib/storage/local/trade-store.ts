import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import type { TradeStore, TradeRecord, TradeStatus } from "../types.js";

export class LocalTradeStore implements TradeStore {
  private filePath: string;
  private cache: TradeRecord[] | null = null;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "trades.json");
  }

  private async load(): Promise<TradeRecord[]> {
    if (this.cache) return this.cache;
    try {
      const content = await readFile(this.filePath, "utf-8");
      this.cache = JSON.parse(content) as TradeRecord[];
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  private async save(trades: TradeRecord[]): Promise<void> {
    this.cache = trades;
    await writeFile(this.filePath, JSON.stringify(trades, null, 2), "utf-8");
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
    symbol?: string;
    fromDate?: string;
    toDate?: string;
    status?: TradeStatus;
  }): Promise<TradeRecord[]> {
    let all = await this.load();
    if (filter?.strategyId) all = all.filter(t => t.strategyId === filter.strategyId);
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
