import { readFile, writeFile, rename } from "fs/promises";
import { join } from "path";
import type { CredentialsStore } from "../types.js";

export class LocalCredentialsStore implements CredentialsStore {
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "credentials.json");
  }

  async read(): Promise<Record<string, string> | null> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      return JSON.parse(raw) as Record<string, string>;
    } catch {
      return null;
    }
  }

  async write(data: Record<string, string>): Promise<void> {
    const tmp = this.filePath + ".tmp";
    await writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
    await rename(tmp, this.filePath);
  }
}
