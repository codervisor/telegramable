import assert from "assert";
import test from "node:test";
import { EventBus } from "../src/events/eventBus";
import { ExecutionEvent } from "../src/events/types";
import { createLogger } from "../src/logging";
import { ChannelHub } from "../src/hub/hub";
import { Router } from "../src/hub/router";
import { Runtime } from "../src/runtime/types";
import { MockAdapter } from "./mockAdapter";
import { IMAdapter, IMMessage } from "../src/gateway/types";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Extended MockAdapter with rich feature support for testing. */
class RichMockAdapter implements IMAdapter {
  public readonly id: string;
  private handler?: (message: IMMessage) => void;
  public sentMessages: Array<{ chatId: string; text: string }> = [];
  public sentMarkups: Array<{ chatId: string; text: string; markup: unknown; messageId: number }> = [];
  public editedMessages: Array<{ chatId: string; messageId: number; text: string }> = [];
  public answeredCallbacks: Array<{ callbackQueryId: string; text?: string }> = [];
  private nextMessageId = 100;

  constructor(id: string = "mock") {
    this.id = id;
  }

  async start(onMessage: (message: IMMessage) => void): Promise<void> {
    this.handler = onMessage;
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    this.sentMessages.push({ chatId, text });
  }

  async sendMessageWithMarkup(chatId: string, text: string, markup: unknown, _options?: { threadId?: number }): Promise<number> {
    const messageId = this.nextMessageId++;
    this.sentMarkups.push({ chatId, text, markup, messageId });
    return messageId;
  }

  async editMessage(chatId: string, messageId: number, text: string): Promise<void> {
    this.editedMessages.push({ chatId, messageId, text });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    this.answeredCallbacks.push({ callbackQueryId, text });
  }

  async stop(): Promise<void> {
    this.handler = undefined;
  }

  async simulateIncoming(message: IMMessage): Promise<void> {
    if (!this.handler) {
      throw new Error("Mock adapter not started.");
    }
    this.handler({
      ...message,
      channelId: this.id
    });
  }
}

test("ChannelHub handles permission-request event by sending inline keyboard", async () => {
  const eventBus = new EventBus();
  const logger = createLogger("error");
  const adapter = new RichMockAdapter("telegram");

  const runtime: Runtime = {
    async execute(message, executionId, bus): Promise<void> {
      bus.emit({
        executionId,
        channelId: message.channelId,
        chatId: message.chatId,
        type: "start",
        timestamp: Date.now(),
        payload: { agentName: "claude" }
      });

      // Simulate permission request from SDK session
      bus.emit({
        executionId,
        channelId: message.channelId,
        chatId: message.chatId,
        type: "permission-request",
        timestamp: Date.now(),
        payload: {
          permissionRequestId: "perm-req-1",
          toolName: "Bash",
          toolInput: { command: "npm install" }
        }
      });
    }
  };

  const router: Router = {
    select(message) {
      return { runtime, message };
    }
  };

  const hub = new ChannelHub([adapter], router, eventBus, logger);
  await hub.start();

  await adapter.simulateIncoming({
    channelId: "telegram",
    chatId: "chat-1",
    text: "install deps"
  });

  await sleep(100);

  // Should have sent an inline keyboard for the permission request
  const permMsg = adapter.sentMarkups.find((m) => m.text.includes("Permission Request"));
  assert.ok(permMsg, "Permission request message with inline keyboard should be sent");
  assert.ok(permMsg?.text.includes("Bash"), "Should mention the tool name");

  const markup = permMsg?.markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
  assert.ok(markup?.inline_keyboard, "Should have inline_keyboard");
  assert.equal(markup.inline_keyboard[0].length, 2, "Should have Approve and Deny buttons");
  assert.ok(markup.inline_keyboard[0][0].callback_data.includes("allow"));
  assert.ok(markup.inline_keyboard[0][1].callback_data.includes("deny"));

  await hub.stop();
});

