import assert from "assert";
import test from "node:test";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { EventBus } from "../src/events/eventBus";
import { ExecutionEvent } from "../src/events/types";
import { createLogger } from "../src/logging";
import { SudoWatcher } from "../src/hub/sudoWatcher";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "sudo-watcher-test-"));
}

function writeReqFile(dir: string, request: { id: string; command: string; channelId: string; chatId: string; timestamp?: number }): void {
  const reqPath = join(dir, `${request.id}.req`);
  writeFileSync(reqPath, JSON.stringify({
    ...request,
    timestamp: request.timestamp ?? Date.now()
  }), "utf-8");
}

test("SudoWatcher emits permission-request when .req file appears", async () => {
  const dir = makeTempDir();
  const eventBus = new EventBus();
  const logger = createLogger("error");
  const watcher = new SudoWatcher(dir, eventBus, logger);

  const events: ExecutionEvent[] = [];
  eventBus.on((event) => {
    if (event.type === "permission-request") {
      events.push(event);
    }
  });

  watcher.start();

  // Write a request file
  writeReqFile(dir, {
    id: "test-req-1",
    command: "apt-get install -y gcc",
    channelId: "telegram",
    chatId: "chat-123"
  });

  // Wait for fs.watch + setTimeout(50) to fire
  await sleep(300);

  assert.equal(events.length, 1, "Should emit one permission-request event");
  assert.equal(events[0].payload?.toolName, "sudo");
  assert.deepEqual(events[0].payload?.toolInput, { command: "apt-get install -y gcc" });
  assert.equal(events[0].payload?.permissionRequestId, "test-req-1");
  assert.equal(events[0].channelId, "telegram");
  assert.equal(events[0].chatId, "chat-123");

  watcher.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("SudoWatcher writes .res file on permission-response event", async () => {
  const dir = makeTempDir();
  const eventBus = new EventBus();
  const logger = createLogger("error");
  const watcher = new SudoWatcher(dir, eventBus, logger);

  watcher.start();

  // Write a request file
  writeReqFile(dir, {
    id: "test-req-2",
    command: "apt-get install -y ffmpeg",
    channelId: "telegram",
    chatId: "chat-456"
  });

  await sleep(300);

  // Simulate permission-response event (as if user clicked Approve in Telegram)
  eventBus.emit({
    executionId: "sudo-test-req-2",
    channelId: "telegram",
    chatId: "chat-456",
    type: "permission-response",
    timestamp: Date.now(),
    payload: {
      permissionRequestId: "test-req-2",
      decision: "allow"
    }
  });

  await sleep(100);

  // Response file should be written
  const resPath = join(dir, "test-req-2.res");
  assert.ok(existsSync(resPath), "Response file should exist");
  assert.equal(readFileSync(resPath, "utf-8"), "allow");

  // Request file should be cleaned up
  const reqPath = join(dir, "test-req-2.req");
  assert.ok(!existsSync(reqPath), "Request file should be cleaned up");

  watcher.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("SudoWatcher writes deny .res file on permission-response deny", async () => {
  const dir = makeTempDir();
  const eventBus = new EventBus();
  const logger = createLogger("error");
  const watcher = new SudoWatcher(dir, eventBus, logger);

  watcher.start();

  writeReqFile(dir, {
    id: "test-req-3",
    command: "rm -rf /",
    channelId: "telegram",
    chatId: "chat-789"
  });

  await sleep(300);

  eventBus.emit({
    executionId: "sudo-test-req-3",
    channelId: "telegram",
    chatId: "chat-789",
    type: "permission-response",
    timestamp: Date.now(),
    payload: {
      permissionRequestId: "test-req-3",
      decision: "deny"
    }
  });

  await sleep(100);

  const resPath = join(dir, "test-req-3.res");
  assert.ok(existsSync(resPath), "Response file should exist");
  assert.equal(readFileSync(resPath, "utf-8"), "deny");

  watcher.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("SudoWatcher processes existing .req files on startup", async () => {
  const dir = makeTempDir();
  const eventBus = new EventBus();
  const logger = createLogger("error");

  // Write request BEFORE starting the watcher
  writeReqFile(dir, {
    id: "pre-existing-req",
    command: "apt-get update",
    channelId: "telegram",
    chatId: "chat-pre"
  });

  const events: ExecutionEvent[] = [];
  eventBus.on((event) => {
    if (event.type === "permission-request") {
      events.push(event);
    }
  });

  const watcher = new SudoWatcher(dir, eventBus, logger);
  watcher.start();

  await sleep(100);

  assert.equal(events.length, 1, "Should process pre-existing request");
  assert.equal(events[0].payload?.permissionRequestId, "pre-existing-req");

  watcher.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("SudoWatcher denies pending requests on stop", async () => {
  const dir = makeTempDir();
  const eventBus = new EventBus();
  const logger = createLogger("error");
  const watcher = new SudoWatcher(dir, eventBus, logger);

  watcher.start();

  writeReqFile(dir, {
    id: "pending-on-stop",
    command: "apt-get install -y curl",
    channelId: "telegram",
    chatId: "chat-stop"
  });

  await sleep(300);

  // Stop without responding — should deny
  watcher.stop();

  const resPath = join(dir, "pending-on-stop.res");
  assert.ok(existsSync(resPath), "Should write deny response on stop");
  assert.equal(readFileSync(resPath, "utf-8"), "deny");

  rmSync(dir, { recursive: true, force: true });
});

test("SudoWatcher ignores permission-response for unknown request IDs", async () => {
  const dir = makeTempDir();
  const eventBus = new EventBus();
  const logger = createLogger("error");
  const watcher = new SudoWatcher(dir, eventBus, logger);

  watcher.start();

  // Emit a response for a request that doesn't exist
  eventBus.emit({
    executionId: "sudo-unknown",
    channelId: "telegram",
    chatId: "chat-x",
    type: "permission-response",
    timestamp: Date.now(),
    payload: {
      permissionRequestId: "nonexistent-id",
      decision: "allow"
    }
  });

  await sleep(100);

  // No .res file should be written
  const resPath = join(dir, "nonexistent-id.res");
  assert.ok(!existsSync(resPath), "Should not write response for unknown request");

  watcher.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("SudoWatcher polling fallback detects .req files when fs.watch misses them", async () => {
  const dir = makeTempDir();
  const eventBus = new EventBus();
  const logger = createLogger("error");
  const watcher = new SudoWatcher(dir, eventBus, logger);

  const events: ExecutionEvent[] = [];
  eventBus.on((event) => {
    if (event.type === "permission-request") {
      events.push(event);
    }
  });

  watcher.start();

  // Manually close the fs.watch to simulate it being unavailable,
  // then write a .req file — only the poll should detect it.
  (watcher as unknown as { watcher?: { close: () => void } }).watcher?.close();
  (watcher as unknown as { watcher?: unknown }).watcher = undefined;

  writeReqFile(dir, {
    id: "poll-only-req",
    command: "apt-get install -y vim",
    channelId: "telegram",
    chatId: "chat-poll"
  });

  // Wait for at least one poll cycle (2s interval + margin)
  await sleep(2500);

  assert.equal(events.length, 1, "Polling should detect the .req file");
  assert.equal(events[0].payload?.permissionRequestId, "poll-only-req");

  watcher.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("SudoWatcher deduplicates between fs.watch and polling", async () => {
  const dir = makeTempDir();
  const eventBus = new EventBus();
  const logger = createLogger("error");
  const watcher = new SudoWatcher(dir, eventBus, logger);

  const events: ExecutionEvent[] = [];
  eventBus.on((event) => {
    if (event.type === "permission-request") {
      events.push(event);
    }
  });

  watcher.start();

  writeReqFile(dir, {
    id: "dedup-req",
    command: "apt-get install -y htop",
    channelId: "telegram",
    chatId: "chat-dedup"
  });

  // Wait for fs.watch to fire, then wait past a poll cycle
  await sleep(2500);

  assert.equal(events.length, 1, "Should emit exactly one event despite fs.watch + polling");
  assert.equal(events[0].payload?.permissionRequestId, "dedup-req");

  watcher.stop();
  rmSync(dir, { recursive: true, force: true });
});
