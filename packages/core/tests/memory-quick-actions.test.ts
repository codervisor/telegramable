import assert from "assert";
import test from "node:test";
import { EventBus } from "../src/events/eventBus";
import { createLogger } from "../src/logging";
import { ChannelHub, parseBuiltinCommand } from "../src/hub/hub";
import { Router } from "../src/hub/router";
import { Runtime } from "../src/runtime/types";
import { MemoryStore } from "../src/memory";
import { MockAdapter } from "./mockAdapter";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function createTestHub(adapter: MockAdapter, memoryStore?: MemoryStore) {
  const eventBus = new EventBus();
  const logger = createLogger("error");
  const runtime: Runtime = {
    async execute(): Promise<void> {},
  };
  const router: Router = {
    select(message) {
      return { runtime, message };
    },
  };
  // Pass a mock memorySync that records save calls
  const memorySync = memoryStore
    ? { save: async () => {}, load: async () => null, sendChangelog: async () => {} }
    : undefined;

  return new ChannelHub(
    [adapter],
    router,
    eventBus,
    logger,
    undefined,
    memoryStore,
    memorySync as any
  );
}

function createStoreWithFacts(count: number): MemoryStore {
  const store = new MemoryStore();
  for (let i = 0; i < count; i++) {
    store.add("project", `Test fact ${i + 1}`);
  }
  return store;
}

// --- parseBuiltinCommand tests ---

test("parseBuiltinCommand parses /memory clear", () => {
  assert.deepEqual(parseBuiltinCommand("/memory clear"), { type: "memory-clear" });
  assert.deepEqual(parseBuiltinCommand(" /memory  clear "), { type: "memory-clear" });
});

test("parseBuiltinCommand parses /memory channel", () => {
  assert.deepEqual(parseBuiltinCommand("/memory channel"), { type: "memory-channel" });
});

// --- /memory with inline keyboard ---

test("/memory sends markup message with inline keyboard when adapter supports it", async () => {
  const adapter = new MockAdapter("telegram");
  const store = createStoreWithFacts(3);
  const hub = createTestHub(adapter, store);
  await hub.start();

  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "/memory" });
  await sleep(30);

  assert.equal(adapter.sentMarkupMessages.length, 1, "should send one markup message");
  const msg = adapter.sentMarkupMessages[0];
  assert.ok(msg.text.includes("Memory"), "should contain Memory header");
  assert.ok(msg.text.includes("3 facts"), "should show fact count");

  const markup = msg.markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
  assert.ok(markup.inline_keyboard.length > 0, "should have keyboard rows");

  // Check delete buttons exist
  const allButtons = markup.inline_keyboard.flat();
  assert.ok(allButtons.some((b) => b.callback_data === "mem:delete:f001:0"), "should have delete button for f001");
  assert.ok(allButtons.some((b) => b.callback_data === "mem:delete:f002:0"), "should have delete button for f002");

  // Check action row
  assert.ok(allButtons.some((b) => b.callback_data === "mem:clear:prompt"), "should have Clear All button");
  assert.ok(allButtons.some((b) => b.callback_data === "mem:export"), "should have Export button");
  assert.ok(allButtons.some((b) => b.callback_data === "mem:channel"), "should have Channel button");

  await hub.stop();
});

// --- Delete via callback ---

test("mem:delete callback removes fact and re-renders list", async () => {
  const adapter = new MockAdapter("telegram");
  const store = createStoreWithFacts(3);
  const hub = createTestHub(adapter, store);
  await hub.start();

  assert.equal(store.all().length, 3);

  await adapter.simulateCallback("chat-1", "mem:delete:f002:0", 42);
  await sleep(30);

  assert.equal(store.all().length, 2, "fact should be deleted");
  assert.equal(store.get("f002"), undefined, "f002 should be gone");

  // Should acknowledge callback
  assert.equal(adapter.answeredCallbacks.length, 1);
  assert.ok(adapter.answeredCallbacks[0].text?.includes("f002"));

  // Should edit message with updated list
  assert.equal(adapter.editedMarkupMessages.length, 1);
  const edited = adapter.editedMarkupMessages[0];
  assert.equal(edited.messageId, 42);
  assert.ok(edited.text.includes("2 facts"));

  await hub.stop();
});

