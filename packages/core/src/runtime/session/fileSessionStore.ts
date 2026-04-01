import { readFileSync, writeFileSync, mkdirSync, existsSync, accessSync, constants as fsConstants } from "fs";
import { dirname, resolve } from "path";
import { Logger } from "../../logging";

/**
 * Simple JSON file store for persisting session resume IDs across restarts.
 * Each runtime type gets its own file (e.g. "cli-sessions.json", "claude-sessions.json").
 *
 * If the target directory is not writable (e.g. Railway volume with wrong ownership),
 * the store operates in memory-only mode and logs a warning.
 */
export class FileSessionStore {
  private readonly filePath: string | null;
  private data: Record<string, string>;

  constructor(dataDir: string, fileName: string, private readonly logger?: Logger) {
    const candidate = resolve(dataDir, fileName);
    this.filePath = this.isWritable(candidate) ? candidate : null;
    this.data = this.load();
  }

  /**
   * Check whether we can write to the target file path.
   * If the file already exists, test it directly; otherwise test the parent directory.
   */
  private isWritable(filePath: string): boolean {
    try {
      if (existsSync(filePath)) {
        accessSync(filePath, fsConstants.W_OK);
      } else {
        const dir = dirname(filePath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        accessSync(dir, fsConstants.W_OK);
      }
      return true;
    } catch {
      this.logger?.warn(
        "Session store path is not writable — running in memory-only mode. " +
        "Sessions will not persist across restarts.",
        { filePath }
      );
      return false;
    }
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
    if (!this.filePath) return {};
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
    if (!this.filePath) return;
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
