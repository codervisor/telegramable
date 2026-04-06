import { randomUUID } from "crypto";
import type { query as sdkQuery, SDKMessage, SDKUserMessage, PermissionResult, McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { AgentConfig } from "../../config";
import { EventBus } from "../../events/eventBus";
import { Logger } from "../../logging";
import { AgentSession } from "./types";

export interface SdkClaudeSessionOptions {
  model?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  maxBudgetUsd?: number;
  cwd?: string;
  /** Additional system prompt section injected at query time (e.g. memory facts). */
  getSystemPromptSuffix?: () => string;
  /** MCP servers to make available to the agent (e.g. memory tools). */
  mcpServers?: Record<string, McpServerConfig>;
}

/**
 * Async queue for feeding user messages into the SDK's async generator input.
 */
class AsyncMessageQueue {
  private queue: SDKUserMessage[] = [];
  private waitResolve?: (value: IteratorResult<SDKUserMessage, void>) => void;
  private done = false;

  push(message: SDKUserMessage): void {
    if (this.done) return;

    if (this.waitResolve) {
      const resolve = this.waitResolve;
      this.waitResolve = undefined;
      resolve({ value: message, done: false });
    } else {
      this.queue.push(message);
    }
  }

  close(): void {
    this.done = true;
    if (this.waitResolve) {
      const resolve = this.waitResolve;
      this.waitResolve = undefined;
      resolve({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage, void> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage, void>> => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false } as IteratorResult<SDKUserMessage, void>);
        }

        if (this.done) {
          return Promise.resolve({ value: undefined as never, done: true });
        }

        return new Promise((resolve) => {
          this.waitResolve = resolve;
        });
      }
    };
  }
}

export class SdkClaudeSession implements AgentSession {
  readonly sessionId = randomUUID();
  private sdkSessionId?: string;
  private messageQueue?: AsyncMessageQueue;
  private activeQuery?: AsyncGenerator<SDKMessage, void>;
  private sdkQueryFn?: typeof sdkQuery;
  private readonly options: SdkClaudeSessionOptions;

  get resumeId(): string | undefined {
    return this.sdkSessionId;
  }

  setResumeId(id: string): void {
    this.sdkSessionId = id;
  }

  constructor(
    readonly channelId: string,
    readonly chatId: string,
    private readonly config: AgentConfig,
    options?: SdkClaudeSessionOptions,
    private readonly logger?: Logger
  ) {
    this.options = options ?? {};
  }

  async send(userText: string, executionId: string, eventBus: EventBus): Promise<string> {
    // Lazy-load the SDK to avoid import issues in test environments
    if (!this.sdkQueryFn) {
      this.logger?.info("Loading Claude Agent SDK...", { sessionId: this.sessionId });
      try {
        const sdk = await import("@anthropic-ai/claude-agent-sdk");
        this.sdkQueryFn = sdk.query;
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown";
        this.logger?.error("Failed to load Claude Agent SDK.", { reason });
        throw new Error(`Failed to load Claude Agent SDK: ${reason}`);
      }
    }

    const hasOAuthToken = !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
    this.logger?.info("SDK session send.", {
      executionId,
      sessionId: this.sessionId,
      sdkSessionId: this.sdkSessionId,
      hasOAuthToken,
      hasApiKey,
      model: this.options.model || this.config.env?.CLAUDE_MODEL || "(default)"
    });

    if (!hasOAuthToken && !hasApiKey) {
      this.logger?.warn("No CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY found in environment. SDK query will likely fail.");
    }

    return this.executeQuery(userText, executionId, eventBus);
  }

  async close(): Promise<void> {
    this.messageQueue?.close();
    this.messageQueue = undefined;
    this.activeQuery = undefined;
    this.sdkSessionId = undefined;
  }

