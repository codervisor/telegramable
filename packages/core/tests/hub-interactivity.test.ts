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

  assert.ok(adapter.sentMessages.some((message) => message.text.includes("✅") && message.text.includes("Complete")));
  assert.ok(adapter.sentMessages.some((message) => message.text.includes("[stdout] Analyzing project structure...")));
  assert.ok(adapter.sentMessages.some((message) => message.text.includes("Recent executions")));
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

test("ChannelHub sends execution summary with tool count on completion", async () => {
  process.env.SHOW_EXECUTION_SUMMARY = "true";
  const eventBus = new EventBus();
  const logger = createLogger("error");
  const adapter = new MockAdapter("telegram");

  const runtime: Runtime = {
    async execute(message, executionId, bus): Promise<void> {
      const base = { executionId, channelId: message.channelId, chatId: message.chatId };

      bus.emit({ ...base, type: "start", timestamp: 1000, payload: { agentName: "claude" } });

      // Emit tool-use events
      bus.emit({ ...base, type: "tool-use", timestamp: 1500, payload: { toolName: "Read", toolInput: { file_path: "/a.ts" } } });
      bus.emit({ ...base, type: "tool-use", timestamp: 2000, payload: { toolName: "Edit", toolInput: { file_path: "/a.ts" } } });
      bus.emit({ ...base, type: "tool-use", timestamp: 2500, payload: { toolName: "Bash", toolInput: { command: "npm test" } } });

      // Complete after 6 seconds (above the 5s threshold)
      bus.emit({ ...base, type: "complete", timestamp: 7000, payload: { response: "done" } });
    }
  };

  const router: Router = { select(message) { return { runtime, message }; } };
  const hub = new ChannelHub([adapter], router, eventBus, logger);
  await hub.start();

  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "do work" });
  await sleep(50);

  // Should have a summary message with tool count
  const allMessages = [...adapter.sentMessages, ...adapter.sentMarkupMessages];
  const summaryMsg = allMessages.find((m) => m.text.includes("tools used"));
  assert.ok(summaryMsg, "should send execution summary with tool count");
  assert.ok(summaryMsg!.text.includes("3 tools used"), "should report 3 tools");
  assert.ok(summaryMsg!.text.includes("✅"), "should use success icon for complete status");

  await hub.stop();
  delete process.env.SHOW_EXECUTION_SUMMARY;
});

test("ChannelHub suppresses execution summary for quick runs with no tools", async () => {
  const eventBus = new EventBus();
  const logger = createLogger("error");
  const adapter = new MockAdapter("telegram");

  const runtime: Runtime = {
    async execute(message, executionId, bus): Promise<void> {
      const base = { executionId, channelId: message.channelId, chatId: message.chatId };
      const now = Date.now();

      bus.emit({ ...base, type: "start", timestamp: now, payload: { agentName: "claude" } });
      // Complete quickly (under 5s) with no tools
      bus.emit({ ...base, type: "complete", timestamp: now + 1000, payload: { response: "quick reply" } });
    }
  };

  const router: Router = { select(message) { return { runtime, message }; } };
  const hub = new ChannelHub([adapter], router, eventBus, logger);
  await hub.start();

  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "hi" });
  await sleep(50);

  // Should NOT have a summary message for quick no-tool runs
  const allMessages = [...adapter.sentMessages, ...adapter.sentMarkupMessages];
  const summaryMsg = allMessages.find((m) => m.text.includes("tools used"));
  assert.equal(summaryMsg, undefined, "should not send summary for quick runs with no tools");

  await hub.stop();
});

test("ChannelHub sends error icon in execution summary on failure", async () => {
  process.env.SHOW_EXECUTION_SUMMARY = "true";
  const eventBus = new EventBus();
  const logger = createLogger("error");
  const adapter = new MockAdapter("telegram");

  const runtime: Runtime = {
    async execute(message, executionId, bus): Promise<void> {
      const base = { executionId, channelId: message.channelId, chatId: message.chatId };

      bus.emit({ ...base, type: "start", timestamp: 1000, payload: { agentName: "claude" } });
      bus.emit({ ...base, type: "tool-use", timestamp: 1500, payload: { toolName: "Bash", toolInput: { command: "npm test" } } });
      bus.emit({ ...base, type: "error", timestamp: 8000, payload: { reason: "Runtime timeout." } });
    }
  };

  const router: Router = { select(message) { return { runtime, message }; } };
  const hub = new ChannelHub([adapter], router, eventBus, logger);
  await hub.start();

  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "do work" });
  await sleep(50);

  const allMessages = [...adapter.sentMessages, ...adapter.sentMarkupMessages];
  const summaryMsg = allMessages.find((m) => m.text.includes("tools used") || m.text.includes("1 tool used"));
  assert.ok(summaryMsg, "should send execution summary on error");
  assert.ok(summaryMsg!.text.includes("❌"), "should use error icon for failed execution");

  await hub.stop();
  delete process.env.SHOW_EXECUTION_SUMMARY;
});

