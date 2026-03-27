/**
 * Real end-to-end test against the Telegram Bot API.
 *
 * Boots the full stack in-process (TelegramAdapter → ChannelHub → Runtime),
 * sends a message via a *separate* sender bot, and verifies the pipeline
 * completes by observing EventBus events.
 *
 * Two bots are required because Telegram bots cannot receive their own
 * messages via getUpdates. The sender bot posts a message to the test chat
 * and the main bot picks it up through long-polling.
 *
 * Required env vars:
 *   TELEGRAM_BOT_TOKEN        — bot under test (receiver / pipeline bot)
 *   TELEGRAM_SENDER_BOT_TOKEN — helper bot that sends the test message
 *   TELEGRAM_TEST_CHAT_ID     — group chat where both bots are members
 *
 * Optional:
 *   E2E_RUNTIME_COMMAND       — runtime command (default: "echo")
 *   E2E_TIMEOUT_MS            — max wait for completion (default: 60000)
 *
 * Run:
 *   TELEGRAM_BOT_TOKEN=xxx TELEGRAM_SENDER_BOT_TOKEN=yyy TELEGRAM_TEST_CHAT_ID=123 \
 *     pnpm --filter @telegramable/core test:e2e
 */
import assert from "assert";
import test from "node:test";
import { TelegramAdapter } from "../src/gateway/telegramAdapter";
import { ChannelHub } from "../src/hub/hub";
import { DefaultRouter } from "../src/hub/router";
import { EventBus } from "../src/events/eventBus";
import { ExecutionEvent } from "../src/events/types";
import { createLogger } from "../src/logging";
import { createAgentRegistry } from "../src/runtime";
import { Config } from "../src/config";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const SENDER_BOT_TOKEN = process.env.TELEGRAM_SENDER_BOT_TOKEN ?? "";
const CHAT_ID = process.env.TELEGRAM_TEST_CHAT_ID ?? "";
const RUNTIME_COMMAND = process.env.E2E_RUNTIME_COMMAND ?? "echo";
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS) || 60_000;
const shouldSkip = !BOT_TOKEN || !SENDER_BOT_TOKEN || !CHAT_ID;

async function sendTelegramMessage(token: string, chatId: string, text: string): Promise<number> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  const json = (await res.json()) as { ok: boolean; result: { message_id: number }; description?: string };
  if (!json.ok) throw new Error(`sendMessage failed: ${json.description}`);
  return json.result.message_id;
}

test("E2E: Telegram message flows through the full pipeline", {
  skip: shouldSkip && "TELEGRAM_BOT_TOKEN, TELEGRAM_SENDER_BOT_TOKEN, or TELEGRAM_TEST_CHAT_ID not set",
  timeout: TIMEOUT_MS + 5_000
}, async () => {
  const logger = createLogger("info");
  const eventBus = new EventBus();
  const marker = `e2e-${Date.now()}`;

  // Build a minimal config that uses a simple echo runtime
  const config: Config = {
    logLevel: "info",
    channels: [{
      id: "telegram",
      type: "telegram" as const,
      token: BOT_TOKEN,
      defaultAgent: "test-agent"
    }],
    agents: [{
      name: "test-agent",
      command: RUNTIME_COMMAND
    }],
    defaultAgent: "test-agent"
  };

  const registry = createAgentRegistry(config, logger);
  const adapter = new TelegramAdapter("telegram", BOT_TOKEN, logger);
  const router = new DefaultRouter(config.channels, registry);
  const hub = new ChannelHub([adapter], router, eventBus, logger);

  // Collect events for our test chat
  const events: ExecutionEvent[] = [];
  eventBus.on((event) => {
    if (event.chatId === CHAT_ID) {
      events.push(event);
    }
  });

  // Start the hub (begins Telegram long-polling)
  await hub.start();

  try {
    // Wait briefly for polling to initialize
    await new Promise((r) => setTimeout(r, 2_000));

    // Send a real message via a *different* bot so the main bot can receive it
    const messageId = await sendTelegramMessage(SENDER_BOT_TOKEN, CHAT_ID, marker);
    assert.ok(messageId, "Test message should be sent");

    // Wait for the pipeline to complete
    const complete = await new Promise<ExecutionEvent>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Pipeline did not complete within ${TIMEOUT_MS}ms`)),
        TIMEOUT_MS
      );

      eventBus.on((event) => {
        if (event.chatId === CHAT_ID && (event.type === "complete" || event.type === "error")) {
          clearTimeout(timeout);
          resolve(event);
        }
      });
    });

    // Verify the pipeline processed the message
    const startEvent = events.find((e) => e.type === "start");
    assert.ok(startEvent, "should emit start event");
    assert.ok(complete, "should emit complete or error event");

    if (complete.type === "error") {
      // Runtime errors are acceptable (e.g. echo exits non-zero) but the
      // pipeline itself should not crash
      logger.warn("Runtime completed with error", { reason: complete.payload?.reason });
    }
  } finally {
    await hub.stop();
  }
});
