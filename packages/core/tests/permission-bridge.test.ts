import assert from "assert";
import test from "node:test";
import { PermissionBridge } from "../src/hub/permissionBridge";

const nullLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {}
};

test("PermissionBridge resolves allow when responded", async () => {
  const bridge = new PermissionBridge(nullLogger);

  const promise = bridge.request({
    requestId: "req-1",
    executionId: "exec-1",
    channelId: "ch-1",
    chatId: "chat-1",
    toolName: "Bash",
    toolInput: { command: "ls" }
  });

  assert.ok(bridge.hasPending("req-1"));

  const responded = bridge.respond("req-1", "allow");
  assert.ok(responded);
  assert.ok(!bridge.hasPending("req-1"));

  const decision = await promise;
  assert.equal(decision, "allow");
});

test("PermissionBridge resolves deny when responded", async () => {
  const bridge = new PermissionBridge(nullLogger);

  const promise = bridge.request({
    requestId: "req-2",
    executionId: "exec-2",
    channelId: "ch-1",
    chatId: "chat-1",
    toolName: "Write",
    toolInput: { file_path: "/tmp/test" }
  });

  bridge.respond("req-2", "deny");
  const decision = await promise;
  assert.equal(decision, "deny");
});

test("PermissionBridge respond returns false for unknown requestId", () => {
  const bridge = new PermissionBridge(nullLogger);
  const responded = bridge.respond("nonexistent", "allow");
  assert.ok(!responded);
});

test("PermissionBridge times out and denies", async () => {
  const bridge = new PermissionBridge(nullLogger, { defaultTimeoutMs: 50 });

  const promise = bridge.request({
    requestId: "req-timeout",
    executionId: "exec-timeout",
    channelId: "ch-1",
    chatId: "chat-1",
    toolName: "Bash",
    toolInput: { command: "rm -rf /" }
  });

  const decision = await promise;
  assert.equal(decision, "deny");
  assert.ok(!bridge.hasPending("req-timeout"));
});

test("PermissionBridge cancelAll denies all pending", async () => {
  const bridge = new PermissionBridge(nullLogger);

  const p1 = bridge.request({
    requestId: "req-a",
    executionId: "exec-a",
    channelId: "ch-1",
    chatId: "chat-1",
    toolName: "Bash",
    toolInput: {}
  });

  const p2 = bridge.request({
    requestId: "req-b",
    executionId: "exec-b",
    channelId: "ch-1",
    chatId: "chat-1",
    toolName: "Write",
    toolInput: {}
  });

  bridge.cancelAll();

  const [d1, d2] = await Promise.all([p1, p2]);
  assert.equal(d1, "deny");
  assert.equal(d2, "deny");
  assert.ok(!bridge.hasPending("req-a"));
  assert.ok(!bridge.hasPending("req-b"));
});