test("ChannelHub finalizes tool activity even when promotion send is in-flight", async () => {
  const eventBus = new EventBus();
  const logger = createLogger("error");
  const adapter = new MockAdapter("telegram");

  // Make sendMessageWithMarkup resolve slowly to simulate in-flight send
  let resolveSend: (() => void) | undefined;
  const originalSendMarkup = adapter.sendMessageWithMarkup.bind(adapter);
  adapter.sendMessageWithMarkup = async (chatId: string, text: string, markup: unknown, options?: { threadId?: number }) => {
    // Only delay tool activity messages (the "Working" ones)
    if (text.includes("Working")) {
      await new Promise<void>((resolve) => { resolveSend = resolve; });
    }
    return originalSendMarkup(chatId, text, markup, options);
  };

  const runtime: Runtime = {
    async execute(message, executionId, bus): Promise<void> {
      const base = { executionId, channelId: message.channelId, chatId: message.chatId };

      bus.emit({ ...base, type: "start", timestamp: 1000, payload: { agentName: "claude" } });
      bus.emit({ ...base, type: "tool-use", timestamp: 1500, payload: { toolName: "Read", toolInput: { file_path: "/a.ts" } } });

      // Wait for the promotion timer to fire (1.5s)
      await sleep(1600);

      // Now complete while the send is still in-flight
      bus.emit({ ...base, type: "complete", timestamp: 8000, payload: { response: "done" } });
    }
  };

  const router: Router = { select(message) { return { runtime, message }; } };
  const hub = new ChannelHub([adapter], router, eventBus, logger);
  await hub.start();

  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "do work" });

  // Wait for timer to fire and start the send
  await sleep(1700);

  // The send should be blocked. Now resolve it so finalizeToolActivity can proceed.
  assert.ok(resolveSend, "sendMessageWithMarkup should have been called for the Working message");
  resolveSend!();

  // Wait for finalization to complete
  await sleep(100);

  // The activity message should have been edited into a summary (not left as "Working")
  const edited = adapter.editedMessages.find((m) => m.text.includes("📋"));
  assert.ok(edited, "should edit the Working message into a compact summary after awaiting in-flight send");

  await hub.stop();
});

test("ChannelHub finalizes streamed draft via editMessage (not sendMessageDraft) so message persists", async () => {
  const eventBus = new EventBus();
  const logger = createLogger("error");
  const adapter = new MockAdapter("telegram");

  const runtime: Runtime = {
    async execute(message, executionId, bus): Promise<void> {
      const base = { executionId, channelId: message.channelId, chatId: message.chatId };

      bus.emit({ ...base, type: "start", timestamp: 1000, payload: { agentName: "claude" } });

      // Stream text to trigger sendMessageDraft during streaming
      bus.emit({ ...base, type: "stream-text", timestamp: 2000, payload: { text: "Hello from the stream" } });
      bus.emit({ ...base, type: "stream-text", timestamp: 2500, payload: { text: " — more content here" } });

      // Complete triggers flushStreamDraft
      bus.emit({ ...base, type: "complete", timestamp: 8000, payload: { response: "Hello from the stream — more content here" } });
    }
  };

  const router: Router = { select(message) { return { runtime, message }; } };
  const hub = new ChannelHub([adapter], router, eventBus, logger);
  await hub.start();

  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "do work" });
  await sleep(50);

  // During streaming, sendMessageDraft should have been called to show the draft
  assert.ok(adapter.draftMessages.length > 0, "should use sendMessageDraft during streaming");

  // On flush, editMessage should have been called to make the draft permanent
  const finalEdit = adapter.editedMessages.find((m) =>
    m.text.includes("Hello from the stream")
  );
  assert.ok(finalEdit, "flushStreamDraft should use editMessage to make draft permanent");

  // The draft messageId from streaming should match the editMessage messageId
  const lastDraft = adapter.draftMessages[adapter.draftMessages.length - 1];
  assert.equal(finalEdit!.messageId, lastDraft.messageId, "should edit the same message that was created as a draft");

  await hub.stop();
});

