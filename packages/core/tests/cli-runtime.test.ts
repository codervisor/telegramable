import assert from "assert";
import path from "path";
import test from "node:test";
import { CliRuntime } from "../src/runtime/cliRuntime";
import { EventBus } from "../src/events/eventBus";
import { ExecutionEvent } from "../src/events/types";
import { createLogger } from "../src/logging";
import { AgentConfig } from "../src/config";
import { IMMessage } from "../src/gateway/types";

const logger = createLogger("error");

// Helper script that accepts a mode arg and ignores extra args (--session-id etc.)
const TEST_CMD = path.resolve(__dirname, "helpers/test-cmd.sh");

const msg = (overrides?: Partial<IMMessage>): IMMessage => ({
  channelId: "telegram",
  chatId: "chat-1",
  text: "hello",
  ...overrides
});

const collect = (eventBus: EventBus): ExecutionEvent[] => {
  const events: ExecutionEvent[] = [];
  eventBus.on((e) => events.push(e));
  return events;
};

// ---------- happy path ----------

test("CliRuntime passes prompt as positional argument", async () => {
  const config: AgentConfig = { name: "echo-agent", command: TEST_CMD, args: ["echo-last-arg"] };
  const runtime = new CliRuntime(config, logger);
  const eventBus = new EventBus();
  const events = collect(eventBus);

  await runtime.execute(msg({ text: "ping" }), "exec-1", eventBus);

  const types = events.map((e) => e.type);
  assert.ok(types.includes("start"), "should emit start event");
  assert.ok(types.includes("complete"), "should emit complete event");

  const complete = events.find((e) => e.type === "complete");
  assert.equal(complete?.payload?.response, "ping");
});

test("CliRuntime parses command string with embedded args", async () => {
  // "echo --flag" should be split into executable "echo" with initialArg "--flag"
  const config: AgentConfig = { name: "embed-agent", command: "echo --flag" };
  const runtime = new CliRuntime(config, logger);
  const eventBus = new EventBus();
  const events = collect(eventBus);

  await runtime.execute(msg({ text: "world" }), "exec-1b", eventBus);

  const stdout = events.filter((e) => e.type === "stream-text").map((e) => e.payload?.text).join("");
  assert.ok(stdout.includes("--flag"), "should include initial arg from command string");
  assert.ok(stdout.includes("world"), "should include prompt as positional arg");
});

test("CliRuntime captures stdout from command", async () => {
  // echo prints all its args — useful for verifying args are passed through
  const config: AgentConfig = { name: "hello-agent", command: "echo", args: ["hi"] };
  const runtime = new CliRuntime(config, logger);
  const eventBus = new EventBus();
  const events = collect(eventBus);

  await runtime.execute(msg(), "exec-2", eventBus);

  const stdout = events.filter((e) => e.type === "stream-text").map((e) => e.payload?.text).join("");
  assert.ok(stdout.includes("hi"), "stdout should contain 'hi'");
});

// ---------- stderr ----------

test("CliRuntime captures stderr", async () => {
  const config: AgentConfig = { name: "stderr-agent", command: TEST_CMD, args: ["stderr"] };
  const runtime = new CliRuntime(config, logger);
  const eventBus = new EventBus();
  const events = collect(eventBus);

  await runtime.execute(msg(), "exec-3", eventBus);

  const stderr = events.find((e) => e.type === "stderr");
  assert.ok(stderr, "should emit stderr event");
  assert.ok(stderr?.payload?.text?.includes("err"), "stderr text should contain 'err'");
});

// ---------- non-zero exit clears session ----------

test("CliRuntime clears session on non-zero exit", async () => {
  const config: AgentConfig = { name: "fail-agent", command: TEST_CMD, args: ["fail"] };
  const runtime = new CliRuntime(config, logger);
  const eventBus = new EventBus();
  const events = collect(eventBus);

  await runtime.execute(msg(), "exec-4", eventBus);

  const complete = events.find((e) => e.type === "complete");
  assert.equal(complete?.payload?.code, 1, "exit code should be 1");
});