// --- Clear all flow ---

test("mem:clear:prompt shows confirmation, confirm clears all facts", async () => {
  const adapter = new MockAdapter("telegram");
  const store = createStoreWithFacts(5);
  const hub = createTestHub(adapter, store);
  await hub.start();

  // Trigger clear prompt
  await adapter.simulateCallback("chat-1", "mem:clear:prompt", 42);
  await sleep(30);

  // Should edit message with confirmation
  assert.equal(adapter.editedMarkupMessages.length, 1);
  assert.ok(adapter.editedMarkupMessages[0].text.includes("Are you sure"));
  assert.ok(adapter.editedMarkupMessages[0].text.includes("5"), "should mention 5 facts");

  // Now confirm
  await adapter.simulateCallback("chat-1", "mem:clear:confirm", 42);
  await sleep(30);

  assert.equal(store.all().length, 0, "all facts should be cleared");
  assert.equal(adapter.answeredCallbacks.length, 2);
  assert.ok(adapter.answeredCallbacks[1].text?.includes("cleared"));

  await hub.stop();
});

test("mem:clear:cancel re-renders list without clearing", async () => {
  const adapter = new MockAdapter("telegram");
  const store = createStoreWithFacts(3);
  const hub = createTestHub(adapter, store);
  await hub.start();

  await adapter.simulateCallback("chat-1", "mem:clear:cancel", 42);
  await sleep(30);

  assert.equal(store.all().length, 3, "facts should not be cleared");
  assert.ok(adapter.answeredCallbacks[0].text?.includes("Cancelled"));

  await hub.stop();
});

// --- Export via callback ---

test("mem:export callback sends document", async () => {
  const adapter = new MockAdapter("telegram");
  const store = createStoreWithFacts(2);
  const hub = createTestHub(adapter, store);
  await hub.start();

  await adapter.simulateCallback("chat-1", "mem:export", 42);
  await sleep(30);

  assert.equal(adapter.sentDocuments.length, 1);
  assert.equal(adapter.sentDocuments[0].options?.fileName, "memory.json");

  await hub.stop();
});

// --- Pagination ---

test("pagination works for >8 facts", async () => {
  const adapter = new MockAdapter("telegram");
  const store = createStoreWithFacts(12);
  const hub = createTestHub(adapter, store);
  await hub.start();

  // List first page
  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "/memory" });
  await sleep(30);

  const msg = adapter.sentMarkupMessages[0];
  assert.ok(msg.text.includes("Page 1/2"));

  const markup = msg.markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
  const allButtons = markup.inline_keyboard.flat();
  assert.ok(allButtons.some((b) => b.text === "Next ▶"), "should have Next button");
  assert.ok(!allButtons.some((b) => b.text === "◀ Prev"), "should not have Prev button on page 1");

  // Navigate to page 2
  await adapter.simulateCallback("chat-1", "mem:page:1", msg.messageId);
  await sleep(30);

  assert.equal(adapter.editedMarkupMessages.length, 1);
  assert.ok(adapter.editedMarkupMessages[0].text.includes("Page 2/2"));

  await hub.stop();
});

// --- /memory clear command ---

test("/memory clear command shows confirmation with buttons", async () => {
  const adapter = new MockAdapter("telegram");
  const store = createStoreWithFacts(3);
  const hub = createTestHub(adapter, store);
  await hub.start();

  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "/memory clear" });
  await sleep(30);

  assert.equal(adapter.sentMarkupMessages.length, 1);
  assert.ok(adapter.sentMarkupMessages[0].text.includes("Are you sure"));

  await hub.stop();
});

// --- /memory channel command ---