test("ChannelHub sends execution summary to forum topic thread", async () => {
  process.env.SHOW_EXECUTION_SUMMARY = "true";
  const eventBus = new EventBus();
  const logger = createLogger("error");
  const adapter = new MockAdapter("telegram");
  adapter.forumTopicsEnabled = true;

  const runtime: Runtime = {
    async execute(message, executionId, bus): Promise<void> {
      const base = { executionId, channelId: message.channelId, chatId: message.chatId };

      bus.emit({ ...base, type: "start", timestamp: 1000, payload: { agentName: "claude" } });
      bus.emit({ ...base, type: "tool-use", timestamp: 1500, payload: { toolName: "Read", toolInput: { file_path: "/a.ts" } } });
      bus.emit({ ...base, type: "tool-use", timestamp: 2000, payload: { toolName: "Edit", toolInput: { file_path: "/a.ts" } } });
      bus.emit({ ...base, type: "complete", timestamp: 7000, payload: { response: "done" } });
    }
  };

  const router: Router = { select(message) { return { runtime, message }; } };
  const hub = new ChannelHub([adapter], router, eventBus, logger);
  await hub.start();

  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "do work" });
  await sleep(50);

  // Execution summary should be sent via sendMessageWithMarkup with threadId
  const summaryMsg = adapter.sentMarkupMessages.find((m) => m.text.includes("tools used"));
  assert.ok(summaryMsg, "should send execution summary via sendMessageWithMarkup");
  assert.ok(summaryMsg!.options?.threadId, "execution summary should include threadId for forum topic");

  // Summary should NOT appear in plain sentMessages (no topic routing)
  const plainSummary = adapter.sentMessages.find((m) => m.text.includes("tools used"));
  assert.equal(plainSummary, undefined, "should not send summary via plain sendMessage when topic exists");

  // Forum topic should be closed after the summary
  assert.ok(adapter.closedTopics.length > 0, "should close forum topic after sending summary");

  await hub.stop();
  delete process.env.SHOW_EXECUTION_SUMMARY;
});

test("ChannelHub sends execution summary before flushing streamed draft to prevent ordering issues", async () => {
  process.env.SHOW_EXECUTION_SUMMARY = "true";
  const eventBus = new EventBus();
  const logger = createLogger("error");
  const adapter = new MockAdapter("telegram");

  const runtime: Runtime = {
    async execute(message, executionId, bus): Promise<void> {
      const base = { executionId, channelId: message.channelId, chatId: message.chatId };

      bus.emit({ ...base, type: "start", timestamp: 1000, payload: { agentName: "claude" } });

      // Simulate tool uses so the summary threshold is met
      bus.emit({ ...base, type: "tool-use", timestamp: 1500, payload: { toolName: "Read", toolInput: { file_path: "/a.ts" } } });
      bus.emit({ ...base, type: "tool-use", timestamp: 2000, payload: { toolName: "Edit", toolInput: { file_path: "/a.ts" } } });

      // Stream text to create a visible draft
      bus.emit({ ...base, type: "stream-text", timestamp: 3000, payload: { text: "Here is the response content" } });

      // Complete after enough time for summary to appear
      bus.emit({ ...base, type: "complete", timestamp: 8000, payload: { response: "Here is the response content" } });
    }
  };

  const router: Router = { select(message) { return { runtime, message }; } };
  const hub = new ChannelHub([adapter], router, eventBus, logger);
  await hub.start();

  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "do work" });
  await sleep(50);

  // Find the summary send and the draft finalization edit in the operation log
  const summaryIdx = adapter.operationLog.findIndex(
    (op) => (op.op === "sendMessage" || op.op === "sendMessageWithMarkup") && op.text?.includes("tools used")
  );
  const flushEditIdx = adapter.operationLog.findIndex(
    (op) => op.op === "editMessage" && op.text?.includes("Here is the response")
  );

  assert.ok(summaryIdx >= 0, "should send execution summary");
  assert.ok(flushEditIdx >= 0, "should flush draft via editMessage");
  assert.ok(
    summaryIdx < flushEditIdx,
    `summary (index ${summaryIdx}) should be sent before draft flush edit (index ${flushEditIdx}) to prevent user messages from appearing between response and summary`
  );

  await hub.stop();
  delete process.env.SHOW_EXECUTION_SUMMARY;
});