  private async executeQuery(userText: string, executionId: string, eventBus: EventBus): Promise<string> {
    const query = this.sdkQueryFn!;
    const timeoutMs = this.config.timeoutMs ?? 10 * 60 * 1000;

    const abortController = new AbortController();
    let resultText = "";
    let messageCount = 0;

    // Activity-based timeout: resets on each SDK message so long-running
    // but active queries (tool use, streaming) don't get killed.
    let timeout!: ReturnType<typeof setTimeout>;
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        this.logger?.error("SDK query timeout — aborting.", { executionId, timeoutMs, messageCount });
        abortController.abort();
      }, timeoutMs);
    };
    resetTimeout();

    this.logger?.debug("Starting SDK query.", { executionId, timeoutMs });

    let sdkQuery: AsyncGenerator<SDKMessage, void>;
    try {
      sdkQuery = query({
        prompt: userText,
        options: {
          abortController,
          model: this.options.model || this.config.env?.CLAUDE_MODEL,
          systemPrompt: (this.options.systemPrompt || "") + (this.options.getSystemPromptSuffix?.() || ""),
          allowedTools: this.options.allowedTools,
          mcpServers: this.options.mcpServers,
          maxBudgetUsd: this.options.maxBudgetUsd,
          cwd: this.options.cwd || this.config.workingDir,
          resume: this.sdkSessionId,
          includePartialMessages: true,
          permissionMode: "default",
          canUseTool: async (toolName: string, toolInput: Record<string, unknown>, opts: { signal: AbortSignal }) => {
            return this.handlePermissionRequest(executionId, eventBus, toolName, toolInput, opts.signal);
          }
        }
      });
    } catch (error) {
      clearTimeout(timeout);
      const reason = error instanceof Error ? error.message : "unknown";
      this.logger?.error("SDK query() call failed — possible auth or config error.", { executionId, reason });
      throw new Error(`SDK query initialization failed: ${reason}`);
    }

    this.activeQuery = sdkQuery;

    try {
      for await (const message of sdkQuery) {
        messageCount++;
        resetTimeout(); // Reset inactivity timeout on each message
        this.logger?.debug("SDK message received.", { executionId, type: message.type, subtype: (message as { subtype?: string }).subtype, messageCount });
        this.processMessage(message, executionId, eventBus);

        if (message.type === "result") {
          this.sdkSessionId = message.session_id;
          if (message.subtype === "success") {
            resultText = message.result;
          } else {
            const errorMsg = "duration_ms" in message ? `SDK error after ${message.duration_ms}ms` : "SDK execution error";
            this.logger?.error("SDK returned error result.", { executionId, errorMsg, message: JSON.stringify(message) });
            throw new Error(errorMsg);
          }
        }

        if (message.type === "system" && message.subtype === "init") {
          this.sdkSessionId = message.session_id;
          this.logger?.info("SDK session initialized.", { executionId, sdkSessionId: this.sdkSessionId });
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown";
      this.logger?.error("SDK query iteration failed.", { executionId, reason, messageCount });
      throw error;
    } finally {
      clearTimeout(timeout);
      this.activeQuery = undefined;
    }

    if (!resultText && messageCount === 0) {
      this.logger?.warn("SDK query completed with zero messages — likely auth failure or silent error.", { executionId });
    } else if (!resultText) {
      this.logger?.warn("SDK query completed with no result text.", { executionId, messageCount });
    } else {
      this.logger?.debug("SDK query completed.", { executionId, messageCount, resultLength: resultText.length });
    }

    return resultText;
  }

  private processMessage(message: SDKMessage, executionId: string, eventBus: EventBus): void {
    const base = {
      executionId,
      channelId: this.channelId,
      chatId: this.chatId,
      timestamp: Date.now()
    };

    switch (message.type) {
      case "assistant": {
        // Extract text and tool-use from assistant message content blocks
        if (message.message?.content) {
          for (const block of message.message.content) {
            if ("text" in block && typeof block.text === "string") {
              eventBus.emit({
                ...base,
                type: "stdout",
                payload: { text: block.text }
              });
            } else if ("name" in block && typeof block.name === "string") {
              const toolInput = "input" in block && typeof block.input === "object" ? block.input as Record<string, unknown> : undefined;
              eventBus.emit({
                ...base,
                type: "tool-use",
                payload: { toolName: block.name, toolInput }
              });
            }
          }
        }
        break;
      }

      case "stream_event": {
        const event = message.event;
        if (event.type === "content_block_delta" && "delta" in event) {
          const delta = event.delta as { type: string; text?: string };
          if (delta.type === "text_delta" && delta.text) {
            eventBus.emit({
              ...base,
              type: "stream-text",
              payload: { text: delta.text, sessionId: this.sdkSessionId }
            });
          }
        }
        break;
      }

      default:
        // Other message types (system, status, etc.) are handled implicitly
        break;
    }
  }

  private async handlePermissionRequest(
    executionId: string,
    eventBus: EventBus,
    toolName: string,
    toolInput: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<PermissionResult> {
    const requestId = randomUUID();

    // Emit permission request event — the hub will forward this to Telegram as an inline keyboard
    eventBus.emit({
      executionId,
      channelId: this.channelId,
      chatId: this.chatId,
      type: "permission-request",
      timestamp: Date.now(),
      payload: {
        permissionRequestId: requestId,
        toolName,
        toolInput
      }
    });

    // Wait for the permission-response event from the hub
    const decision = await new Promise<"allow" | "deny">((resolve) => {
      const onAbort = () => resolve("deny");
      signal.addEventListener("abort", onAbort, { once: true });

      const unsubscribe = eventBus.on((event) => {
        if (
          event.type === "permission-response" &&
          event.payload?.permissionRequestId === requestId
        ) {
          signal.removeEventListener("abort", onAbort);
          unsubscribe();
          resolve(event.payload.decision ?? "deny");
        }
      });
    });

    if (decision === "allow") {
      return { behavior: "allow", updatedInput: toolInput };
    }

    return { behavior: "deny", message: "User denied via Telegram." };
  }
}
