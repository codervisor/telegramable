import { Bot } from "grammy";
import { Logger } from "../logging";
import { MemorySnapshot } from "./store";

export interface MemoryConfig {
  enabled: boolean;
  chatId: string;
  topicId?: number;
}

/**
 * Reads/writes memory snapshots as pinned messages in a Telegram chat/topic.
 * The pinned message contains the full JSON snapshot. A changelog message
 * is sent (but not pinned) whenever facts change.
 */
export class MemorySync {
  private pinnedMessageId?: number;

  constructor(
    private readonly bot: Bot,
    private readonly config: MemoryConfig,
    private readonly logger: Logger
  ) {}

  /** Load the current memory snapshot from the pinned message. */
  async load(): Promise<MemorySnapshot | null> {
    try {
      const chatId = Number(this.config.chatId);

      // Try to find the pinned message by reading chat info
      // Telegram's getChat returns pinned_message for the chat (not topic-specific)
      // For forum topics, we search recent messages for our JSON format
      if (this.config.topicId) {
        return await this.loadFromTopic(chatId, this.config.topicId);
      }

      const chat = await this.bot.api.getChat(chatId);
      if (!("pinned_message" in chat) || !chat.pinned_message?.text) {
        return null;
      }

      this.pinnedMessageId = chat.pinned_message.message_id;
      return this.parseSnapshot(chat.pinned_message.text);
    } catch (error) {
      this.logger.warn("Failed to load memory from Telegram.", {
        reason: error instanceof Error ? error.message : "unknown",
      });
      return null;
    }
  }

  /** Save the snapshot by editing the pinned message, or creating + pinning a new one. */
  async save(snapshot: MemorySnapshot): Promise<void> {
    const chatId = Number(this.config.chatId);
    const json = JSON.stringify(snapshot, null, 2);

    if (json.length > 4096) {
      this.logger.warn("Memory snapshot exceeds 4096 chars, truncating oldest facts.", {
        length: json.length,
      });
      // Phase 1: truncate. Phase 2 would use reply chains.
      while (JSON.stringify(snapshot, null, 2).length > 4000 && snapshot.facts.length > 0) {
        snapshot.facts.shift();
      }
    }

    const text = JSON.stringify(snapshot, null, 2);

    try {
      if (this.pinnedMessageId) {
        await this.bot.api.editMessageText(chatId, this.pinnedMessageId, text);
      } else {
        const msg = await this.bot.api.sendMessage(chatId, text, {
          message_thread_id: this.config.topicId,
        });
        this.pinnedMessageId = msg.message_id;
        await this.bot.api.pinChatMessage(chatId, msg.message_id, {
          disable_notification: true,
        });
      }
    } catch (error) {
      this.logger.error("Failed to save memory to Telegram.", {
        reason: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  /**
   * Save the snapshot as a NEW pinned message (instead of editing the existing one).
   * Use this after refinement to create a clean version checkpoint.
   * The old pinned message is unpinned but not deleted (serves as history).
   */
  async saveAsNewPin(snapshot: MemorySnapshot): Promise<void> {
    const chatId = Number(this.config.chatId);

    // Truncate if needed (same logic as save)
    while (JSON.stringify(snapshot, null, 2).length > 4000 && snapshot.facts.length > 0) {
      snapshot.facts.shift();
    }

    const text = JSON.stringify(snapshot, null, 2);

    try {
      // Unpin old message (keep it as history)
      if (this.pinnedMessageId) {
        await this.bot.api.unpinChatMessage(chatId, this.pinnedMessageId).catch(() => {});
      }

      // Send and pin a new message
      const msg = await this.bot.api.sendMessage(chatId, text, {
        message_thread_id: this.config.topicId,
      });
      this.pinnedMessageId = msg.message_id;
      await this.bot.api.pinChatMessage(chatId, msg.message_id, {
        disable_notification: true,
      });
    } catch (error) {
      this.logger.error("Failed to save new pinned memory to Telegram.", {
        reason: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  /** Send a human-readable changelog message (not pinned). */
  async sendChangelog(changesSummary: string): Promise<void> {
    if (!changesSummary) return;
    try {
      await this.bot.api.sendMessage(Number(this.config.chatId), changesSummary, {
        message_thread_id: this.config.topicId,
        parse_mode: "HTML",
      });
    } catch (error) {
      this.logger.warn("Failed to send memory changelog.", {
        reason: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  private async loadFromTopic(chatId: number, topicId: number): Promise<MemorySnapshot | null> {
    // For forum topics, we can't easily get the pinned message via getChat.
    // Instead, search recent messages. The bot's own messages with JSON are our snapshots.
    // As a fallback, we rely on the pinnedMessageId being set from a previous save in this process.
    // On cold start with a topic, we need to use getChat + check pinned.
    try {
      const chat = await this.bot.api.getChat(chatId);
      if (!("pinned_message" in chat) || !chat.pinned_message?.text) {
        return null;
      }

      this.pinnedMessageId = chat.pinned_message.message_id;
      return this.parseSnapshot(chat.pinned_message.text);
    } catch {
      return null;
    }
  }

  private parseSnapshot(text: string): MemorySnapshot | null {
    try {
      const data = JSON.parse(text);
      if (data.v && Array.isArray(data.facts)) {
        return data as MemorySnapshot;
      }
      return null;
    } catch {
      this.logger.warn("Pinned message is not valid memory JSON, starting fresh.");
      return null;
    }
  }
}