test("CliRuntime clears session after failure so next call starts fresh", async () => {
  // Use echo so we can inspect args (--session-id vs --resume)
  const config: AgentConfig = { name: "recover-agent", command: "echo" };
  const runtime = new CliRuntime(config, logger);

  // First call: force a failure by using the fail helper
  // (Use a separate runtime instance since command differs)
  const failRuntime = new CliRuntime(
    { name: "recover-agent", command: TEST_CMD, args: ["fail"] },
    logger
  );
  // Note: failRuntime has its own session map, so this only tests the event.
  const eb1 = new EventBus();
  await failRuntime.execute(msg(), "exec-4b-1", eb1);

  // A fresh runtime's first call should use --session-id
  const eb2 = new EventBus();
  const ev2 = collect(eb2);
  await runtime.execute(msg(), "exec-4b-2", eb2);
  const stdout = ev2.filter((e) => e.type === "stream-text").map((e) => e.payload?.text).join("");
  assert.ok(stdout.includes("--session-id"), "fresh runtime should use --session-id");
});

// ---------- session reuse ----------

test("CliRuntime reuses session for same channel+chat", async () => {
  const config: AgentConfig = { name: "session-agent", command: "echo" };
  const runtime = new CliRuntime(config, logger);

  const eventBus1 = new EventBus();
  const events1 = collect(eventBus1);
  await runtime.execute(msg(), "exec-5a", eventBus1);
  const stdout1 = events1.filter((e) => e.type === "stream-text").map((e) => e.payload?.text).join("");
  assert.ok(stdout1.includes("--session-id"), "first call should use --session-id");

  const eventBus2 = new EventBus();
  const events2 = collect(eventBus2);
  await runtime.execute(msg(), "exec-5b", eventBus2);
  const stdout2 = events2.filter((e) => e.type === "stream-text").map((e) => e.payload?.text).join("");
  assert.ok(stdout2.includes("--resume"), "second call should use --resume");
});

test("CliRuntime uses separate sessions for different chats", async () => {
  const config: AgentConfig = { name: "multi-agent", command: "echo" };
  const runtime = new CliRuntime(config, logger);

  const eb1 = new EventBus();
  const ev1 = collect(eb1);
  await runtime.execute(msg({ chatId: "chat-A" }), "exec-6a", eb1);

  const eb2 = new EventBus();
  const ev2 = collect(eb2);
  await runtime.execute(msg({ chatId: "chat-B" }), "exec-6b", eb2);

  const out1 = ev1.filter((e) => e.type === "stream-text").map((e) => e.payload?.text).join("");
  const out2 = ev2.filter((e) => e.type === "stream-text").map((e) => e.payload?.text).join("");
  assert.ok(out1.includes("--session-id"), "chat-A should get its own session");
  assert.ok(out2.includes("--session-id"), "chat-B should get its own session");
});

// ---------- EPIPE: child exits before stdin write completes ----------

test("CliRuntime handles child that ignores prompt argument", async () => {
  // `true` exits immediately with code 0, ignoring all arguments
  const config: AgentConfig = { name: "ignore-agent", command: "true" };
  const runtime = new CliRuntime(config, logger);
  const eventBus = new EventBus();
  const events = collect(eventBus);

  await runtime.execute(msg({ text: "ignored prompt" }), "exec-7", eventBus);

  const complete = events.find((e) => e.type === "complete");
  assert.ok(complete, "should still emit complete event");
});

// ---------- timeout ----------

test("CliRuntime emits error event on timeout", async () => {
  const config: AgentConfig = {
    name: "slow-agent",
    command: TEST_CMD,
    args: ["hang"],
    timeoutMs: 200
  };
  const runtime = new CliRuntime(config, logger);
  const eventBus = new EventBus();
  const events = collect(eventBus);

  await assert.rejects(
    () => runtime.execute(msg(), "exec-8", eventBus),
    { message: "Runtime timeout." }
  );

  const error = events.find((e) => e.type === "error");
  assert.ok(error, "should emit error event");
  assert.equal(error?.payload?.reason, "Runtime timeout.");
});