test("/memory channel shows channel info with markup", async () => {
  const adapter = new MockAdapter("telegram");
  const store = createStoreWithFacts(1);
  const eventBus = new EventBus();
  const logger = createLogger("error");
  const runtime: Runtime = { async execute(): Promise<void> {} };
  const router: Router = { select(message) { return { runtime, message }; } };
  const memorySync = { save: async () => {}, load: async () => null, sendChangelog: async () => {} };

  const hub = new ChannelHub(
    [adapter],
    router,
    eventBus,
    logger,
    undefined,
    store,
    memorySync as any,
    { resolvedChatId: "-1001234567890", rawChatId: "@my_agent_memory", cacheSource: "cached" }
  );
  await hub.start();

  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "/memory channel" });
  await sleep(30);

  assert.equal(adapter.sentMarkupMessages.length, 1);
  const msg = adapter.sentMarkupMessages[0];
  assert.ok(msg.text.includes("-1001234567890"), "should show resolved chat ID");
  assert.ok(msg.text.includes("@my_agent_memory"), "should show raw chat ID");

  const markup = msg.markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
  const allButtons = markup.inline_keyboard.flat();
  assert.ok(allButtons.some((b) => b.callback_data === "mem:cache:flush"), "should have Flush Cache button");

  await hub.stop();
});

// --- Noop callback ---

test("mem:noop callback just acknowledges", async () => {
  const adapter = new MockAdapter("telegram");
  const store = createStoreWithFacts(1);
  const hub = createTestHub(adapter, store);
  await hub.start();

  await adapter.simulateCallback("chat-1", "mem:noop", 42);
  await sleep(30);

  assert.equal(adapter.answeredCallbacks.length, 1);
  assert.equal(adapter.editedMarkupMessages.length, 0, "should not edit message");

  await hub.stop();
});

// --- Empty memory ---

test("/memory with no facts shows empty state with no delete buttons", async () => {
  const adapter = new MockAdapter("telegram");
  const store = new MemoryStore();
  const hub = createTestHub(adapter, store);
  await hub.start();

  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "/memory" });
  await sleep(30);

  assert.equal(adapter.sentMarkupMessages.length, 1);
  assert.ok(adapter.sentMarkupMessages[0].text.includes("No memories"));

  await hub.stop();
});

// --- Cache flush ---

test("mem:cache:flush deletes cache entry and edits message", async () => {
  const adapter = new MockAdapter("telegram");
  const store = createStoreWithFacts(1);
  const eventBus = new EventBus();
  const logger = createLogger("error");
  const runtime: Runtime = { async execute(): Promise<void> {} };
  const router: Router = { select(message) { return { runtime, message }; } };
  const memorySync = { save: async () => {}, load: async () => null, sendChangelog: async () => {} };

  let deletedKey: string | undefined;
  const stubCacheStore = {
    get: () => undefined,
    set: () => {},
    delete: (key: string) => { deletedKey = key; },
  };

  const hub = new ChannelHub(
    [adapter],
    router,
    eventBus,
    logger,
    undefined,
    store,
    memorySync as any,
    { resolvedChatId: "-1001234567890", rawChatId: "@my_agent_memory", cacheSource: "cached", cacheStore: stubCacheStore as any }
  );
  await hub.start();

  await adapter.simulateCallback("chat-1", "mem:cache:flush", 42);
  await sleep(30);

  // Cache entry should be deleted with the raw chat ID
  assert.equal(deletedKey, "@my_agent_memory", "should delete cache entry for raw chat ID");

  // Should acknowledge callback
  assert.equal(adapter.answeredCallbacks.length, 1);
  assert.ok(adapter.answeredCallbacks[0].text?.includes("flushed"));

  // Should edit message with restart instructions
  assert.equal(adapter.editedMessages.length, 1);
  assert.ok(adapter.editedMessages[0].text.includes("Cache flushed"));
  assert.ok(adapter.editedMessages[0].text.includes("Restart"));

  await hub.stop();
});
