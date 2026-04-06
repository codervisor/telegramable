import { IMAdapter, IMMessage } from "../src/gateway/types";

export class MockAdapter implements IMAdapter {
  public readonly id: string;
  private handler?: (message: IMMessage) => void;
  public sentMessages: Array<{ chatId: string; text: string }> = [];
  public sentMarkupMessages: Array<{ chatId: string; text: string; markup: unknown; messageId: number; options?: { threadId?: number } }> = [];
  public editedMessages: Array<{ chatId: string; messageId: number; text: string }> = [];
  public editedMarkupMessages: Array<{ chatId: string; messageId: number; text: string; markup: unknown }> = [];
  public answeredCallbacks: Array<{ callbackQueryId: string; text?: string }> = [];
  public sentDocuments: Array<{ chatId: string; file: Buffer | string; options?: { caption?: string; fileName?: string } }> = [];
  public createdTopics: Array<{ chatId: string; name: string; topicId: number }> = [];
  public closedTopics: Array<{ chatId: string; topicId: number }> = [];
  private nextMessageId = 1;
  private nextTopicId = 100;
  public forumTopicsEnabled = false;

  constructor(id: string = "mock") {
    this.id = id;
  }

  async start(onMessage: (message: IMMessage) => void): Promise<void> {
    this.handler = onMessage;
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    this.sentMessages.push({ chatId, text });
  }

  async sendMessageWithMarkup(chatId: string, text: string, markup: unknown, options?: { threadId?: number }): Promise<number> {
    const messageId = this.nextMessageId++;
    this.sentMarkupMessages.push({ chatId, text, markup, messageId, options });
    return messageId;
  }

  async editMessage(chatId: string, messageId: number, text: string): Promise<void> {
    this.editedMessages.push({ chatId, messageId, text });
  }

  async editMessageWithMarkup(chatId: string, messageId: number, text: string, markup: unknown): Promise<void> {
    this.editedMarkupMessages.push({ chatId, messageId, text, markup });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    this.answeredCallbacks.push({ callbackQueryId, text });
  }

  async sendDocument(chatId: string, file: Buffer | string, options?: { caption?: string; fileName?: string }): Promise<void> {
    this.sentDocuments.push({ chatId, file, options });
  }

  async createForumTopic(chatId: string, name: string): Promise<number> {
    if (!this.forumTopicsEnabled) throw new Error("Forum topics not enabled");
    const topicId = this.nextTopicId++;
    this.createdTopics.push({ chatId, name, topicId });
    return topicId;
  }

  async closeForumTopic(chatId: string, topicId: number): Promise<void> {
    this.closedTopics.push({ chatId, topicId });
  }

  async stop(): Promise<void> {
    this.handler = undefined;
  }

  async simulateIncoming(message: Partial<IMMessage> & { chatId: string; text: string }): Promise<void> {
    if (!this.handler) {
      throw new Error("Mock adapter not started.");
    }
    this.handler({
      channelId: this.id,
      ...message
    });
  }

  async simulateCallback(chatId: string, callbackData: string, messageId: number = 1): Promise<void> {
    if (!this.handler) {
      throw new Error("Mock adapter not started.");
    }
    this.handler({
      channelId: this.id,
      chatId,
      text: "",
      callbackData,
      callbackQueryId: `cbq-${Date.now()}`,
      messageId,
    });
  }
}