test("ChannelHub handles callback query for permission response", async () => {
  const eventBus = new EventBus();
  const logger = createLogger("error");
  const adapter = new RichMockAdapter("telegram");

  let permissionDecision: string | undefined;

  const runtime: Runtime = {
    async execute(message, executionId, bus): Promise<void> {
      bus.emit({
        executionId,
        channelId: message.channelId,
        chatId: message.chatId,
        type: "start",
        timestamp: Date.now(),
        payload: { agentName: "claude" }
      });

      // Simulate permission request
      bus.emit({
        executionId,
        channelId: message.channelId,
        chatId: message.chatId,
        type: "permission-request",
        timestamp: Date.now(),
        payload: {
          permissionRequestId: "perm-req-2",
          toolName: "Write",
          toolInput: { file_path: "/tmp/test.txt" }
        }
      });
    }
  };

  const router: Router = {
    select(message) {
      return { runtime, message };
    }
  };

  // Listen for permission-response events
  eventBus.on((event) => {
    if (event.type === "permission-response") {
      permissionDecision = event.payload?.decision;
    }
  });

  const hub = new ChannelHub([adapter], router, eventBus, logger);
  await hub.start();

  await adapter.simulateIncoming({
    channelId: "telegram",
    chatId: "chat-1",
    text: "write file"
  });

  await sleep(100);

  // Get the permission request message to find the callback data
  const permMsg = adapter.sentMarkups.find((m) => m.text.includes("Permission Request"));
  assert.ok(permMsg);

  const markup = permMsg?.markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
  const approveCallbackData = markup.inline_keyboard[0][0].callback_data;

  // Simulate user tapping "Approve" button via callback query
  await adapter.simulateIncoming({
    channelId: "telegram",
    chatId: "chat-1",
    text: "",
    callbackData: approveCallbackData,
    callbackQueryId: "cq-1",
    messageId: permMsg.messageId
  });

  await sleep(100);

  // Permission response should have been emitted
  assert.equal(permissionDecision, "allow");

  // Callback query should have been answered
  assert.ok(adapter.answeredCallbacks.some((cb) => cb.callbackQueryId === "cq-1"));

  // Original message should have been edited
  assert.ok(adapter.editedMessages.some((em) => em.messageId === permMsg.messageId));

  await hub.stop();
});

test("ChannelHub handles file-only messages (no text)", async () => {
  const eventBus = new EventBus();
  const logger = createLogger("error");
  const adapter = new MockAdapter("telegram");
  let receivedFileId: string | undefined;

  const runtime: Runtime = {
    async execute(message, executionId, bus): Promise<void> {
      receivedFileId = message.fileId;
      bus.emit({
        executionId,
        channelId: message.channelId,
        chatId: message.chatId,
        type: "complete",
        timestamp: Date.now(),
        payload: { response: "done" }
      });
    }
  };

  const router: Router = {
    select(message) {
      return { runtime, message };
    }
  };

  const hub = new ChannelHub([adapter], router, eventBus, logger);
  await hub.start();

  await adapter.simulateIncoming({
    channelId: "telegram",
    chatId: "chat-1",
    text: "",
    fileId: "file-abc-123",
    fileName: "patch.diff"
  });

  await sleep(50);

  // File messages should not be dropped (even with empty text)
  // The hub should route them normally
  assert.ok(adapter.sentMessages.some((m) => m.text.includes("Execution ID:")));

  await hub.stop();
});

test("ChannelHub ignores empty messages without files", async () => {
  const eventBus = new EventBus();
  const logger = createLogger("error");
  const adapter = new MockAdapter("telegram");
  let executeCalls = 0;

  const runtime: Runtime = {
    async execute(): Promise<void> {
      executeCalls++;
    }
  };

  const router: Router = {
    select(message) {
      return { runtime, message };
    }
  };

  const hub = new ChannelHub([adapter], router, eventBus, logger);
  await hub.start();

  await adapter.simulateIncoming({
    channelId: "telegram",
    chatId: "chat-1",
    text: ""
  });

  await sleep(30);

  assert.equal(executeCalls, 0, "Empty messages without files should be ignored");

  await hub.stop();
});
