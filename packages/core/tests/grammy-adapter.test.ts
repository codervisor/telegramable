import assert from "assert";
import test from "node:test";
import { TelegramAdapter } from "../src/gateway/telegramAdapter";

test("TelegramAdapter constructor stores id and is stoppable without starting", async () => {
  const adapter = new TelegramAdapter("test-channel", "fake-token", 300, {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  });

  assert.equal(adapter.id, "test-channel");

  // Stopping before start should not throw
  await adapter.stop();
});

test("TelegramAdapter.sendMessage throws when bot not started", async () => {
  const adapter = new TelegramAdapter("test-channel", "fake-token", 300, {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  });

  await assert.rejects(
    () => adapter.sendMessage("123", "hello"),
    { message: "Telegram bot not started." }
  );
});

test("TelegramAdapter.sendMessageWithMarkup throws when bot not started", async () => {
  const adapter = new TelegramAdapter("test-channel", "fake-token", 300, {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  });

  await assert.rejects(
    () => adapter.sendMessageWithMarkup("123", "hello", {}),
    { message: "Telegram bot not started." }
  );
});

test("TelegramAdapter.editMessage throws when bot not started", async () => {
  const adapter = new TelegramAdapter("test-channel", "fake-token", 300, {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  });

  await assert.rejects(
    () => adapter.editMessage("123", 1, "new text"),
    { message: "Telegram bot not started." }
  );
});

test("TelegramAdapter.deleteMessage throws when bot not started", async () => {
  const adapter = new TelegramAdapter("test-channel", "fake-token", 300, {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  });

  await assert.rejects(
    () => adapter.deleteMessage("123", 1),
    { message: "Telegram bot not started." }
  );
});

test("TelegramAdapter.answerCallbackQuery throws when bot not started", async () => {
  const adapter = new TelegramAdapter("test-channel", "fake-token", 300, {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  });

  await assert.rejects(
    () => adapter.answerCallbackQuery("query-id"),
    { message: "Telegram bot not started." }
  );
});

test("TelegramAdapter.sendDocument throws when bot not started", async () => {
  const adapter = new TelegramAdapter("test-channel", "fake-token", 300, {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  });

  await assert.rejects(
    () => adapter.sendDocument("123", Buffer.from("data")),
    { message: "Telegram bot not started." }
  );
});

test("TelegramAdapter.getFileUrl throws when bot not started", async () => {
  const adapter = new TelegramAdapter("test-channel", "fake-token", 300, {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  });

  await assert.rejects(
    () => adapter.getFileUrl("file-id"),
    { message: "Telegram bot not started." }
  );
});

test("TelegramAdapter.createForumTopic throws when bot not started", async () => {
  const adapter = new TelegramAdapter("test-channel", "fake-token", 300, {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  });

  await assert.rejects(
    () => adapter.createForumTopic("123", "topic"),
    { message: "Telegram bot not started." }
  );
});

test("TelegramAdapter.closeForumTopic throws when bot not started", async () => {
  const adapter = new TelegramAdapter("test-channel", "fake-token", 300, {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  });

  await assert.rejects(
    () => adapter.closeForumTopic("123", 1),
    { message: "Telegram bot not started." }
  );
});
