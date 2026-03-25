import { IMAdapter, IMMessage } from "../src/gateway/types";

export class MockAdapter implements IMAdapter {
  public readonly id: string;
  private handler?: (message: IMMessage) => void;
  public sentMessages: Array<{ chatId: string; text: string }> = [];

  constructor(id: string = "mock") {
    this.id = id;
  }

  async start(onMessage: (message: IMMessage) => void): Promise<void> {
    this.handler = onMessage;
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    this.sentMessages.push({ chatId, text });
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
}
