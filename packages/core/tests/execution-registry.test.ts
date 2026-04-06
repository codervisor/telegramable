import assert from "assert";
import test from "node:test";
import { InMemoryExecutionRegistry } from "../src/hub/executionRegistry";

test("ExecutionRegistry stores lifecycle and returns newest-first list", () => {
  const registry = new InMemoryExecutionRegistry({
    now: () => 0
  });

  registry.start({
    executionId: "a",
    channelId: "telegram",
    chatId: "chat-1",
    agentName: "claude",
    startedAt: 1
  });

  registry.start({
    executionId: "b",
    channelId: "telegram",
    chatId: "chat-1",
    agentName: "gemini",
    startedAt: 2
  });

  registry.append("a", "[stdout] first\n[stderr] second");
  registry.complete("a", 10);

  const first = registry.get("a");
  assert.equal(first?.status, "complete");
  assert.deepEqual(first?.outputLines, ["[stdout] first", "[stderr] second"]);

  const listed = registry.list("telegram", "chat-1");
  assert.deepEqual(listed.map((record) => record.executionId), ["b", "a"]);
});

test("ExecutionRegistry keeps rolling output buffer and evicts by TTL", () => {
  let now = 0;
  const registry = new InMemoryExecutionRegistry({
    maxLines: 3,
    ttlMs: 100,
    now: () => now
  });

  registry.start({
    executionId: "exec-1",
    channelId: "telegram",
    chatId: "chat-1",
    agentName: "copilot",
    startedAt: now
  });

  registry.append("exec-1", "one\ntwo\nthree\nfour");
  assert.deepEqual(registry.get("exec-1")?.outputLines, ["two", "three", "four"]);

  registry.complete("exec-1", 10);
  now = 200;

  assert.equal(registry.list("telegram", "chat-1").length, 0);
});

test("ExecutionRegistry does not evict running executions", () => {
  let now = 0;
  const registry = new InMemoryExecutionRegistry({
    ttlMs: 10,
    now: () => now
  });

  registry.start({
    executionId: "live",
    channelId: "telegram",
    chatId: "chat-1",
    agentName: "claude",
    startedAt: 0
  });

  now = 1_000;

  const records = registry.list("telegram", "chat-1");
  assert.equal(records.length, 1);
  assert.equal(records[0]?.executionId, "live");
});

test("ExecutionRegistry trackToolUse records tool calls with timestamps", () => {
  let now = 100;
  const registry = new InMemoryExecutionRegistry({ now: () => now });

  registry.start({
    executionId: "t1",
    channelId: "telegram",
    chatId: "chat-1",
    agentName: "claude",
    startedAt: now
  });

  registry.trackToolUse("t1", "Read", { file_path: "/src/main.ts" });
  now = 200;
  registry.trackToolUse("t1", "Edit", { file_path: "/src/main.ts" });
  now = 300;
  registry.trackToolUse("t1", "Bash", { command: "npm test" });

  const record = registry.get("t1");
  assert.equal(record?.toolUses.length, 3);
  assert.equal(record?.toolUses[0].name, "Read");
  assert.equal(record?.toolUses[0].timestamp, 100);
  assert.deepEqual(record?.toolUses[0].input, { file_path: "/src/main.ts" });
  assert.equal(record?.toolUses[1].name, "Edit");
  assert.equal(record?.toolUses[1].timestamp, 200);
  assert.equal(record?.toolUses[2].name, "Bash");
  assert.equal(record?.toolUses[2].timestamp, 300);
});

test("ExecutionRegistry trackToolUse ignores unknown executionId", () => {
  const registry = new InMemoryExecutionRegistry();
  // Should not throw
  registry.trackToolUse("nonexistent", "Read");
  assert.equal(registry.get("nonexistent"), undefined);
});

test("ExecutionRegistry trackToolUse shallow-copies input to prevent mutation", () => {
  const registry = new InMemoryExecutionRegistry();
  registry.start({
    executionId: "t2",
    channelId: "telegram",
    chatId: "chat-1",
    agentName: "claude",
    startedAt: 0
  });

  const input = { file_path: "/a.ts" };
  registry.trackToolUse("t2", "Read", input);
  input.file_path = "/b.ts"; // mutate original

  assert.equal(registry.get("t2")?.toolUses[0].input?.file_path, "/a.ts");
});

test("ExecutionRegistry trackToolUse caps tool history at maxLines", () => {
  const registry = new InMemoryExecutionRegistry({ maxLines: 3 });
  registry.start({
    executionId: "t3",
    channelId: "telegram",
    chatId: "chat-1",
    agentName: "claude",
    startedAt: 0
  });

  registry.trackToolUse("t3", "Read");
  registry.trackToolUse("t3", "Edit");
  registry.trackToolUse("t3", "Bash");
  registry.trackToolUse("t3", "Grep");

  const record = registry.get("t3");
  assert.equal(record?.toolUses.length, 3);
  // Oldest entry (Read) should have been pruned
  assert.equal(record?.toolUses[0].name, "Edit");
  assert.equal(record?.toolUses[2].name, "Grep");
});

test("ExecutionRegistry initializes toolUses as empty array", () => {
  const registry = new InMemoryExecutionRegistry();
  registry.start({
    executionId: "t4",
    channelId: "telegram",
    chatId: "chat-1",
    agentName: "claude",
    startedAt: 0
  });

  const record = registry.get("t4");
  assert.ok(Array.isArray(record?.toolUses));
  assert.equal(record?.toolUses.length, 0);
});
