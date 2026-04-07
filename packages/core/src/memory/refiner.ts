import { spawn } from "child_process";
import { Logger } from "../logging";
import { MemoryFact, MemoryTag } from "./store";

export interface RefinementResult {
  /** Facts to keep (possibly with merged/rewritten text). */
  keep: Array<{ id: string; text: string; tag: MemoryTag }>;
  /** IDs of facts that were merged into others or removed as stale. */
  removed: string[];
  /** Newly synthesized facts (from merging multiple facts). */
  added: Array<{ tag: MemoryTag; text: string }>;
}

const EMPTY_RESULT: RefinementResult = { keep: [], removed: [], added: [] };

const VALID_TAGS = new Set<MemoryTag>(["project", "personal", "preference", "decision", "context"]);

const REFINEMENT_PROMPT = `You are a memory refinement system. Review the following stored facts and consolidate them.

Goals:
1. Merge related or redundant facts into single, richer facts
2. Remove facts that are clearly outdated, contradicted by newer facts, or no longer relevant
3. Rewrite facts to be clearer and more concise (≤80 characters each)
4. Rebalance tags if a fact's category no longer fits
5. Preserve all important information — do not lose knowledge, just consolidate

Rules:
- Each fact must be ≤80 characters
- Valid tags: project, personal, preference, decision, context
- When merging facts, pick the most informative wording
- If two facts contradict each other, keep the newer one (later date)
- Do NOT invent new information — only reorganize what exists

Current facts:
{facts}

Output strict JSON with this structure (nothing else):
{
  "keep": [{"id": "f001", "text": "updated text", "tag": "project"}],
  "removed": ["f003", "f005"],
  "added": [{"tag": "context", "text": "new merged fact"}]
}

- "keep": facts to retain (with potentially rewritten text/tag). Include ALL facts that should survive.
- "removed": IDs of facts being dropped (merged into others or stale). Must not overlap with "keep" IDs.
- "added": new facts created by merging multiple facts together (only if merging produced a new fact not in "keep").

If no changes are needed, output: {"keep": [], "removed": [], "added": []}
(empty keep means "keep everything as-is")`;

/** Response envelope from `claude --print --output-format json`. */
interface CliJsonResponse {
  result?: string;
  is_error?: boolean;
}

/**
 * Memory refiner that uses Claude Code CLI (`claude --print`) to consolidate facts.
 * No separate API key needed — uses the same Claude installation as the agent.
 *
 * Uses `--output-format json` to get a structured CLI envelope, then parses the
 * refinement JSON from the `result` field.
 */
export class MemoryRefiner {
  constructor(
    private readonly logger?: Logger,
    private readonly model?: string,
    private readonly timeoutMs: number = 120_000,
  ) {}

  async refine(facts: MemoryFact[]): Promise<RefinementResult> {
    if (facts.length < 2) {
      return EMPTY_RESULT;
    }

    const factsJson = JSON.stringify(
      facts.map((f) => ({ id: f.id, tag: f.tag, text: f.text, at: f.at })),
      null,
      2,
    );

    const prompt = REFINEMENT_PROMPT.replace("{facts}", factsJson);

    try {
      const resultText = await this.callCli(prompt);
      return this.parseResult(resultText, facts);
    } catch (error) {
      this.logger?.warn("Memory refinement failed.", {
        reason: error instanceof Error ? error.message : "unknown",
      });
      return EMPTY_RESULT;
    }
  }

  /**
   * Spawn `claude --print --bare --output-format json` and return the `result` field.
   *
   * --bare disables all tools (prevents memory MCP tool calls during refinement).
   * --output-format json returns a structured envelope: { result: "...", is_error: bool, ... }
   */
  private async callCli(prompt: string): Promise<string> {
    const stdout = await this.spawnCli(prompt);

    // Parse the CLI JSON envelope
    let envelope: CliJsonResponse;
    try {
      envelope = JSON.parse(stdout);
    } catch {
      throw new Error(`Claude CLI returned non-JSON output: ${stdout.slice(0, 200)}`);
    }

    if (envelope.is_error) {
      throw new Error(`Claude CLI returned error: ${(envelope.result || "unknown").slice(0, 200)}`);
    }

    if (typeof envelope.result !== "string" || envelope.result.length === 0) {
      throw new Error("Claude CLI returned empty result.");
    }

    return envelope.result;
  }

  private spawnCli(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = ["--print", "--output-format", "json", "--bare"];

      if (this.model) {
        args.push("--model", this.model);
      }

      args.push("--max-turns", "1");
      args.push("--", prompt);

      const proc = spawn("claude", args, {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: this.timeoutMs,
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

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
          resolve(stdout);
        }
      });
    });
  }

  private parseResult(text: string, currentFacts: MemoryFact[]): RefinementResult {
    try {
      // The result field contains the LLM's text response.
      // Try direct JSON parse first, fall back to regex extraction.
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(text);
      } catch {
        // LLM may have wrapped JSON in markdown fences or added commentary
        const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/);
        if (!jsonMatch?.[1]) return EMPTY_RESULT;
        raw = JSON.parse(jsonMatch[1]);
      }

      const result: RefinementResult = { keep: [], removed: [], added: [] };
      const factIds = new Set(currentFacts.map((f) => f.id));

      // Parse "keep" — facts to retain with updated text/tag
      if (Array.isArray(raw.keep)) {
        for (const item of raw.keep as Record<string, unknown>[]) {
          if (
            typeof item.id === "string" &&
            factIds.has(item.id) &&
            typeof item.text === "string" &&
            typeof item.tag === "string" &&
            VALID_TAGS.has(item.tag as MemoryTag)
          ) {
            result.keep.push({
              id: item.id,
              text: (item.text as string).slice(0, 80),
              tag: item.tag as MemoryTag,
            });
          }
        }
      }

      // Parse "removed" — IDs to drop
      if (Array.isArray(raw.removed)) {
        const keepIds = new Set(result.keep.map((k) => k.id));
        for (const id of raw.removed) {
          if (typeof id === "string" && factIds.has(id) && !keepIds.has(id)) {
            result.removed.push(id);
          }
        }
      }

      // Parse "added" — new synthesized facts
      if (Array.isArray(raw.added)) {
        for (const item of raw.added as Record<string, unknown>[]) {
          if (
            typeof item.tag === "string" &&
            VALID_TAGS.has(item.tag as MemoryTag) &&
            typeof item.text === "string"
          ) {
            result.added.push({
              tag: item.tag as MemoryTag,
              text: (item.text as string).slice(0, 80),
            });
          }
        }
      }

      // Empty keep means "keep everything as-is"
      if (result.keep.length === 0 && result.removed.length === 0 && result.added.length === 0) {
        return EMPTY_RESULT;
      }

      return result;
    } catch {
      this.logger?.warn("Failed to parse memory refinement response.", { text: text.slice(0, 200) });
      return EMPTY_RESULT;
    }
  }
}