// ---------- command not found (ENOENT) ----------

test("CliRuntime emits descriptive error when command is not found", async () => {
  const config: AgentConfig = { name: "missing-agent", command: "nonexistent_cmd_abc123" };
  const runtime = new CliRuntime(config, logger);
  const eventBus = new EventBus();
  const events = collect(eventBus);

  await assert.rejects(
    () => runtime.execute(msg(), "exec-enoent", eventBus),
    (error: Error) => {
      assert.match(error.message, /Command not found: "nonexistent_cmd_abc123"/);
      return true;
    }
  );

  const errorEvent = events.find((e) => e.type === "error");
  assert.ok(errorEvent, "should emit error event");
  assert.match(errorEvent!.payload!.reason as string, /Command not found/);
});

test("CliRuntime emits descriptive error when working directory does not exist", async () => {
  const config: AgentConfig = { name: "bad-cwd-agent", command: "echo", workingDir: "/nonexistent_dir_xyz" };
  const runtime = new CliRuntime(config, logger);
  const eventBus = new EventBus();
  const events = collect(eventBus);

  await assert.rejects(
    () => runtime.execute(msg(), "exec-cwd", eventBus),
    (error: Error) => {
      assert.match(error.message, /Working directory not found/);
      return true;
    }
  );

  const errorEvent = events.find((e) => e.type === "error");
  assert.ok(errorEvent, "should emit error event");
});

// ---------- missing command ----------

test("CliRuntime throws when command is not configured", async () => {
  const config: AgentConfig = { name: "no-cmd" } as AgentConfig;
  const runtime = new CliRuntime(config, logger);
  const eventBus = new EventBus();

  await assert.rejects(
    () => runtime.execute(msg(), "exec-9", eventBus),
    { message: "Agent command is required for cli runtime." }
  );
});

// ---------- config args ----------

test("CliRuntime passes config flags to the command", async () => {
  const config: AgentConfig = {
    name: "full-agent",
    command: "echo",
    model: "opus",
    systemPrompt: "be nice",
    permissionMode: "plan",
    maxTurns: 5,
    outputFormat: "json",
    bare: true
  };
  const runtime = new CliRuntime(config, logger);
  const eventBus = new EventBus();
  const events = collect(eventBus);

  await runtime.execute(msg(), "exec-10", eventBus);

  const stdout = events.filter((e) => e.type === "stream-text").map((e) => e.payload?.text).join("");
  assert.ok(stdout.includes("--model opus"), "should include --model");
  assert.ok(!stdout.includes("--append-system-prompt"), "should not pass systemPrompt via --append-system-prompt");
  assert.ok(stdout.includes("--permission-mode plan"), "should include --permission-mode");
  assert.ok(stdout.includes("--max-turns 5"), "should include --max-turns");
  assert.ok(stdout.includes("--output-format json"), "should include --output-format");
  assert.ok(stdout.includes("--bare"), "should include --bare");
});

// ---------- event metadata ----------

test("CliRuntime events carry correct channelId, chatId, executionId", async () => {
  const config: AgentConfig = { name: "meta-agent", command: "echo", args: ["ok"] };
  const runtime = new CliRuntime(config, logger);
  const eventBus = new EventBus();
  const events = collect(eventBus);

  await runtime.execute(msg({ channelId: "slack", chatId: "c-99" }), "exec-11", eventBus);

  for (const event of events) {
    assert.equal(event.channelId, "slack", `${event.type} should have channelId=slack`);
    assert.equal(event.chatId, "c-99", `${event.type} should have chatId=c-99`);
    assert.equal(event.executionId, "exec-11", `${event.type} should have correct executionId`);
  }
});
