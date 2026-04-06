import { randomUUID } from "crypto";
import { EventBus } from "../events/eventBus";
import { ExecutionEvent } from "../events/types";
import { IMAdapter, IMAdapterStartOptions, IMMessage } from "../gateway/types";
import { Logger } from "../logging";
import { formatMemoryList } from "../memory";
import { MemoryProvider } from "../memory/provider";
import { MemorySync } from "../memory/sync";
import { FileSessionStore } from "../runtime/session/fileSessionStore";
import { ChunkThrottler } from "./chunkThrottler";
import { ExecutionRegistry, InMemoryExecutionRegistry } from "./executionRegistry";
import { markdownToTelegramHtml } from "./markdownToHtml";
import {
  MEMORY_CALLBACK_PREFIX,
  buildMemoryListMarkup,
  buildClearConfirmMarkup,
  buildChannelInfoMarkup,
} from "./memoryMarkup";
import { PermissionBridge } from "./permissionBridge";
import { Router } from "./router";
import { SudoWatcher } from "./sudoWatcher";

const TELEGRAM_MSG_LIMIT = 4000;

const truncate = (text: string, max: number): string => {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 3)}...`;
};

/**
 * Split text into chunks that fit within Telegram's message limit.
 * Tries to break at paragraph boundaries, then line boundaries, then hard-cuts.
 */
const splitMessage = (text: string, max: number = TELEGRAM_MSG_LIMIT): string[] => {
  if (text.length <= max) {
    return [text];
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > max) {
    let splitAt = remaining.lastIndexOf("\n\n", max);
    if (splitAt <= 0) {
      splitAt = remaining.lastIndexOf("\n", max);
    }
    if (splitAt <= 0) {
      splitAt = max;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
};

type BuiltinCommand =
  | { type: "start" }
  | { type: "help" }
  | { type: "status"; executionId: string }
  | { type: "logs"; executionId: string }
  | { type: "list" }
  | { type: "memory" }
  | { type: "memory-search"; query: string }
  | { type: "memory-edit"; id: string; text: string }
  | { type: "memory-delete"; id: string }
  | { type: "memory-export" }
  | { type: "memory-clear" }
  | { type: "memory-channel" }
  | null;

export const parseBuiltinCommand = (text: string): BuiltinCommand => {
  const trimmed = text.trim();

  if (/^\/start\s*$/i.test(trimmed)) {
    return { type: "start" };
  }

  if (/^\/help\s*$/i.test(trimmed)) {
    return { type: "help" };
  }

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

  // Memory commands
  const memEditMatch = trimmed.match(/^\/memory\s+edit\s+(f\d+)\s+(.+)$/i);
  if (memEditMatch?.[1] && memEditMatch[2]) {
    return { type: "memory-edit", id: memEditMatch[1], text: memEditMatch[2] };
  }

  const memDeleteMatch = trimmed.match(/^\/memory\s+delete\s+(f\d+)\s*$/i);
  if (memDeleteMatch?.[1]) {
    return { type: "memory-delete", id: memDeleteMatch[1] };
  }

  const memSearchMatch = trimmed.match(/^\/memory\s+search\s+(.+)$/i);
  if (memSearchMatch?.[1]) {
    return { type: "memory-search", query: memSearchMatch[1] };
  }

  if (/^\/memory\s+export\s*$/i.test(trimmed)) {
    return { type: "memory-export" };
  }

  if (/^\/memory\s+clear\s*$/i.test(trimmed)) {
    return { type: "memory-clear" };
  }

  if (/^\/memory\s+channel\s*$/i.test(trimmed)) {
    return { type: "memory-channel" };
  }

  if (/^\/memory\s*$/i.test(trimmed)) {
    return { type: "memory" };
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

/** Format a duration in milliseconds to a human-readable string. */
const formatDuration = (ms: number): string => {
  const totalSeconds = Math.floor(ms / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
};

/** Format a human-readable tool activity description (like Claude Code mobile). */
const formatToolDescription = (toolName: string, toolInput?: Record<string, unknown>): string => {
  if (!toolInput) return `<b>${escapeHtml(toolName)}</b>`;

  const short = (val: unknown, max = 40): string => {
    const str = typeof val === "string" ? val : JSON.stringify(val);
    return escapeHtml(truncate(str, max));
  };

  // Extract a meaningful detail from the tool input based on common patterns
  const filePath = toolInput.file_path ?? toolInput.path ?? toolInput.filePath;
  const command = toolInput.command;
  const pattern = toolInput.pattern ?? toolInput.query ?? toolInput.regex;
  const prompt = toolInput.prompt ?? toolInput.description ?? toolInput.message;

  switch (toolName.toLowerCase()) {
    case "read":
      return filePath ? `Reading <code>${short(filePath)}</code>` : "<b>Read</b>";
    case "write":
      return filePath ? `Writing <code>${short(filePath)}</code>` : "<b>Write</b>";
    case "edit":
      return filePath ? `Editing <code>${short(filePath)}</code>` : "<b>Edit</b>";
    case "glob":
      return pattern ? `Finding files <code>${short(pattern)}</code>` : "Finding files";
    case "grep":
      return pattern ? `Searching for <code>${short(pattern)}</code>` : "Searching code";
    case "bash":
      return command ? `Running <code>${short(command, 60)}</code>` : "Running command";
    case "agent":
      return prompt ? `Agent: ${short(prompt, 50)}` : "Running sub-agent";
    default: {
      // For unknown tools, show the tool name with the first string input value
      const firstVal = Object.values(toolInput).find((v) => typeof v === "string");
      return firstVal
        ? `<b>${escapeHtml(toolName)}</b> <code>${short(firstVal)}</code>`
        : `<b>${escapeHtml(toolName)}</b>`;
    }
  }
};

/** Format a tool permission request as an HTML message for Telegram. */
const formatPermissionRequest = (toolName: string, toolInput: Record<string, unknown>): string => {
  const inputPreview = truncate(JSON.stringify(toolInput, null, 2), 500);
  return (
    `<b>🔐 Permission Request</b>\n\n` +
    `<b>Tool:</b> <code>${escapeHtml(toolName)}</code>\n` +
    `<blockquote expandable>${escapeHtml(inputPreview)}</blockquote>`
  );
};

export interface MemoryChannelInfo {
  /** The resolved numeric chat ID currently in use. */
  resolvedChatId: string;
  /** The raw configured value (e.g. @my_agent_memory). */
  rawChatId?: string;
  /** How the chat ID was obtained. */
  cacheSource?: "cached" | "resolved" | "direct";
  /** Cache store for flushing entries. */
  cacheStore?: FileSessionStore;
}

export class ChannelHub {
  private readonly adapters = new Map<string, IMAdapter>();
  private readonly executionRegistry: ExecutionRegistry;
  private readonly chunkThrottlers = new Map<string, ChunkThrottler>();
  private readonly permissionBridge: PermissionBridge;
  private readonly topicMap = new Map<string, number>(); // "channelId:chatId:executionId" → topicId
  private readonly streamDrafts = new Map<string, { text: string; messageId?: number }>(); // for streaming text accumulation
  private readonly typingIntervals = new Map<string, ReturnType<typeof setInterval>>(); // periodic typing indicators
  private readonly toolActivityMessages = new Map<string, { tools: Array<{ name: string; input?: Record<string, unknown> }>; messageId?: number; promotionTimer?: ReturnType<typeof setTimeout>; promoted: boolean }>(); // tool activity tracking
  private readonly eventQueues = new Map<string, Promise<void>>(); // serialize events per execution
  private readonly reactionMessageIds = new Map<string, number>(); // executionId → source messageId for clearing reactions
  private unsubscribeEvents?: () => void;
  private readonly sudoWatcher?: SudoWatcher;

  constructor(
    adapters: IMAdapter[],
    private readonly router: Router,
    private readonly eventBus: EventBus,
    private readonly logger: Logger,
    executionRegistry?: ExecutionRegistry,
    private readonly memoryProvider?: MemoryProvider,
    private readonly memoryChannelInfo?: MemoryChannelInfo,
    /** @deprecated Use memoryProvider instead. Kept for backward compat with MemorySync audit log. */
    private readonly memorySync?: MemorySync
  ) {
    this.executionRegistry = executionRegistry ?? new InMemoryExecutionRegistry();
    this.permissionBridge = new PermissionBridge(logger);

    // Start the sudo wrapper watcher if a directory is configured (or use default)
    const sudoDir = process.env.TELEGRAMABLE_SUDO_DIR || "/tmp/telegramable-sudo";
    this.sudoWatcher = new SudoWatcher(sudoDir, eventBus, logger);

    for (const adapter of adapters) {
      if (this.adapters.has(adapter.id)) {
        throw new Error(`Duplicate channel id '${adapter.id}' in channel configuration.`);
      }
      this.adapters.set(adapter.id, adapter);
    }
  }

  async start(options?: IMAdapterStartOptions): Promise<void> {
    this.subscribeEvents();
    this.sudoWatcher?.start();
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
    this.sudoWatcher?.stop();

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
    for (const activity of this.toolActivityMessages.values()) {
      if (activity.promotionTimer) clearTimeout(activity.promotionTimer);
    }
    this.toolActivityMessages.clear();
    this.eventQueues.clear();
    this.reactionMessageIds.clear();

    await Promise.all(Array.from(this.adapters.values()).map((adapter) => adapter.stop()));
    this.logger.info("ChannelHub stopped.");
  }

  private subscribeEvents(): void {
    if (this.unsubscribeEvents) {
      return;
    }

    this.unsubscribeEvents = this.eventBus.on((event) => {
      const adapter = this.adapters.get(event.channelId);
      if (!adapter) {
        this.logger.warn("No adapter found for execution event.", {
          channelId: event.channelId,
          executionId: event.executionId
        });
        return;
      }

      this.trackEvent(event);

      // Serialize event processing per execution to prevent race conditions
      // (e.g. stream-text sendMessage not yet resolved when complete fires)
      const queueKey = event.executionId;
      const prev = this.eventQueues.get(queueKey) ?? Promise.resolve();
      const next = prev.then(async () => {
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
      this.eventQueues.set(queueKey, next);

      // Clean up queue entry when chain settles
      void next.then(() => {
        if (this.eventQueues.get(queueKey) === next) {
          this.eventQueues.delete(queueKey);
        }
      });
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

    // Prepend quoted/reply message context so the agent sees what the user is replying to.
    // Truncate to avoid exceeding OS argv limits in CLI runtime path.
    const MAX_REPLY_CONTEXT = 500;
    const replyContext = message.replyToText
      ? truncate(message.replyToText, MAX_REPLY_CONTEXT)
      : undefined;
    const enrichedMessage = replyContext
      ? { ...message, text: `[Quoted message]\n${replyContext}\n[End quoted message]\n\n${message.text}` }
      : message;

    const executionId = randomUUID();
    const { runtime, message: routedMessage } = this.router.select(enrichedMessage);

    if (adapter) {
      // Try to create a forum topic for this execution
      await this.tryCreateForumTopic(adapter, message.chatId, executionId, message.text || "New task");
    }

    this.logger.info("Received message.", {
      executionId,
      channelId: message.channelId,
      chatId: message.chatId,
      text: message.text ? message.text.slice(0, 200) : undefined,
      fileId: message.fileId || undefined
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
    if (message.callbackData?.startsWith(MEMORY_CALLBACK_PREFIX)) {
      await this.handleMemoryCallback(message);
      return;
    }

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

  private async handleMemoryCallback(message: IMMessage): Promise<void> {
    const adapter = this.adapters.get(message.channelId);
    if (!adapter) return;

    const data = message.callbackData!.slice(MEMORY_CALLBACK_PREFIX.length);
    const [action, ...rest] = data.split(":");
    const param = rest.join(":");

    const ack = async (text?: string) => {
      if (adapter.answerCallbackQuery && message.callbackQueryId) {
        await adapter.answerCallbackQuery(message.callbackQueryId, text);
      }
    };

    const editMarkup = async (text: string, markup: unknown) => {
      if (adapter.editMessageWithMarkup && message.messageId) {
        await adapter.editMessageWithMarkup(message.chatId, message.messageId, text, markup).catch(() => {});
      } else if (adapter.editMessage && message.messageId) {
        await adapter.editMessage(message.chatId, message.messageId, text).catch(() => {});
      }
    };

    if (action === "noop") {
      await ack();
      return;
    }

    if (action === "delete") {
      if (!this.memoryProvider) {
        await ack("Memory not configured.");
        return;
      }
      // param may be "<factId>" or "<factId>:<page>"
      const [factId, pageStr] = param.split(":");
      const page = pageStr ? parseInt(pageStr, 10) || 0 : 0;
      if (await this.memoryProvider.remove(factId)) {
        await ack(`Deleted ${factId}`);
        // Re-render the list in-place, preserving the current page
        const { text, markup } = buildMemoryListMarkup(this.memoryProvider.all(), page);
        await editMarkup(text, markup);
      } else {
        await ack(`Unknown: ${factId}`);
      }
      return;
    }

    if (action === "page") {
      if (!this.memoryProvider) {
        await ack("Memory not configured.");
        return;
      }
      const page = parseInt(param, 10) || 0;
      const { text, markup } = buildMemoryListMarkup(this.memoryProvider.all(), page);
      await editMarkup(text, markup);
      await ack();
      return;
    }

    if (action === "clear") {
      if (!this.memoryProvider) {
        await ack("Memory not configured.");
        return;
      }

      if (param === "prompt") {
        const count = this.memoryProvider.all().length;
        if (count === 0) {
          await ack("No memories to clear.");
          return;
        }
        const { text, markup } = buildClearConfirmMarkup(count);
        await editMarkup(text, markup);
        await ack();
        return;
      }

      if (param === "confirm") {
        await this.memoryProvider.clear();
        await ack("All memories cleared.");
        const { text, markup } = buildMemoryListMarkup(this.memoryProvider.all());
        await editMarkup(text, markup);
        return;
      }

      if (param === "cancel") {
        // Re-render the list
        const { text, markup } = buildMemoryListMarkup(this.memoryProvider.all());
        await editMarkup(text, markup);
        await ack("Cancelled.");
        return;
      }
      return;
    }

    if (action === "export") {
      if (!this.memoryProvider) {
        await ack("Memory not configured.");
        return;
      }
      if (adapter.sendDocument) {
        const json = JSON.stringify(this.memoryProvider.all(), null, 2);
        await adapter.sendDocument(message.chatId, Buffer.from(json, "utf-8"), {
          fileName: "memory.json",
          caption: `${this.memoryProvider.all().length} facts exported.`,
        });
        await ack();
      } else {
        await ack("Export not supported on this adapter.");
      }
      return;
    }

    if (action === "channel") {
      if (!this.memoryChannelInfo) {
        await ack("No channel info available.");
        return;
      }
      const { text, markup } = buildChannelInfoMarkup(
        this.memoryChannelInfo.resolvedChatId,
        this.memoryChannelInfo.rawChatId,
        this.memoryChannelInfo.cacheSource
      );
      await editMarkup(text, markup);
      await ack();
      return;
    }

    if (action === "cache") {
      if (param === "flush") {
        if (!this.memoryChannelInfo?.cacheStore || !this.memoryChannelInfo.rawChatId) {
          await ack("No cache to flush.");
          return;
        }
        try {
          this.memoryChannelInfo.cacheStore.delete(this.memoryChannelInfo.rawChatId);
          this.logger.info("Memory chat ID cache flushed.", { rawChatId: this.memoryChannelInfo.rawChatId });
          await ack("Cache flushed!");
          if (adapter.editMessage && message.messageId) {
            await adapter.editMessage(
              message.chatId,
              message.messageId,
              "🔄 <b>Cache flushed.</b>\n\nThe memory chat ID cache has been cleared. Restart the bot to re-resolve the channel."
            ).catch(() => {});
          }
        } catch (error) {
          this.logger.error("Failed to flush memory chat ID cache.", {
            rawChatId: this.memoryChannelInfo.rawChatId,
            reason: error instanceof Error ? error.message : "unknown",
          });
          await ack("Failed to flush cache. Please try again.");
        }
        return;
      }
      return;
    }

    // Unknown callback — just acknowledge
    await ack();
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
      case "stderr":
      case "stream-text": {
        const label = event.type === "stream-text" ? "[stdout]" : `[${event.type}]`;
        const text = event.payload?.text || "";
        this.executionRegistry.append(event.executionId, `${label} ${text}`);
        break;
      }
      case "tool-use":
        this.executionRegistry.trackToolUse(
          event.executionId,
          event.payload?.toolName || "unknown",
          event.payload?.toolInput
        );
        break;
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

    // Handle queued — react with hourglass to show the message is waiting
    if (event.type === "queued") {
      if (adapter.setMessageReaction && event.payload?.messageId) {
        this.reactionMessageIds.set(event.executionId, event.payload.messageId);
        adapter.setMessageReaction(event.chatId, event.payload.messageId, "⏳").catch(() => {
          // Non-critical — reaction may not be supported in this chat
        });
      }
      return;
    }

    // Handle start — replace queued reaction with eyes to show processing
    if (event.type === "start") {
      const msgId = event.payload?.messageId ?? this.reactionMessageIds.get(event.executionId);
      if (adapter.setMessageReaction && msgId) {
        this.reactionMessageIds.set(event.executionId, msgId);
        adapter.setMessageReaction(event.chatId, msgId, "👀").catch(() => {
          // Non-critical
        });
      }
    }

    // Handle permission requests — send inline keyboard
    if (event.type === "permission-request") {
      await this.forwardPermissionRequest(adapter, event, topicId);
      return;
    }

    // Handle tool-use — show activity and restart typing indicator
    if (event.type === "tool-use") {
      await this.forwardToolActivity(adapter, event, topicId);
      // Restart typing indicator so user sees activity during tool execution
      this.startTypingIndicator(adapter, event.chatId, event.executionId, topicId);
      return;
    }

    // Handle streaming text — accumulate and edit message in-place
    if (event.type === "stream-text") {
      // Stop typing indicator once we start streaming actual text
      this.stopTypingIndicator(event.channelId, event.chatId, event.executionId);
      // Finalize tool activity message into a compact summary
      await this.finalizeToolActivity(adapter, event.channelId, event.chatId, event.executionId);
      await this.forwardStreamText(adapter, event, topicId);
      return;
    }

    if (event.type === "complete" || event.type === "error") {
      // Always stop typing indicator on completion
      this.stopTypingIndicator(event.channelId, event.chatId, event.executionId);
      await this.finalizeToolActivity(adapter, event.channelId, event.chatId, event.executionId);
      await this.flushAndDeleteThrottler(event.channelId, event.chatId);

      // Clear reaction on the source message
      const reactionMsgId = this.reactionMessageIds.get(event.executionId);
      this.reactionMessageIds.delete(event.executionId);
      if (reactionMsgId && adapter.setMessageReaction) {
        adapter.setMessageReaction(event.chatId, reactionMsgId, null).catch(() => {
          // Non-critical
        });
      }

      // Flush stream draft and check if we already streamed the response
      const flushedContent = await this.flushStreamDraft(adapter, event.channelId, event.chatId, event.executionId);

      // Close forum topic on completion
      if (topicId && adapter.closeForumTopic) {
        adapter.closeForumTopic(event.chatId, topicId).catch(() => {
          // Non-critical
        });
        this.topicMap.delete(`${event.channelId}:${event.chatId}:${event.executionId}`);
      }

      // Skip sending duplicate response if we already streamed it in-place
      if (flushedContent && event.type === "complete") {
        // Still send execution summary even for streamed responses
        await this.sendExecutionSummary(adapter, event);
        return;
      }
    }

    const text = formatEvent(event);
    if (text) {
      const chunks = splitMessage(text);
      for (const chunk of chunks) {
        await adapter.sendMessage(event.chatId, markdownToTelegramHtml(chunk));
      }
    }

    // Send execution summary after the response
    if (event.type === "complete" || event.type === "error") {
      await this.sendExecutionSummary(adapter, event);
    }
  }

  /** Send a compact execution summary (duration, tool count) after completion. */
  private async sendExecutionSummary(adapter: IMAdapter, event: ExecutionEvent): Promise<void> {
    const record = this.executionRegistry.get(event.executionId);
    if (!record) return;

    const durationMs = (record.finishedAt ?? event.timestamp) - record.startedAt;
    const durationStr = formatDuration(durationMs);
    const toolCount = record.toolUses.length;

    // Only show summary if there was meaningful work (tools used or took > 5s)
    if (toolCount === 0 && durationMs < 5_000) return;

    const icon = record.status === "complete" ? "✅" : "❌";
    const parts: string[] = [`${icon} <i>${durationStr}`];
    if (toolCount > 0) {
      parts[0] += ` · ${toolCount} tool${toolCount === 1 ? "" : "s"} used`;
    }
    parts[0] += "</i>";

    await adapter.sendMessage(event.chatId, parts.join(""));
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

  /** Delay before tool activity becomes visible. Short turns never send a status message. */
  private static readonly TOOL_ACTIVITY_PROMOTION_MS = 1_500;

  private async forwardToolActivity(adapter: IMAdapter, event: ExecutionEvent, topicId?: number): Promise<void> {
    const toolName = event.payload?.toolName || "unknown";
    const toolInput = event.payload?.toolInput;
    const activityKey = `${event.channelId}:${event.chatId}:${event.executionId}`;

    let activity = this.toolActivityMessages.get(activityKey);
    if (!activity) {
      activity = { tools: [], promoted: false };
      this.toolActivityMessages.set(activityKey, activity);
    }

    activity.tools.push({ name: toolName, input: toolInput });

    if (activity.promoted) {
      // Already visible — edit in-place immediately
      await this.sendOrEditToolActivity(adapter, event.chatId, activity, topicId);
    } else if (!activity.promotionTimer) {
      // First tool event — start the promotion timer
      activity.promotionTimer = setTimeout(() => {
        const current = this.toolActivityMessages.get(activityKey);
        if (!current) return; // cleared before timer fired
        current.promoted = true;
        current.promotionTimer = undefined;
        void this.sendOrEditToolActivity(adapter, event.chatId, current, topicId);
      }, ChannelHub.TOOL_ACTIVITY_PROMOTION_MS);
    }
    // Otherwise: timer already running, tools are being accumulated — nothing to do yet
  }

  /** Maximum number of recent tool steps to show in the activity timeline. */
  private static readonly TOOL_ACTIVITY_MAX_VISIBLE = 5;

  private async sendOrEditToolActivity(adapter: IMAdapter, chatId: string, activity: { tools: Array<{ name: string; input?: Record<string, unknown> }>; messageId?: number; promoted: boolean }, topicId?: number): Promise<void> {
    const total = activity.tools.length;
    const maxVisible = ChannelHub.TOOL_ACTIVITY_MAX_VISIBLE;
    // Show the last N tools as a timeline
    const visible = activity.tools.slice(-maxVisible);
    const lines: string[] = [];

    for (let i = 0; i < visible.length; i++) {
      const tool = visible[i];
      const desc = formatToolDescription(tool.name, tool.input);
      const isLast = i === visible.length - 1;
      // Current (last) tool gets a spinner indicator, previous ones get a checkmark
      lines.push(isLast ? `▸ ${desc}` : `✓ ${desc}`);
    }

    const header = total > maxVisible
      ? `⚙️ <b>Working</b> <i>(${total} steps)</i>`
      : total > 1
        ? `⚙️ <b>Working</b> <i>(${total} steps)</i>`
        : `⚙️ <b>Working</b>`;

    const statusMsg = `${header}\n${lines.join("\n")}`;

    if (activity.messageId && adapter.editMessage) {
      await adapter.editMessage(chatId, activity.messageId, statusMsg).catch(() => {
        // Message may have been deleted — non-critical
      });
    } else if (adapter.sendMessageWithMarkup) {
      const messageId = await adapter.sendMessageWithMarkup(chatId, statusMsg, undefined, { threadId: topicId });
      activity.messageId = messageId;
    } else {
      await adapter.sendMessage(chatId, statusMsg);
    }
  }

  /**
   * Finalize and clean up tool activity for an execution.
   * If the activity was promoted (visible), edit it into a collapsed summary.
   * If it was never promoted, just discard it silently.
   */
  private async finalizeToolActivity(adapter: IMAdapter, channelId: string, chatId: string, executionId: string): Promise<void> {
    const key = `${channelId}:${chatId}:${executionId}`;
    const activity = this.toolActivityMessages.get(key);
    if (!activity) return;

    if (activity.promotionTimer) {
      clearTimeout(activity.promotionTimer);
    }

    // If the message was sent to Telegram, edit it into a compact summary
    if (activity.promoted && activity.messageId && adapter.editMessage && activity.tools.length > 0) {
      const toolNames = activity.tools.map((t) => t.name);
      // Deduplicate consecutive tool names for a cleaner summary
      const deduped: Array<{ name: string; count: number }> = [];
      for (const name of toolNames) {
        const last = deduped[deduped.length - 1];
        if (last && last.name === name) {
          last.count++;
        } else {
          deduped.push({ name, count: 1 });
        }
      }
      const parts = deduped.map((d) => d.count > 1 ? `${d.name} x${d.count}` : d.name);
      const summary = `📋 <i>${activity.tools.length} steps: ${escapeHtml(parts.join(" → "))}</i>`;
      await adapter.editMessage(chatId, activity.messageId, summary).catch(() => {});
    } else if (activity.promoted && activity.messageId && adapter.deleteMessage) {
      // If we can't edit (no tools recorded), just delete
      await adapter.deleteMessage(chatId, activity.messageId).catch(() => {});
    }

    this.toolActivityMessages.delete(key);
  }

  /** Cancel tool activity without finalizing (used only during stop/cleanup). */
  private clearToolActivity(channelId: string, chatId: string, executionId: string): void {
    const key = `${channelId}:${chatId}:${executionId}`;
    const activity = this.toolActivityMessages.get(key);
    if (activity?.promotionTimer) {
      clearTimeout(activity.promotionTimer);
    }
    this.toolActivityMessages.delete(key);
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

    // If accumulated text exceeds the limit, finalize current message and start a new one
    if (draft.text.length > TELEGRAM_MSG_LIMIT && draft.messageId && adapter.editMessage) {
      // Find a clean split point in the current draft
      let splitAt = draft.text.lastIndexOf("\n\n", TELEGRAM_MSG_LIMIT);
      if (splitAt <= 0) splitAt = draft.text.lastIndexOf("\n", TELEGRAM_MSG_LIMIT);
      if (splitAt <= 0) splitAt = TELEGRAM_MSG_LIMIT;

      const finalized = draft.text.slice(0, splitAt);
      const overflow = draft.text.slice(splitAt).replace(/^\n+/, "");

      // Finalize the current message with the first chunk
      await adapter.editMessage(event.chatId, draft.messageId, markdownToTelegramHtml(finalized)).catch(() => {});

      // Reset draft for the overflow — next update will create a new message
      draft.text = overflow;
      draft.messageId = undefined;
      return;
    }

    // Throttle edits: only update every ~500 chars or if we haven't sent yet
    const shouldUpdate = !draft.messageId || draft.text.length % 500 < text.length;

    if (shouldUpdate && adapter.editMessage && draft.messageId) {
      await adapter.editMessage(event.chatId, draft.messageId, markdownToTelegramHtml(draft.text)).catch(() => {
        // Edit might fail if message was deleted; non-critical
      });
    } else if (!draft.messageId && draft.text.trim()) {
      // Send initial message (only if non-empty after trimming)
      if (adapter.sendMessageWithMarkup) {
        const messageId = await adapter.sendMessageWithMarkup(
          event.chatId,
          markdownToTelegramHtml(draft.text.length <= TELEGRAM_MSG_LIMIT ? draft.text : draft.text.slice(0, TELEGRAM_MSG_LIMIT)),
          undefined,
          { threadId: topicId }
        );
        draft.messageId = messageId;
      } else {
        await adapter.sendMessage(event.chatId, draft.text.length <= TELEGRAM_MSG_LIMIT ? draft.text : draft.text.slice(0, TELEGRAM_MSG_LIMIT));
      }
    }
  }

  private async flushStreamDraft(adapter: IMAdapter, channelId: string, chatId: string, executionId: string): Promise<boolean> {
    const draftKey = `${channelId}:${chatId}:${executionId}`;
    const draft = this.streamDrafts.get(draftKey);
    if (!draft) return false;

    if (!draft.text.trim()) {
      this.streamDrafts.delete(draftKey);
      return false;
    }

    const chunks = splitMessage(draft.text);

    if (draft.messageId && adapter.editMessage) {
      // Edit existing message with first chunk
      await adapter.editMessage(chatId, draft.messageId, markdownToTelegramHtml(chunks[0])).catch(() => {});
      // Send remaining chunks as new messages
      for (let i = 1; i < chunks.length; i++) {
        await adapter.sendMessage(chatId, markdownToTelegramHtml(chunks[i]));
      }
    } else if (chunks.length > 0) {
      // No existing message — send all chunks
      for (const chunk of chunks) {
        await adapter.sendMessage(chatId, markdownToTelegramHtml(chunk));
      }
    }

    this.streamDrafts.delete(draftKey);
    return true;
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
    if (command.type === "start") {
      const lines = [
        "👋 <b>Welcome!</b> I'm your AI assistant on Telegram.",
        "",
        "Just send me a message and I'll respond. Use /help to see available commands.",
      ];
      await adapter.sendMessage(message.chatId, lines.join("\n"));
      return;
    }

    if (command.type === "help") {
      const lines = [
        "<b>Available commands:</b>",
        "",
        "/memory — View and manage stored memories",
        "/memory search &lt;query&gt; — Search memories",
        "/memory edit &lt;id&gt; &lt;text&gt; — Update a memory",
        "/memory delete &lt;id&gt; — Remove a memory",
        "/memory export — Export memories as JSON",
        "/memory clear — Clear all memories",
        "/list — List recent executions",
        "/status &lt;id&gt; — Check execution status",
        "/logs &lt;id&gt; — View execution logs",
        "/help — Show this message",
      ];
      await adapter.sendMessage(message.chatId, lines.join("\n"));
      return;
    }

    // Memory commands
    if (command.type === "memory") {
      if (!this.memoryProvider) {
        await adapter.sendMessage(message.chatId, "Memory is not configured. Set MEMORY_CHAT_ID for Telegram-backed memory, or set MEMORY_PROVIDER=mem0 and MEM0_API_KEY for Mem0.");
        return;
      }
      if (adapter.sendMessageWithMarkup) {
        const { text, markup } = buildMemoryListMarkup(this.memoryProvider.all());
        await adapter.sendMessageWithMarkup(message.chatId, text, markup);
      } else {
        const html = formatMemoryList(this.memoryProvider.all());
        await adapter.sendMessage(message.chatId, html);
      }
      return;
    }

    if (command.type === "memory-search") {
      if (!this.memoryProvider) {
        await adapter.sendMessage(message.chatId, "Memory is not configured.");
        return;
      }
      const results = this.memoryProvider.search(command.query);
      const html = results.length > 0
        ? formatMemoryList(results)
        : `No memories matching "${escapeHtml(command.query)}".`;
      await adapter.sendMessage(message.chatId, html);
      return;
    }

    if (command.type === "memory-edit") {
      if (!this.memoryProvider) {
        await adapter.sendMessage(message.chatId, "Memory is not configured.");
        return;
      }
      if (await this.memoryProvider.update(command.id, command.text)) {
        await adapter.sendMessage(message.chatId, `Updated <code>${command.id}</code>.`);
      } else {
        await adapter.sendMessage(message.chatId, `Unknown memory ID: ${command.id}`);
      }
      return;
    }

    if (command.type === "memory-delete") {
      if (!this.memoryProvider) {
        await adapter.sendMessage(message.chatId, "Memory is not configured.");
        return;
      }
      if (await this.memoryProvider.remove(command.id)) {
        await adapter.sendMessage(message.chatId, `Deleted <code>${command.id}</code>.`);
      } else {
        await adapter.sendMessage(message.chatId, `Unknown memory ID: ${command.id}`);
      }
      return;
    }

    if (command.type === "memory-clear") {
      if (!this.memoryProvider) {
        await adapter.sendMessage(message.chatId, "Memory is not configured.");
        return;
      }
      const count = this.memoryProvider.all().length;
      if (count === 0) {
        await adapter.sendMessage(message.chatId, "No memories to clear.");
        return;
      }
      if (adapter.sendMessageWithMarkup) {
        const { text, markup } = buildClearConfirmMarkup(count);
        await adapter.sendMessageWithMarkup(message.chatId, text, markup);
      } else {
        // No inline keyboard support — clear directly
        await this.memoryProvider.clear();
        await adapter.sendMessage(message.chatId, `Cleared all ${count} facts.`);
      }
      return;
    }

    if (command.type === "memory-channel") {
      if (!this.memoryChannelInfo) {
        await adapter.sendMessage(message.chatId, "No memory channel info available.");
        return;
      }
      if (adapter.sendMessageWithMarkup) {
        const { text, markup } = buildChannelInfoMarkup(
          this.memoryChannelInfo.resolvedChatId,
          this.memoryChannelInfo.rawChatId,
          this.memoryChannelInfo.cacheSource
        );
        await adapter.sendMessageWithMarkup(message.chatId, text, markup);
      } else {
        await adapter.sendMessage(
          message.chatId,
          `Memory channel: ${this.memoryChannelInfo.resolvedChatId}` +
          (this.memoryChannelInfo.rawChatId ? ` (configured as ${this.memoryChannelInfo.rawChatId})` : "")
        );
      }
      return;
    }

    if (command.type === "memory-export") {
      if (!this.memoryProvider) {
        await adapter.sendMessage(message.chatId, "Memory is not configured.");
        return;
      }
      if (adapter.sendDocument) {
        const json = JSON.stringify(this.memoryProvider.all(), null, 2);
        await adapter.sendDocument(message.chatId, Buffer.from(json, "utf-8"), {
          fileName: "memory.json",
          caption: `${this.memoryProvider.all().length} facts exported.`,
        });
      } else {
        await adapter.sendMessage(message.chatId, JSON.stringify(this.memoryProvider.all(), null, 2));
      }
      return;
    }

    if (command.type === "list") {
      const records = this.executionRegistry.list(message.channelId, message.chatId).slice(0, 10);
      if (records.length === 0) {
        await adapter.sendMessage(message.chatId, "Recent executions (this chat):\n• (none)");
        return;
      }

      const lines = records.map((record) => {
        const icon = record.status === "complete" ? "✅" : record.status === "error" ? "❌" : "⏳";
        const endTime = record.finishedAt ?? Date.now();
        const durationStr = formatDuration(endTime - record.startedAt);
        const toolCount = record.toolUses.length;
        const shortId = record.executionId.slice(0, 8);
        const toolInfo = toolCount > 0 ? ` · ${toolCount} tools` : "";
        return `• <code>${shortId}</code> ${icon} ${durationStr}${toolInfo}`;
      });

      await adapter.sendMessage(message.chatId, `<b>Recent executions:</b>\n${lines.join("\n")}`);
      return;
    }

    const record = this.executionRegistry.get(command.executionId);
    if (!record || record.channelId !== message.channelId || record.chatId !== message.chatId) {
      await adapter.sendMessage(message.chatId, `Unknown execution ID: ${command.executionId}`);
      return;
    }

    if (command.type === "status") {
      const endTime = record.finishedAt ?? Date.now();
      const durationMs = endTime - record.startedAt;
      const durationStr = formatDuration(durationMs);
      const toolCount = record.toolUses.length;
      const shortId = record.executionId.slice(0, 8);

      const statusIcon = record.status === "running" ? "⏳" : record.status === "complete" ? "✅" : "❌";
      const statusLabel = record.status === "running" ? "Running" : record.status === "complete" ? "Complete" : "Error";
      const firstLine = `${statusIcon} <b>${statusLabel}</b> (${durationStr}) · <code>${shortId}</code>`;

      const lines: string[] = [firstLine];

      // Tool summary
      if (toolCount > 0) {
        lines.push(`🔧 ${toolCount} tool${toolCount === 1 ? "" : "s"} used`);
      }

      if (record.status === "running") {
        // Show last few tool calls for running executions
        if (toolCount > 0) {
          const recentTools = record.toolUses.slice(-3);
          for (const tool of recentTools) {
            const desc = formatToolDescription(tool.name, tool.input);
            lines.push(`  ▸ ${desc}`);
          }
        }
        const lastLine = record.outputLines[record.outputLines.length - 1];
        if (lastLine) {
          lines.push(`\nLast output: ${escapeHtml(truncate(lastLine, 200))}`);
        }
        await adapter.sendMessage(message.chatId, lines.join("\n"));
        return;
      }

      if (record.status === "complete") {
        lines.push(`Finished: ${new Date(record.finishedAt || Date.now()).toISOString()}`);
        await adapter.sendMessage(message.chatId, lines.join("\n"));
        return;
      }

      lines.push(`Reason: ${escapeHtml(record.errorReason || "unknown")}`);
      await adapter.sendMessage(message.chatId, lines.join("\n"));
      return;
    }

    const lines = record.outputLines;
    await adapter.sendMessage(
      message.chatId,
      lines.length > 0 ? lines.join("\n") : "No output captured for this execution yet."
    );
  }
}
