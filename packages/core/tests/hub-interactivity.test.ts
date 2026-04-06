import assert from "assert";
import test from "node:test";
import { EventBus } from "../src/events/eventBus";
import { createLogger } from "../src/logging";
import { ChannelHub, parseBuiltinCommand } from "../src/hub/hub";
import { Router } from "../src/hub/router";
import { Runtime } from "../src/runtime/types";
import { MockAdapter } from "./mockAdapter";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("parseBuiltinCommand parses status/logs/list and ignores unknown", () => {
  assert.deepEqual(parseBuiltinCommand("/status abc"), { type: "status", executionId: "abc" });
  assert.deepEqual(parseBuiltinCommand("/logs ABC-1"), { type: "logs", executionId: "ABC-1" });
  assert.deepEqual(parseBuiltinCommand(" /LiSt  "), { type: "list" });
  assert.deepEqual(parseBuiltinCommand("/start"), { type: "start" });
  assert.deepEqual(parseBuiltinCommand("/help"), { type: "help" });
  assert.equal(parseBuiltinCommand("deploy now"), null);
});

test("ChannelHub supports /status /logs /list without routing to runtime", async () => {
  const eventBus = new EventBus();
  const logger = createLogger("error");
  const adapter = new MockAdapter("telegram");

  let executeCalls = 0;
  let capturedExecutionId = "";
  const runtime: Runtime = {
    async execute(message, executionId, bus): Promise<void> {
      executeCalls += 1;
      capturedExecutionId = executionId;

      bus.emit({
        executionId,
        channelId: message.channelId,
        chatId: message.chatId,
        type: "start",
        timestamp: Date.now(),
        payload: { agentName: "claude" }
      });

      bus.emit({
        executionId,
        channelId: message.channelId,
        chatId: message.chatId,
        type: "stdout",
        timestamp: Date.now(),
        payload: { text: "Analyzing project structure..." }
      });

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
    text: "run task"
  });

  await sleep(30);

  assert.equal(executeCalls, 1);
  assert.ok(capturedExecutionId.length > 0, "runtime should have received an executionId");

  await adapter.simulateIncoming({
    channelId: "telegram",
    chatId: "chat-1",
    text: `/status ${capturedExecutionId}`
  });
  await adapter.simulateIncoming({
    channelId: "telegram",
    chatId: "chat-1",
    text: `/logs ${capturedExecutionId}`
  });
  await adapter.simulateIncoming({
    channelId: "telegram",
    chatId: "chat-1",
    text: "/list"
  });
  await adapter.simulateIncoming({
    channelId: "telegram",
    chatId: "chat-1",
    text: "/status unknown-id"
  });

  await sleep(30);

  assert.ok(adapter.sentMessages.some((message) => message.text.includes("✅ Complete")));
  assert.ok(adapter.sentMessages.some((message) => message.text.includes("[stdout] Analyzing project structure...")));
  assert.ok(adapter.sentMessages.some((message) => message.text.includes("Recent executions (this chat):")));
  assert.ok(adapter.sentMessages.some((message) => message.text.includes("Unknown execution ID: unknown-id")));

  await hub.stop();
});

test("ChannelHub prepends replyToText context to routed message", async () => {
  const eventBus = new EventBus();
  const logger = createLogger("error");
  const adapter = new MockAdapter("telegram");

  let capturedText = "";
  const runtime: Runtime = {
    async execute(message, executionId, bus): Promise<void> {
      capturedText = message.text;
      bus.emit({
        executionId,
        channelId: message.channelId,
        chatId: message.chatId,
        type: "complete",
        timestamp: Date.now(),
        payload: { response: "ok" }
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

  // Message WITH replyToText should prepend quoted context
  await adapter.simulateIncoming({
    channelId: "telegram",
    chatId: "chat-1",
    text: "what about this?",
    replyToText: "The previous bot response"
  });

  await sleep(30);
  assert.ok(capturedText.includes("[Quoted message]"), "should include quoted block header");
  assert.ok(capturedText.includes("The previous bot response"), "should include reply text");
  assert.ok(capturedText.includes("what about this?"), "should include original message");

  // Message WITHOUT replyToText should be unchanged
  capturedText = "";
  await adapter.simulateIncoming({
    channelId: "telegram",
    chatId: "chat-1",
    text: "plain message"
  });

  await sleep(30);
  assert.equal(capturedText, "plain message", "should pass through unchanged without replyToText");

  await hub.stop();
});
