import { spawn } from "child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
  chmodSync,
  unlinkSync,
  rmdirSync,
  openSync,
  closeSync,
  constants as fsConstants,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Logger } from "../logging";
import { MemoryFact, MemorySnapshot, MemoryTag } from "./store";

export interface RefinementResult {
  /** The full post-refinement snapshot — load this wholesale into the provider. */
  snapshot: MemorySnapshot;
  /** Changelog stats for logging/audit. */
  added: number;
  updated: number;
  removed: number;
}


const REFINEMENT_PROMPT = `You are a memory refinement system. Your job is to review and consolidate stored memories using the memory tools available to you.

Steps:
1. Call list_memories to see all current facts
2. Analyze them for redundancy, staleness, and opportunities to merge
3. Use the memory tools to make changes:
   - update_memory to rewrite facts for clarity or merge info from a redundant fact into another
   - delete_memory to remove stale, outdated, or redundant facts (after merging their info elsewhere)
   - save_memory only if merging multiple facts produces a genuinely new combined fact

Guidelines:
- Merge related or redundant facts into fewer, richer facts
- Remove facts that are clearly outdated or contradicted by newer ones
- Keep each fact concise (under 80 characters)
- Preserve all important information — consolidate, don't lose knowledge
- Do NOT invent new information — only reorganize what exists
- If nothing needs changing, do nothing

Begin by calling list_memories.`;

/**
 * Memory refiner that uses Claude Code CLI with the memory MCP server.
 *
 * Spawns `claude --print --mcp-config <config>` with access to memory tools
 * (list_memories, save_memory, update_memory, delete_memory). Claude directly
 * calls the tools to consolidate facts — no JSON output parsing needed.
 *
 * Uses the same memoryMcpStdio.js + state file pattern as CliRuntime.
 */
export class MemoryRefiner {
  private memoryMcpStdioPath?: string;

  constructor(
    private readonly logger?: Logger,
    private readonly model?: string,
    private readonly timeoutMs: number = 120_000,
  ) {}

  async refine(facts: MemoryFact[]): Promise<RefinementResult | null> {
    if (facts.length < 2) {
      return null;
    }

    const stdioScript = this.resolveStdioPath();
    if (!stdioScript) {
      this.logger?.warn("Memory MCP stdio script not found, cannot refine.");
      return null;
    }

    // Create temp dir with state file and MCP config
    const mcpDir = mkdtempSync(join(tmpdir(), "telegramable-refine-"));
    chmodSync(mcpDir, 0o700);

    const stateFilePath = join(mcpDir, "memory-state.json");
    const mcpConfigPath = join(mcpDir, "mcp-config.json");

    const baseline: MemorySnapshot = {
      v: 1,
      updated: new Date().toISOString(),
      facts: [...facts],
    };

    try {
      // Write files with restrictive permissions
      writeSecure(stateFilePath, JSON.stringify(baseline, null, 2));
      writeSecure(mcpConfigPath, JSON.stringify({
        mcpServers: {
          memory: {
            command: process.execPath,
            args: [stdioScript, stateFilePath],
          },
        },
      }, null, 2));

      // Spawn claude with memory tools only
      await this.spawnCli(mcpConfigPath);

      // Read back the post-refinement snapshot and compute changelog stats
      return this.buildResult(stateFilePath, baseline);
    } catch (error) {
      this.logger?.warn("Memory refinement failed.", {
        reason: error instanceof Error ? error.message : "unknown",
      });
      return null;
    } finally {
      // Cleanup temp files
      try { unlinkSync(stateFilePath); } catch { /* ignore */ }
      try { unlinkSync(mcpConfigPath); } catch { /* ignore */ }
      try { rmdirSync(mcpDir); } catch { /* ignore */ }
    }
  }

  private resolveStdioPath(): string | undefined {
    if (this.memoryMcpStdioPath) return this.memoryMcpStdioPath;
    const path = join(__dirname, "..", "memory", "memoryMcpStdio.js");
    if (existsSync(path)) {
      this.memoryMcpStdioPath = path;
      return path;
    }
    return undefined;
  }

  private spawnCli(mcpConfigPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [
        "--print",
        "--output-format", "text",
        "--mcp-config", mcpConfigPath,
        "--max-turns", "10",
      ];

      if (this.model) {
        args.push("--model", this.model);
      }

      // Use bypassPermissions for non-root, auto for root (same as CliRuntime)
      if (process.getuid?.() === 0) {
        args.push("--permission-mode", "auto");
      } else {
        args.push("--permission-mode", "bypassPermissions");
      }

      args.push("--", REFINEMENT_PROMPT);

      const proc = spawn("claude", args, {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: this.timeoutMs,
      });

      let stderr = "";

      // Drain stdout (we don't need the text output — changes are in the state file)
      proc.stdout.resume();

      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on("error", (err) => {
        reject(new Error(`Failed to spawn claude CLI: ${err.message}`));
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`claude CLI exited with code ${code}: ${stderr.slice(0, 300)}`));
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Read the post-refinement state file, diff against baseline for changelog stats,
   * and return the full snapshot for atomic loading.
   */
  private buildResult(stateFilePath: string, baseline: MemorySnapshot): RefinementResult | null {
    const raw = readFileSync(stateFilePath, "utf-8");
    const snapshot: MemorySnapshot = JSON.parse(raw);
    if (!snapshot.v || !Array.isArray(snapshot.facts)) return null;

    const baselineMap = new Map(baseline.facts.map((f) => [f.id, f]));
    const afterMap = new Map(snapshot.facts.map((f) => [f.id, f]));

    let added = 0;
    let updated = 0;
    let removed = 0;

    for (const fact of snapshot.facts) {
      if (!baselineMap.has(fact.id)) {
        added++;
      } else if (baselineMap.get(fact.id)!.text !== fact.text) {
        updated++;
      }
    }

    for (const id of baselineMap.keys()) {
      if (!afterMap.has(id)) {
        removed++;
      }
    }

    if (added === 0 && updated === 0 && removed === 0) return null;

    return { snapshot, added, updated, removed };
  }
}

/** Write a file with restrictive permissions (0o600) via O_EXCL to prevent symlink attacks. */
function writeSecure(path: string, data: string): void {
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  try {
    writeFileSync(fd, data, "utf-8");
  } finally {
    closeSync(fd);
  }
}
