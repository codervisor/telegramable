import { randomUUID } from "crypto";
import { EventBus } from "../events/eventBus";
import { ExecutionEvent } from "../events/types";
import { IMAdapter, IMAdapterStartOptions, IMMessage } from "../gateway/types";
import { Logger } from "../logging";
import { ChunkThrottler } from "./chunkThrottler";
import { ExecutionRegistry, InMemoryExecutionRegistry } from "./executionRegistry";
import { PermissionBridge } from "./permissionBridge";
import { Router } from "./router";

const truncate = (text: string, max: number): string => {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 3)}...`;
};

type BuiltinCommand =
  | { type: "status"; executionId: string }
  | { type: "logs"; executionId: string }
  | { type: "list" }
  | null;

export const parseBuiltinCommand = (text: string): BuiltinCommand => {
  const trimmed = text.trim();

  const statusMatch = trimmed.match(/^\/status\s+([^\s]+)\s*$/i);
  if (statusMatch?.[1]) {
    return { type: "status", executionId: statusMatch[1] };
  }

  const logsMatch = trimmed.match(/^\/logs\s+([^\s]+)\s*$/i);
  if (logsMatch?.[1]) {
    return { type: "logs", executionId: logsMatch[1] };
  }

  if (/^\/list\s*$/i.test(trimmed)) {
    return { type: "list" };
  }

  return null;
};

const formatEvent = (event: ExecutionEvent): string | null => {
  switch (event.type) {
    case "complete":
      return event.payload?.response || null;
    case "error":
      return `Error: ${event.payload?.reason || "unknown"}`;
    default:
      return null;
  }
};

const PERMISSION_CALLBACK_PREFIX = "perm:";

/** Escape HTML special characters for Telegram HTML parse mode. */
const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Format a tool permission request as an HTML message for Telegram. */
const formatPermissionRequest = (toolName: string, toolInput: Record<string, unknown>): string => {
  const inputPreview = truncate(JSON.stringify(toolInput, null, 2), 500);
  return (
    `<b>🔐 Permission Request</b>\n\n` +
    `<b>Tool:</b> <code>${escapeHtml(toolName)}</code>\n` +
    `<blockquote expandable>${escapeHtml(inputPreview)}</blockquote>`
  );
};

export class ChannelHub {
  private readonly adapters = new Map<string, IMAdapter>();
  private readonly executionRegistry: ExecutionRegistry;
  private readonly chunkThrottlers = new Map<string, ChunkThrottler>();
  private readonly permissionBridge: PermissionBridge;
  private readonly topicMap = new Map<string, number>(); // "channelId:chatId:executionId" → topicId
  private readonly streamDrafts = new Map<string, { text: string; messageId?: number }>(); // for streaming text accumulation
  private readonly typingIntervals = new Map<string, ReturnType<typeof setInterval>>(); // periodic typing indicators
  private unsubscribeEvents?: () => void;

  constructor(
    adapters: IMAdapter[],
    private readonly router: Router,
    private readonly eventBus: EventBus,
    private readonly logger: Logger,
    executionRegistry?: ExecutionRegistry
  ) {
    this.executionRegistry = executionRegistry ?? new InMemoryExecutionRegistry();
    this.permissionBridge = new PermissionBridge(logger);

    for (const adapter of adapters) {
      if (this.adapters.has(adapter.id)) {
        throw new Error(`Duplicate channel id '${adapter.id}' in channel configuration.`);
      }
      this.adapters.set(adapter.id, adapter);
    }
  }

  async start(options?: IMAdapterStartOptions): Promise<void> {
    this.subscribeEvents();
    await Promise.all(Array.from(this.adapters.values()).map((adapter) => {
      return adapter.start((message) => void this.handleMessage({
        ...message,
        channelId: adapter.id
      }), options);
    }));

    this.logger.info("ChannelHub started.", { channels: Array.from(this.adapters.keys()) });
  }

  async stop(): Promise<void> {
    if (this.unsubscribeEvents) {
      this.unsubscribeEvents();
      this.unsubscribeEvents = undefined;
    }

    this.permissionBridge.cancelAll();

    // Clear all typing indicator intervals
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();

    for (const throttler of this.chunkThrottlers.values()) {
      await throttler.flush();
      throttler.destroy();
    }
    this.chunkThrottlers.clear();

    await Promise.all(Array.from(this.adapters.values()).map((adapter) => adapter.stop()));
    this.logger.info("ChannelHub stopped.");
  }

  private subscribeEvents(): void {
    if (this.unsubscribeEvents) {
      return;
    }

    this.unsubscribeEvents = this.eventBus.on(async (event) => {
      const adapter = this.adapters.get(event.channelId);
      if (!adapter) {
        this.logger.warn("No adapter found for execution event.", {
          channelId: event.channelId,
          executionId: event.executionId
        });
        return;
      }

      this.trackEvent(event);

      try {
        await this.forwardEvent(adapter, event);
      } catch (error) {
        this.logger.error("Failed to dispatch execution event.", {
          channelId: event.channelId,
          executionId: event.executionId,
          reason: error instanceof Error ? error.message : "unknown"
        });
      }
    });
  }

  private async handleMessage(message: IMMessage): Promise<void> {
    // Handle callback queries (inline keyboard responses)
    if (message.callbackData) {
      await this.handleCallbackQuery(message);
      return;
    }

    if (!message.text || message.text.trim().length === 0) {
      // Allow file-only messages to pass through
      if (!message.fileId) {
        this.logger.warn("Ignoring empty message.", {
          channelId: message.channelId,
          chatId: message.chatId
        });
        return;
      }
    }

    const adapter = this.adapters.get(message.channelId);
    const builtin = message.text ? parseBuiltinCommand(message.text) : null;
    if (adapter && builtin) {
      await this.handleBuiltinCommand(adapter, message, builtin);
      return;
    }

    const executionId = randomUUID();
    const { runtime, message: routedMessage } = this.router.select(message);

    if (adapter) {
      // Try to create a forum topic for this execution
      await this.tryCreateForumTopic(adapter, message.chatId, executionId, message.text || "New task");
    }

    this.logger.info("Received message.", {
      executionId,
      channelId: message.channelId,
      chatId: message.chatId
    });

    // Start typing indicator immediately so user sees activity
    if (adapter) {
      this.startTypingIndicator(adapter, message.chatId, executionId, this.getTopicId(message.channelId, message.chatId, executionId));
    }

    try {
      await runtime.execute(routedMessage, executionId, this.eventBus);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown";
      this.eventBus.emit({
        executionId,
        channelId: message.channelId,
        chatId: message.chatId,
        type: "error",
        timestamp: Date.now(),
        payload: { reason }
      });
      this.logger.error("Runtime execution failed.", { executionId, reason });
    }
  }

  private async handleCallbackQuery(message: IMMessage): Promise<void> {
    if (!message.callbackData?.startsWith(PERMISSION_CALLBACK_PREFIX)) {
      return;
    }

    const adapter = this.adapters.get(message.channelId);

    // Parse: "perm:<requestId>:<allow|deny>"
    const parts = message.callbackData.slice(PERMISSION_CALLBACK_PREFIX.length).split(":");
    const requestId = parts[0];
    const decision = parts[1] === "allow" ? "allow" as const : "deny" as const;

    if (!requestId) {
      return;
    }

    const responded = this.permissionBridge.respond(requestId, decision);

    // Acknowledge the callback query
    if (adapter?.answerCallbackQuery && message.callbackQueryId) {
      await adapter.answerCallbackQuery(
        message.callbackQueryId,
        responded ? `${decision === "allow" ? "✅ Approved" : "❌ Denied"}` : "Request expired."
      );
    }

    // Edit the original message to reflect the decision
    if (adapter?.editMessage && message.messageId) {
      const statusText = decision === "allow" ? "✅ <b>Approved</b>" : "❌ <b>Denied</b>";
      await adapter.editMessage(message.chatId, message.messageId, statusText).catch(() => {
        // Non-critical — message may have been deleted
      });
    }
  }

  private async tryCreateForumTopic(
    adapter: IMAdapter,
    chatId: string,
    executionId: string,
    taskPreview: string
  ): Promise<number | undefined> {
    if (!adapter.createForumTopic) {
      return undefined;
    }

    try {
      const topicName = `Claude: ${truncate(taskPreview, 60)}`;
      const topicId = await adapter.createForumTopic(chatId, topicName);
      this.topicMap.set(`${adapter.id}:${chatId}:${executionId}`, topicId);
      this.logger.debug("Forum topic created.", { chatId, executionId, topicId });
      return topicId;
    } catch (error) {
      // Forum topics require supergroup with topics enabled — graceful fallback
      this.logger.debug("Forum topic creation failed, using flat chat.", {
        chatId,
        reason: error instanceof Error ? error.message : "unknown"
      });
      return undefined;
    }
  }

  private getTopicId(channelId: string, chatId: string, executionId: string): number | undefined {
    return this.topicMap.get(`${channelId}:${chatId}:${executionId}`);
  }

  private trackEvent(event: ExecutionEvent): void {
    switch (event.type) {
      case "start":
        this.executionRegistry.start({
          executionId: event.executionId,
          channelId: event.channelId,
          chatId: event.chatId,
          agentName: event.payload?.agentName || "unknown",
          startedAt: event.timestamp
        });
        break;
      case "stdout":
      case "stderr": {
        const label = `[${event.type}]`;
        const text = event.payload?.text || "";
        this.executionRegistry.append(event.executionId, `${label} ${text}`);
        break;
      }
      case "complete":
        this.executionRegistry.complete(event.executionId, event.timestamp);
        break;
      case "error":
        this.executionRegistry.error(event.executionId, event.payload?.reason || "unknown", event.timestamp);
        break;
      default:
        break;
    }
  }

  private startTypingIndicator(adapter: IMAdapter, chatId: string, executionId: string, topicId?: number): void {
    if (!adapter.sendChatAction) return;

    const key = `${adapter.id}:${chatId}:${executionId}`;

    // Send immediately, then repeat every 4s (Telegram typing expires after ~5s)
    const sendTyping = () => {
      adapter.sendChatAction!(chatId, "typing", { threadId: topicId }).catch(() => {
        // Non-critical — chat action may fail if bot was blocked
      });
    };

    sendTyping();
    const interval = setInterval(sendTyping, 4_000);
    this.typingIntervals.set(key, interval);
  }

  private stopTypingIndicator(channelId: string, chatId: string, executionId: string): void {
    const key = `${channelId}:${chatId}:${executionId}`;
    const interval = this.typingIntervals.get(key);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(key);
    }
  }

  private async forwardEvent(adapter: IMAdapter, event: ExecutionEvent): Promise<void> {
    const topicId = this.getTopicId(event.channelId, event.chatId, event.executionId);

    // Handle permission requests — send inline keyboard
    if (event.type === "permission-request") {
      await this.forwardPermissionRequest(adapter, event, topicId);
      return;
    }

    // Handle streaming text — accumulate and edit message in-place
    if (event.type === "stream-text") {
      // Stop typing indicator once we start streaming actual text
      this.stopTypingIndicator(event.channelId, event.chatId, event.executionId);
      await this.forwardStreamText(adapter, event, topicId);
      return;
    }

    if (event.type === "complete" || event.type === "error") {
      // Always stop typing indicator on completion
      this.stopTypingIndicator(event.channelId, event.chatId, event.executionId);
      await this.flushAndDeleteThrottler(event.channelId, event.chatId);
      await this.flushStreamDraft(adapter, event.channelId, event.chatId, event.executionId);

      // Close forum topic on completion
      if (topicId && adapter.closeForumTopic) {
        adapter.closeForumTopic(event.chatId, topicId).catch(() => {
          // Non-critical
        });
        this.topicMap.delete(`${event.channelId}:${event.chatId}:${event.executionId}`);
      }
    }

    const text = formatEvent(event);
    if (text) {
      await adapter.sendMessage(event.chatId, text);
    }
  }

  private async forwardPermissionRequest(adapter: IMAdapter, event: ExecutionEvent, topicId?: number): Promise<void> {
    const requestId = event.payload?.permissionRequestId;
    const toolName = event.payload?.toolName || "unknown";
    const toolInput = event.payload?.toolInput || {};

    if (!requestId) {
      this.logger.warn("Permission request missing requestId.", { executionId: event.executionId });
      return;
    }

    // Register with the permission bridge
    const decisionPromise = this.permissionBridge.request({
      requestId,
      executionId: event.executionId,
      channelId: event.channelId,
      chatId: event.chatId,
      toolName,
      toolInput
    });

    // Send inline keyboard via adapter
    if (adapter.sendMessageWithMarkup) {
      const markup = {
        inline_keyboard: [[
          { text: "✅ Approve", callback_data: `${PERMISSION_CALLBACK_PREFIX}${requestId}:allow` },
          { text: "❌ Deny", callback_data: `${PERMISSION_CALLBACK_PREFIX}${requestId}:deny` }
        ]]
      };

      await adapter.sendMessageWithMarkup(
        event.chatId,
        formatPermissionRequest(toolName, toolInput),
        markup,
        { threadId: topicId }
      );
    } else {
      // Fallback: send plain text and auto-deny
      await adapter.sendMessage(
        event.chatId,
        `Permission request for tool "${toolName}" — auto-denied (no inline keyboard support).`
      );
      this.permissionBridge.respond(requestId, "deny");
    }

    // Wait for the decision and emit permission-response event
    const decision = await decisionPromise;
    this.eventBus.emit({
      executionId: event.executionId,
      channelId: event.channelId,
      chatId: event.chatId,
      type: "permission-response",
      timestamp: Date.now(),
      payload: {
        permissionRequestId: requestId,
        decision
      }
    });
  }

  private async forwardStreamText(adapter: IMAdapter, event: ExecutionEvent, topicId?: number): Promise<void> {
    const text = event.payload?.text || "";
    const draftKey = `${event.channelId}:${event.chatId}:${event.executionId}`;

    let draft = this.streamDrafts.get(draftKey);
    if (!draft) {
      draft = { text: "" };
      this.streamDrafts.set(draftKey, draft);
    }

    draft.text += text;

    // Throttle edits: only update every ~500 chars or if we haven't sent yet
    const shouldUpdate = !draft.messageId || draft.text.length % 500 < text.length;

    if (shouldUpdate && adapter.editMessage && draft.messageId) {
      const displayText = truncate(draft.text, 4000);
      await adapter.editMessage(event.chatId, draft.messageId, escapeHtml(displayText)).catch(() => {
        // Edit might fail if message was deleted; non-critical
      });
    } else if (!draft.messageId) {
      // Send initial message
      if (adapter.sendMessageWithMarkup) {
        const messageId = await adapter.sendMessageWithMarkup(
          event.chatId,
          escapeHtml(truncate(draft.text, 4000)),
          undefined,
          { threadId: topicId }
        );
        draft.messageId = messageId;
      } else {
        await adapter.sendMessage(event.chatId, truncate(draft.text, 3500));
      }
    }
  }

  private async flushStreamDraft(adapter: IMAdapter, channelId: string, chatId: string, executionId: string): Promise<void> {
    const draftKey = `${channelId}:${chatId}:${executionId}`;
    const draft = this.streamDrafts.get(draftKey);
    if (!draft) return;

    // Final edit with complete text
    if (draft.messageId && adapter.editMessage) {
      const displayText = truncate(draft.text, 4000);
      await adapter.editMessage(chatId, draft.messageId, escapeHtml(displayText)).catch(() => {});
    }

    this.streamDrafts.delete(draftKey);
  }

  private getChunkThrottler(channelId: string, chatId: string, adapter: IMAdapter): ChunkThrottler {
    const key = `${channelId}:${chatId}`;
    const existing = this.chunkThrottlers.get(key);
    if (existing) {
      return existing;
    }

    const throttler = new ChunkThrottler({
      flushIntervalMs: 1_000,
      maxChunkLength: 3_500,
      send: async (text) => {
        await adapter.sendMessage(chatId, text);
      }
    });

    this.chunkThrottlers.set(key, throttler);
    return throttler;
  }

  private async flushAndDeleteThrottler(channelId: string, chatId: string): Promise<void> {
    const key = `${channelId}:${chatId}`;
    const throttler = this.chunkThrottlers.get(key);
    if (!throttler) {
      return;
    }

    await throttler.flush();
    throttler.destroy();
    this.chunkThrottlers.delete(key);
  }

  private async handleBuiltinCommand(
    adapter: IMAdapter,
    message: IMMessage,
    command: Exclude<BuiltinCommand, null>
  ): Promise<void> {
    if (command.type === "list") {
      const records = this.executionRegistry.list(message.channelId, message.chatId).slice(0, 10);
      if (records.length === 0) {
        await adapter.sendMessage(message.chatId, "Recent executions (this chat):\n• (none)");
        return;
      }

      const lines = records.map((record) => {
        const icon = record.status === "complete" ? "✅" : record.status === "error" ? "❌" : "⏳";
        const statusLabel = record.status === "complete" ? "Complete" : record.status === "error" ? "Error" : "Running";
        const isoTime = new Date(record.startedAt).toISOString().slice(11, 19);
        return `• ${record.executionId} ${icon} ${statusLabel} ${isoTime}Z`;
      });

      await adapter.sendMessage(message.chatId, `Recent executions (this chat):\n${lines.join("\n")}`);
      return;
    }

    const record = this.executionRegistry.get(command.executionId);
    if (!record || record.channelId !== message.channelId || record.chatId !== message.chatId) {
      await adapter.sendMessage(message.chatId, `Unknown execution ID: ${command.executionId}`);
      return;
    }

    if (command.type === "status") {
      const endTime = record.finishedAt ?? Date.now();
      const duration = Math.max(0, Math.floor((endTime - record.startedAt) / 1_000));
      const firstLine = record.status === "running"
        ? `⏳ Running (${duration}s) · ${record.executionId}`
        : record.status === "complete"
          ? `✅ Complete (${duration}s) · ${record.executionId}`
          : `❌ Error (${duration}s) · ${record.executionId}`;

      if (record.status === "running") {
        const lastLine = record.outputLines[record.outputLines.length - 1];
        const lastOutput = lastLine ? `Last output: ${lastLine}` : "Last output: (none)";
        await adapter.sendMessage(message.chatId, `${firstLine}\n${lastOutput}`);
        return;
      }

      if (record.status === "complete") {
        await adapter.sendMessage(
          message.chatId,
          `${firstLine}\nFinished: ${new Date(record.finishedAt || Date.now()).toISOString()}`
        );
        return;
      }

      await adapter.sendMessage(message.chatId, `${firstLine}\nReason: ${record.errorReason || "unknown"}`);
      return;
    }

    const lines = record.outputLines;
    await adapter.sendMessage(
      message.chatId,
      lines.length > 0 ? lines.join("\n") : "No output captured for this execution yet."
    );
  }
}
