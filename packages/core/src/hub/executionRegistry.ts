import { stripAnsi } from "../runtime/session/utils";

export interface ToolUseRecord {
  name: string;
  input?: Record<string, unknown>;
  timestamp: number;
}

export interface ExecutionRecord {
  executionId: string;
  channelId: string;
  chatId: string;
  agentName: string;
  status: "running" | "complete" | "error";
  startedAt: number;
  finishedAt?: number;
  outputLines: string[];
  errorReason?: string;
  /** Tool calls made during this execution, in chronological order. */
  toolUses: ToolUseRecord[];
}

export interface ExecutionRegistry {
  start(params: {
    executionId: string;
    channelId: string;
    chatId: string;
    agentName: string;
    startedAt: number;
  }): void;
  append(executionId: string, text: string): void;
  trackToolUse(executionId: string, name: string, input?: Record<string, unknown>): void;
  complete(executionId: string, finishedAt: number): void;
  error(executionId: string, reason: string, finishedAt: number): void;
  get(executionId: string): ExecutionRecord | undefined;
  list(channelId: string, chatId: string): ExecutionRecord[];
}

interface InMemoryExecutionRegistryOptions {
  maxLines?: number;
  ttlMs?: number;
  now?: () => number;
}

const DEFAULT_MAX_LINES = 200;
const DEFAULT_TTL_MS = 60 * 60 * 1_000;

export class InMemoryExecutionRegistry implements ExecutionRegistry {
  private readonly maxLines: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly records = new Map<string, ExecutionRecord>();

  constructor(options: InMemoryExecutionRegistryOptions = {}) {
    this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  start(params: {
    executionId: string;
    channelId: string;
    chatId: string;
    agentName: string;
    startedAt: number;
  }): void {
    this.pruneExpired();
    this.records.set(params.executionId, {
      executionId: params.executionId,
      channelId: params.channelId,
      chatId: params.chatId,
      agentName: params.agentName,
      status: "running",
      startedAt: params.startedAt,
      outputLines: [],
      toolUses: []
    });
  }

  append(executionId: string, text: string): void {
    const record = this.records.get(executionId);
    if (!record) {
      return;
    }

    const cleaned = stripAnsi(text);
    const lines = cleaned
      .split("\n")
      .map((line) => line.replace(/\r/g, "").trimEnd())
      .filter((line) => line.length > 0);

    if (lines.length === 0) {
      return;
    }

    record.outputLines.push(...lines);
    if (record.outputLines.length > this.maxLines) {
      record.outputLines.splice(0, record.outputLines.length - this.maxLines);
    }
  }

  trackToolUse(executionId: string, name: string, input?: Record<string, unknown>): void {
    const record = this.records.get(executionId);
    if (!record) {
      return;
    }
    record.toolUses.push({
      name,
      input: input ? { ...input } : undefined,
      timestamp: this.now()
    });

    if (record.toolUses.length > this.maxLines) {
      record.toolUses.splice(0, record.toolUses.length - this.maxLines);
    }
  }

  complete(executionId: string, finishedAt: number): void {
    const record = this.records.get(executionId);
    if (!record) {
      return;
    }

    record.status = "complete";
    record.finishedAt = finishedAt;
    record.errorReason = undefined;
  }

  error(executionId: string, reason: string, finishedAt: number): void {
    const record = this.records.get(executionId);
    if (!record) {
      return;
    }

    record.status = "error";
    record.finishedAt = finishedAt;
    record.errorReason = reason;
  }

  get(executionId: string): ExecutionRecord | undefined {
    return this.records.get(executionId);
  }

  list(channelId: string, chatId: string): ExecutionRecord[] {
    this.pruneExpired();

    return Array.from(this.records.values())
      .filter((record) => record.channelId === channelId && record.chatId === chatId)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  private pruneExpired(): void {
    const cutoff = this.now() - this.ttlMs;

    for (const record of this.records.values()) {
      if (record.status === "running") {
        continue;
      }
      if ((record.finishedAt ?? 0) < cutoff) {
        this.records.delete(record.executionId);
      }
    }
  }
}
