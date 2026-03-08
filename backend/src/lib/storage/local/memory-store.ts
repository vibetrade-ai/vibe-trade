import fs from "fs/promises";
import path from "path";
import type { MemoryStore } from "../types.js";

export class LocalMemoryStore implements MemoryStore {
  private filePath: string;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "MEMORY.md");
  }

  async read(): Promise<string> {
    try {
      return await fs.readFile(this.filePath, "utf-8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw err;
    }
  }

  async write(content: string): Promise<void> {
    await fs.writeFile(this.filePath, content, "utf-8");
  }
}
