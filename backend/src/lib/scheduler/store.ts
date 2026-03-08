import { readFile, writeFile, appendFile } from "fs/promises";
import { join } from "path";
import type { Schedule, ScheduleStatus, ScheduleRun } from "./types.js";

// Interfaces
export interface ScheduleStore {
  list(filter?: { status?: ScheduleStatus | ScheduleStatus[] }): Promise<Schedule[]>;
  get(id: string): Promise<Schedule | null>;
  upsert(schedule: Schedule): Promise<void>;
  setStatus(id: string, status: ScheduleStatus): Promise<void>;
  updateLastRun(id: string, lastRunAt: string, nextRunAt: string): Promise<void>;
  updateNextRunAt(id: string, nextRunAt: string): Promise<void>;
}

export interface ScheduleRunStore {
  append(run: ScheduleRun): Promise<void>;
  list(limit?: number): Promise<ScheduleRun[]>;
}

// LocalScheduleStore - mirrors LocalTriggerStore pattern (schedules.json)
export class LocalScheduleStore implements ScheduleStore {
  private filePath: string;
  private cache: Schedule[] | null = null;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "schedules.json");
  }

  private async load(): Promise<Schedule[]> {
    if (this.cache) return this.cache;
    try {
      const content = await readFile(this.filePath, "utf-8");
      this.cache = JSON.parse(content) as Schedule[];
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  private async save(schedules: Schedule[]): Promise<void> {
    this.cache = schedules;
    await writeFile(this.filePath, JSON.stringify(schedules, null, 2), "utf-8");
  }

  async list(filter?: { status?: ScheduleStatus | ScheduleStatus[] }): Promise<Schedule[]> {
    const all = await this.load();
    if (!filter?.status) return all.filter(s => s.status !== "deleted");
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    return all.filter(s => statuses.includes(s.status));
  }

  async get(id: string): Promise<Schedule | null> {
    const all = await this.load();
    return all.find(s => s.id === id) ?? null;
  }

  async upsert(schedule: Schedule): Promise<void> {
    const all = await this.load();
    const idx = all.findIndex(s => s.id === schedule.id);
    if (idx >= 0) all[idx] = schedule;
    else all.push(schedule);
    await this.save(all);
  }

  async setStatus(id: string, status: ScheduleStatus): Promise<void> {
    const all = await this.load();
    const idx = all.findIndex(s => s.id === id);
    if (idx < 0) return;
    all[idx] = { ...all[idx], status };
    await this.save(all);
  }

  async updateLastRun(id: string, lastRunAt: string, nextRunAt: string): Promise<void> {
    const all = await this.load();
    const idx = all.findIndex(s => s.id === id);
    if (idx < 0) return;
    all[idx] = { ...all[idx], lastRunAt, nextRunAt };
    await this.save(all);
  }

  async updateNextRunAt(id: string, nextRunAt: string): Promise<void> {
    const all = await this.load();
    const idx = all.findIndex(s => s.id === id);
    if (idx < 0) return;
    all[idx] = { ...all[idx], nextRunAt };
    await this.save(all);
  }
}

// LocalScheduleRunStore - JSONL pattern (schedule-runs.jsonl)
export class LocalScheduleRunStore implements ScheduleRunStore {
  private filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "schedule-runs.jsonl");
  }

  async append(run: ScheduleRun): Promise<void> {
    await appendFile(this.filePath, JSON.stringify(run) + "\n", "utf-8");
  }

  async list(limit = 50): Promise<ScheduleRun[]> {
    try {
      const content = await readFile(this.filePath, "utf-8");
      const lines = content.split("\n").filter(l => l.trim());
      const runs = lines.map(l => JSON.parse(l) as ScheduleRun);
      return runs.slice(-limit).reverse();
    } catch {
      return [];
    }
  }
}
