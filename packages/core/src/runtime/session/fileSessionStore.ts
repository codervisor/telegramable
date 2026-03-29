import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, resolve } from "path";
import { Logger } from "../../logging";

/**
 * Simple JSON file store for persisting session resume IDs across restarts.
 * Each runtime type gets its own file (e.g. "cli-sessions.json", "claude-sessions.json").
 */
export class FileSessionStore {
  private readonly filePath: string;
  private data: Record<string, string>;

  constructor(dataDir: string, fileName: string, private readonly logger?: Logger) {
    this.filePath = resolve(dataDir, fileName);
    this.data = this.load();
  }

  get(key: string): string | undefined {
    return this.data[key];
  }

  set(key: string, value: string): void {
    this.data[key] = value;
    this.save();
  }

  delete(key: string): void {
    delete this.data[key];
    this.save();
  }

  private load(): Record<string, string> {
    try {
      if (!existsSync(this.filePath)) return {};
      const raw = readFileSync(this.filePath, "utf-8");
      return JSON.parse(raw);
    } catch (error) {
      this.logger?.warn("Failed to load session store, starting fresh.", {
        filePath: this.filePath,
        reason: error instanceof Error ? error.message : "unknown"
      });
      return {};
    }
  }

  private save(): void {
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
    } catch (error) {
      this.logger?.warn("Failed to save session store.", {
        filePath: this.filePath,
        reason: error instanceof Error ? error.message : "unknown"
      });
    }
  }
}
