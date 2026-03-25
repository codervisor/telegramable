import { Logger } from "../logging";

export interface PendingPermission {
  requestId: string;
  executionId: string;
  channelId: string;
  chatId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  resolve: (decision: "allow" | "deny") => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

export class PermissionBridge {
  private readonly pending = new Map<string, PendingPermission>();
  private readonly defaultTimeoutMs: number;

  constructor(
    private readonly logger: Logger,
    options?: { defaultTimeoutMs?: number }
  ) {
    this.defaultTimeoutMs = options?.defaultTimeoutMs ?? 5 * 60 * 1000; // 5 minutes
  }

  /**
   * Register a permission request. Returns a promise that resolves when the user
   * responds via inline keyboard callback or times out (defaulting to deny).
   */
  request(params: {
    requestId: string;
    executionId: string;
    channelId: string;
    chatId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
  }): Promise<"allow" | "deny"> {
    return new Promise<"allow" | "deny">((resolve) => {
      const timeoutHandle = setTimeout(() => {
        this.logger.warn("Permission request timed out, denying.", {
          requestId: params.requestId,
          toolName: params.toolName
        });
        this.pending.delete(params.requestId);
        resolve("deny");
      }, this.defaultTimeoutMs);

      this.pending.set(params.requestId, {
        ...params,
        resolve,
        timeoutHandle
      });
    });
  }

  /**
   * Resolve a pending permission request with a user decision.
   * Called when a Telegram callback query arrives.
   */
  respond(requestId: string, decision: "allow" | "deny"): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) {
      this.logger.warn("No pending permission request found.", { requestId });
      return false;
    }

    clearTimeout(pending.timeoutHandle);
    this.pending.delete(requestId);
    pending.resolve(decision);
    return true;
  }

  /**
   * Cancel all pending permission requests (e.g. on shutdown).
   */
  cancelAll(): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timeoutHandle);
      pending.resolve("deny");
      this.pending.delete(requestId);
    }
  }

  hasPending(requestId: string): boolean {
    return this.pending.has(requestId);
  }
}
