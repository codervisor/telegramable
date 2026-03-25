import { Bot, Context } from "grammy";
import { IMAdapter, IMMessage } from "./types";
import { Logger } from "../logging";

export class TelegramAdapter implements IMAdapter {
  private bot?: Bot;

  constructor(
    public readonly id: string,
    private readonly token: string,
    private readonly pollingInterval: number,
    private readonly logger: Logger
  ) { }

  async start(onMessage: (message: IMMessage) => void): Promise<void> {
    this.bot = new Bot(this.token);

    this.bot.on("message:text", (ctx: Context) => {
      const message = ctx.message;
      if (!message?.text || !message.chat?.id) {
        return;
      }

      const payload: IMMessage = {
        channelId: this.id,
        chatId: String(message.chat.id),
        userId: message.from ? String(message.from.id) : undefined,
        text: message.text,
        messageId: message.message_id,
        threadId: message.message_thread_id,
        raw: message
      };

      this.logger.debug("Telegram message received.", { channelId: this.id, chatId: payload.chatId });
      onMessage(payload);
    });

    this.bot.on("message:document", (ctx: Context) => {
      const message = ctx.message;
      if (!message?.document || !message.chat?.id) {
        return;
      }

      const payload: IMMessage = {
        channelId: this.id,
        chatId: String(message.chat.id),
        userId: message.from ? String(message.from.id) : undefined,
        text: message.caption || "",
        messageId: message.message_id,
        threadId: message.message_thread_id,
        fileId: message.document.file_id,
        fileName: message.document.file_name,
        mimeType: message.document.mime_type,
        raw: message
      };

      this.logger.debug("Telegram document received.", { channelId: this.id, chatId: payload.chatId });
      onMessage(payload);
    });

    this.bot.on("callback_query:data", (ctx: Context) => {
      const query = ctx.callbackQuery;
      if (!query?.data || !query.message?.chat?.id) {
        return;
      }

      const payload: IMMessage = {
        channelId: this.id,
        chatId: String(query.message.chat.id),
        userId: query.from ? String(query.from.id) : undefined,
        text: "",
        messageId: query.message.message_id,
        callbackData: query.data,
        callbackQueryId: query.id,
        raw: query
      };

      this.logger.debug("Telegram callback query received.", { channelId: this.id, chatId: payload.chatId });
      onMessage(payload);
    });

    this.bot.catch((err) => {
      this.logger.warn("Telegram bot error.", { channelId: this.id, message: err.message });
    });

    // Start long-polling (non-blocking)
    this.bot.start({
      drop_pending_updates: true,
      onStart: () => {
        this.logger.info("Telegram adapter started.", { channelId: this.id });
      }
    });
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.bot) {
      throw new Error("Telegram bot not started.");
    }
    await this.bot.api.sendMessage(Number(chatId), text, { parse_mode: "HTML" });
  }

  async sendMessageWithMarkup(chatId: string, text: string, markup: unknown, options?: { threadId?: number }): Promise<number> {
    if (!this.bot) {
      throw new Error("Telegram bot not started.");
    }
    const result = await this.bot.api.sendMessage(Number(chatId), text, {
      parse_mode: "HTML",
      reply_markup: markup as Parameters<Bot["api"]["sendMessage"]>[2] extends { reply_markup?: infer R } ? R : never,
      message_thread_id: options?.threadId
    });
    return result.message_id;
  }

  async editMessage(chatId: string, messageId: number, text: string): Promise<void> {
    if (!this.bot) {
      throw new Error("Telegram bot not started.");
    }
    await this.bot.api.editMessageText(Number(chatId), messageId, text, { parse_mode: "HTML" });
  }

  async deleteMessage(chatId: string, messageId: number): Promise<void> {
    if (!this.bot) {
      throw new Error("Telegram bot not started.");
    }
    await this.bot.api.deleteMessage(Number(chatId), messageId);
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    if (!this.bot) {
      throw new Error("Telegram bot not started.");
    }
    await this.bot.api.answerCallbackQuery(callbackQueryId, { text });
  }

  async sendDocument(chatId: string, file: Buffer | string, options?: { caption?: string; fileName?: string; threadId?: number }): Promise<void> {
    if (!this.bot) {
      throw new Error("Telegram bot not started.");
    }

    const inputFile = typeof file === "string"
      ? new (await import("grammy")).InputFile(file, options?.fileName)
      : new (await import("grammy")).InputFile(file, options?.fileName || "file");

    await this.bot.api.sendDocument(Number(chatId), inputFile, {
      caption: options?.caption,
      message_thread_id: options?.threadId
    });
  }

  async getFileUrl(fileId: string): Promise<string> {
    if (!this.bot) {
      throw new Error("Telegram bot not started.");
    }
    const file = await this.bot.api.getFile(fileId);
    if (!file.file_path) {
      throw new Error("File path not available.");
    }
    return `https://api.telegram.org/file/bot${this.token}/${file.file_path}`;
  }

  async createForumTopic(chatId: string, name: string): Promise<number> {
    if (!this.bot) {
      throw new Error("Telegram bot not started.");
    }
    const topic = await this.bot.api.createForumTopic(Number(chatId), name);
    return topic.message_thread_id;
  }

  async closeForumTopic(chatId: string, topicId: number): Promise<void> {
    if (!this.bot) {
      throw new Error("Telegram bot not started.");
    }
    await this.bot.api.closeForumTopic(Number(chatId), topicId);
  }

  async stop(): Promise<void> {
    if (!this.bot) {
      return;
    }
    await this.bot.stop();
    this.logger.info("Telegram adapter stopped.", { channelId: this.id });
  }
}
