/**
 * Real end-to-end test against the Telegram Bot API.
 *
 * Boots the full stack in-process (TelegramAdapter → ChannelHub → Runtime),
 * sends a message via a Telegram **user account** (MTProto), and verifies the
 * pipeline completes by observing EventBus events.
 *
 * A user account is required because Telegram bots cannot receive messages
 * from other bots (or themselves) via getUpdates — only real user messages
 * are delivered.
 *
 * Required env vars:
 *   TELEGRAM_BOT_TOKEN      — bot under test (receiver / pipeline bot)
 *   TELEGRAM_TEST_CHAT_ID   — chat where the bot can receive messages
 *   TELEGRAM_API_ID         — from https://my.telegram.org
 *   TELEGRAM_API_HASH       — from https://my.telegram.org
 *   TELEGRAM_SESSION_STRING — MTProto session (see scripts/telegram-session.ts)
 *
 * Optional:
 *   E2E_RUNTIME_COMMAND     — runtime command (default: "echo")
 *   E2E_TIMEOUT_MS          — max wait for completion (default: 60000)
 *
 * Run:
 *   TELEGRAM_BOT_TOKEN=xxx TELEGRAM_API_ID=123 TELEGRAM_API_HASH=abc \
 *     TELEGRAM_SESSION_STRING=... TELEGRAM_TEST_CHAT_ID=456 \
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
const CHAT_ID = process.env.TELEGRAM_TEST_CHAT_ID ?? "";
const API_ID = process.env.TELEGRAM_API_ID ?? "";
const API_HASH = process.env.TELEGRAM_API_HASH ?? "";
const SESSION_STRING = process.env.TELEGRAM_SESSION_STRING ?? "";
const RUNTIME_COMMAND = process.env.E2E_RUNTIME_COMMAND ?? "echo";
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS) || 60_000;
const shouldSkip = !BOT_TOKEN || !CHAT_ID || !API_ID || !API_HASH || !SESSION_STRING;

/** Send a message as a real Telegram user via MTProto. */
async function sendAsUser(apiId: number, apiHash: string, session: string, chatId: string, text: string): Promise<void> {
  const { TelegramClient } = await import("telegram");
  const { StringSession } = await import("telegram/sessions");

  const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 3
  });

  await client.connect();
  try {
    await client.sendMessage(chatId, { message: text });
  } finally {
    await client.disconnect();
  }
}

test("E2E: Telegram message flows through the full pipeline", {
  skip: shouldSkip && "Missing env vars: TELEGRAM_BOT_TOKEN, TELEGRAM_TEST_CHAT_ID, TELEGRAM_API_ID, TELEGRAM_API_HASH, or TELEGRAM_SESSION_STRING",
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

    // Send a real message as a user via MTProto
    await sendAsUser(Number(API_ID), API_HASH, SESSION_STRING, CHAT_ID, marker);

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
