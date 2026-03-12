import { readFile, writeFile, rename } from "fs/promises";
import { basename } from "path";

export abstract class JsonArrayStore<T> {
  protected cache: T[] | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(protected readonly filePath: string) {}

  protected async load(): Promise<T[]> {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(await readFile(this.filePath, "utf-8")) as T[];
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  protected save(items: T[]): Promise<void> {
    this.cache = items;
    const content = JSON.stringify(items, null, 2);
    const tmp = this.filePath + ".tmp";
    this.writeQueue = this.writeQueue
      .catch(err => console.error(`[store] write error (${basename(this.filePath)}):`, err))
      .then(() => writeFile(tmp, content, "utf-8"))
      .then(() => rename(tmp, this.filePath));
    return this.writeQueue;
  }
}
