import { Logger } from "../logging";
import { MemoryProvider } from "./provider";
import { MemoryRefiner, RefinementResult } from "./refiner";

export interface RefinementSchedulerConfig {
  /** Interval between automatic refinements in milliseconds. Default: 3600000 (1h). */
  intervalMs: number;
  /** Trigger refinement when fact count reaches this threshold. 0 = disabled. Default: 50. */
  factThreshold: number;
}

const DEFAULT_CONFIG: RefinementSchedulerConfig = {
  intervalMs: 60 * 60 * 1000, // 1 hour
  factThreshold: 50,
};

export interface RefinementChangelog {
  removed: number;
  added: number;
  updated: number;
  beforeCount: number;
  afterCount: number;
}

/**
 * Schedules periodic memory refinement.
 *
 * Triggers:
 * 1. Time-based: runs every `intervalMs` (default 1h)
 * 2. Threshold-based: runs when fact count exceeds `factThreshold` (checked after each ingest)
 * 3. On-demand: via `runNow()`
 */
export class MemoryRefinementScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private lastRefinedAt: Date | undefined;
  private readonly config: RefinementSchedulerConfig;

  constructor(
    private readonly provider: MemoryProvider,
    private readonly refiner: MemoryRefiner,
    config?: Partial<RefinementSchedulerConfig>,
    private readonly logger?: Logger,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Start the periodic timer. */
  start(): void {
    if (this.timer) return;

    this.timer = setInterval(() => {
      this.runNow().catch((err) => {
        this.logger?.warn("Scheduled memory refinement failed.", {
          reason: err instanceof Error ? err.message : "unknown",
        });
      });
    }, this.config.intervalMs);

    // Don't prevent Node from exiting
    if (this.timer.unref) {
      this.timer.unref();
    }

    this.logger?.info("Memory refinement scheduler started.", {
      intervalMs: this.config.intervalMs,
      factThreshold: this.config.factThreshold,
    });
  }

  /** Stop the periodic timer. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.logger?.info("Memory refinement scheduler stopped.");
    }
  }

  /**
   * Check if threshold-based refinement should trigger.
   * Call this after each ingest to auto-refine when facts accumulate.
   */
  async checkThreshold(): Promise<RefinementChangelog | null> {
    if (this.config.factThreshold <= 0) return null;

    const factCount = this.provider.all().length;
    if (factCount < this.config.factThreshold) return null;

    this.logger?.info("Fact threshold reached, triggering refinement.", {
      factCount,
      threshold: this.config.factThreshold,
    });

    return this.runNow();
  }

  /** Run refinement immediately. Returns null if already running or no changes needed. */
  async runNow(): Promise<RefinementChangelog | null> {
    if (this.running) {
      this.logger?.info("Refinement already in progress, skipping.");
      return null;
    }

    const facts = this.provider.all();
    if (facts.length < 2) {
      this.logger?.info("Too few facts to refine.", { count: facts.length });
      return null;
    }

    this.running = true;
    try {
      this.logger?.info("Starting memory refinement.", { factCount: facts.length });

      const result = await this.refiner.refine(facts);
      if (isNoOp(result)) {
        this.logger?.info("Refinement completed — no changes needed.");
        this.lastRefinedAt = new Date();
        return null;
      }

      const changelog = await this.applyResult(result, facts.length);
      this.lastRefinedAt = new Date();

      this.logger?.info("Memory refinement completed.", { ...changelog });
      return changelog;
    } finally {
      this.running = false;
    }
  }

  /** Whether refinement is currently in progress. */
  get isRunning(): boolean {
    return this.running;
  }

  /** When the last successful refinement occurred. */
  get lastRefined(): Date | undefined {
    return this.lastRefinedAt;
  }

  /**
   * Apply the diff from the refiner to the live memory provider.
   * The refiner already ran the tools against a snapshot — we replay
   * the same changes against the live store.
   */
  private async applyResult(result: RefinementResult, beforeCount: number): Promise<RefinementChangelog> {
    // Apply updates
    for (const item of result.updated) {
      await this.provider.update(item.id, item.newText);
    }

    // Apply removals
    for (const item of result.removed) {
      await this.provider.remove(item.id);
    }

    // Apply additions
    for (const fact of result.added) {
      await this.provider.add(fact.tag, fact.text);
    }

    const afterCount = this.provider.all().length;

    const changelog: RefinementChangelog = {
      removed: result.removed.length,
      added: result.added.length,
      updated: result.updated.length,
      beforeCount,
      afterCount,
    };

    // Save as new pinned snapshot (version checkpoint)
    await this.provider.saveNewSnapshot().catch(() => {});

    // Send audit changelog
    const changelogText = formatRefinementChangelog(changelog);
    await this.provider.sendChangelog(changelogText).catch(() => {});

    return changelog;
  }
}

function isNoOp(result: RefinementResult): boolean {
  return result.added.length === 0 && result.updated.length === 0 && result.removed.length === 0;
}

function formatRefinementChangelog(cl: RefinementChangelog): string {
  const lines = ["🔄 Memory Refinement"];
  lines.push(`Before: ${cl.beforeCount} facts → After: ${cl.afterCount} facts`);
  if (cl.updated > 0) lines.push(`  Rewritten: ${cl.updated}`);
  if (cl.removed > 0) lines.push(`  Removed: ${cl.removed}`);
  if (cl.added > 0) lines.push(`  Synthesized: ${cl.added}`);
  return lines.join("\n");
}
