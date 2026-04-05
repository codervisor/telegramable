import { watch, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "fs";
import type { FSWatcher } from "fs";
import { basename, join } from "path";
import { EventBus } from "../events/eventBus";
import { ExecutionEvent } from "../events/types";
import { Logger } from "../logging";

export interface SudoRequest {
  id: string;
  command: string;
  channelId: string;
  chatId: string;
  timestamp: number;
}

/**
 * Watches a directory for sudo permission request files created by the
 * sudo-wrapper.sh script. When a .req file appears, emits a permission-request
 * event on the EventBus (reusing the existing inline keyboard flow in the hub).
 * When the user responds via Telegram, writes a .res file for the wrapper to read.
 */
export class SudoWatcher {
  private watcher?: FSWatcher;
  private pollInterval?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;
  /** Track pending request IDs so we can write response files. */
  private readonly pending = new Map<string, SudoRequest>();
  /** Track already-seen filenames to avoid reprocessing in poll. */
  private readonly seen = new Set<string>();

  constructor(
    private readonly watchDir: string,
    private readonly eventBus: EventBus,
    private readonly logger: Logger
  ) {}

  start(): void {
    // Ensure the watch directory exists
    if (!existsSync(this.watchDir)) {
      mkdirSync(this.watchDir, { recursive: true });
    }

    // Process any leftover .req files from before startup (edge case: restart)
    this.scanExisting();

    // Watch for new .req files — accept both "rename" and "change" events
    // because fs.watch behavior is platform-dependent (Linux may emit "change"
    // for renames in some configurations, especially inside Docker).
    try {
      this.watcher = watch(this.watchDir, { encoding: "utf8" }, (eventType, filename) => {
        if (filename && filename.endsWith(".req")) {
          const reqPath = join(this.watchDir, filename);
          // Small delay to ensure the atomic rename has settled
          setTimeout(() => this.processRequest(reqPath), 50);
        }
      });

      this.watcher.on("error", (err) => {
        this.logger.warn("SudoWatcher fs.watch error — falling back to polling only.", {
          reason: err instanceof Error ? err.message : "unknown"
        });
        this.watcher?.close();
        this.watcher = undefined;
      });
    } catch (err) {
      this.logger.warn("SudoWatcher fs.watch unavailable — using polling only.", {
        reason: err instanceof Error ? err.message : "unknown"
      });
    }

    // Poll as a safety net — fs.watch can be unreliable in containers.
    this.pollInterval = setInterval(() => this.scanExisting(), 2_000);

    // Listen for permission-response events to write .res files
    this.unsubscribe = this.eventBus.on((event: ExecutionEvent) => {
      if (event.type !== "permission-response") return;

      const requestId = event.payload?.permissionRequestId;
      if (!requestId || !this.pending.has(requestId)) return;

      const decision = event.payload?.decision ?? "deny";
      this.writeResponse(requestId, decision);
    });

    this.logger.info("SudoWatcher started.", { watchDir: this.watchDir });
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
    }
    this.unsubscribe?.();
    this.unsubscribe = undefined;

    // Deny all pending requests on shutdown
    for (const [requestId] of this.pending) {
      this.writeResponse(requestId, "deny");
    }
    this.pending.clear();
    this.seen.clear();

    this.logger.info("SudoWatcher stopped.");
  }

  private scanExisting(): void {
    try {
      const files = readdirSync(this.watchDir).filter((f) => f.endsWith(".req"));
      for (const file of files) {
        if (!this.seen.has(file)) {
          this.processRequest(join(this.watchDir, file));
        }
      }
    } catch {
      // Directory may not exist yet
    }
  }

  private processRequest(reqPath: string): void {
    const filename = basename(reqPath);
    // Skip if already seen (dedup between fs.watch and polling)
    if (this.seen.has(filename)) return;
    this.seen.add(filename);

    let request: SudoRequest;
    try {
      if (!existsSync(reqPath)) {
        this.seen.delete(filename);
        return;
      }
      const raw = readFileSync(reqPath, "utf-8");
      request = JSON.parse(raw) as SudoRequest;
    } catch (err) {
      this.seen.delete(filename);
      this.logger.warn("Failed to parse sudo request file.", {
        path: reqPath,
        reason: err instanceof Error ? err.message : "unknown"
      });
      return;
    }

    if (!request.id || !request.channelId || !request.chatId) {
      this.seen.delete(filename);
      this.logger.warn("Sudo request missing required fields.", { request });
      return;
    }

    this.pending.set(request.id, request);

    this.logger.info("Sudo permission request received.", {
      requestId: request.id,
      command: request.command?.slice(0, 200),
      chatId: request.chatId
    });

    // Emit a permission-request event — the hub's existing forwardPermissionRequest()
    // will handle showing the inline keyboard in Telegram.
    this.eventBus.emit({
      executionId: `sudo-${request.id}`,
      channelId: request.channelId,
      chatId: request.chatId,
      type: "permission-request",
      timestamp: request.timestamp || Date.now(),
      payload: {
        permissionRequestId: request.id,
        toolName: "sudo",
        toolInput: { command: request.command }
      }
    });
  }

  private writeResponse(requestId: string, decision: "allow" | "deny"): void {
    const request = this.pending.get(requestId);
    if (!request) return;

    this.pending.delete(requestId);

    const resPath = join(this.watchDir, `${requestId}.res`);
    try {
      writeFileSync(resPath, decision, "utf-8");
      this.logger.info("Sudo permission response written.", { requestId, decision });
    } catch (err) {
      this.logger.error("Failed to write sudo response file.", {
        requestId,
        reason: err instanceof Error ? err.message : "unknown"
      });
    }

    // Clean up the request file and seen set
    const reqFilename = `${requestId}.req`;
    this.seen.delete(reqFilename);
    const reqPath = join(this.watchDir, reqFilename);
    try { unlinkSync(reqPath); } catch { /* may already be deleted */ }
  }
}
