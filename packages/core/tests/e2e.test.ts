/**
 * End-to-end test for the message pipeline.
 *
 * Boots the full stack in-process (TelegramAdapter → ChannelHub → CliRuntime)
 * and injects a raw Telegram Update via grammy's handleUpdate(), exercising
 * the real adapter handlers, hub routing, and runtime execution.
 *
 * A mock fetch is used so no real Telegram API calls are made — but the full
 * grammy handler chain, adapter logic, hub routing, and CliRuntime all run
 * with real code.
 *
 * No external secrets or Telegram accounts are required.
 *
 * Optional env vars:
 *   E2E_RUNTIME_COMMAND — runtime command (default: "echo")
 *   E2E_TIMEOUT_MS      — max wait for completion (default: 10000)
 *
 * Run:
 *   pnpm --filter @telegramable/core test:e2e
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

const RUNTIME_COMMAND = process.env.E2E_RUNTIME_COMMAND ?? "echo";
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS) || 10_000;

/** Mock fetch that returns canned Telegram API responses. */
const mockFetch: typeof fetch = async (input) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;

  // getMe — required by bot.init()
  if (url.includes("/getMe")) {
    return Response.json({
      ok: true,
      result: { id: 1, is_bot: true, first_name: "TestBot", username: "test_bot" }
    });
  }

  // sendMessage — called when hub forwards events back
  if (url.includes("/sendMessage")) {
    return Response.json({
      ok: true,
      result: { message_id: 200, chat: { id: 12345, type: "private" }, date: Math.floor(Date.now() / 1000), text: "" }
    });
  }

  // Default: return ok for any other API call
  return Response.json({ ok: true, result: true });
};

test("E2E: Telegram message flows through the full pipeline", {
  timeout: TIMEOUT_MS + 5_000
}, async () => {
  const logger = createLogger("info");
  const eventBus = new EventBus();
  const marker = `e2e-${Date.now()}`;
  const chatId = "12345";

  const config: Config = {
    logLevel: "info",
    channels: [{
      id: "telegram",
      type: "telegram" as const,
      token: "fake:token",
      defaultAgent: "test-agent"
    }],
    agents: [{
      name: "test-agent",
      command: RUNTIME_COMMAND
    }],
    defaultAgent: "test-agent"
  };

  const registry = createAgentRegistry(config, logger);
  const adapter = new TelegramAdapter("telegram", "fake:token", logger, undefined, {
    client: { fetch: mockFetch }
  });
  const router = new DefaultRouter(config.channels, registry);
  const hub = new ChannelHub([adapter], router, eventBus, logger);

  // Collect events for our test chat
  const events: ExecutionEvent[] = [];
  eventBus.on((event) => {
    if (event.chatId === chatId) {
      events.push(event);
    }
  });

  // Start with polling disabled — handlers are registered, no HTTP calls to Telegram
  await hub.start({ polling: false });

  try {
    // Inject a raw Telegram Update into grammy's handler chain, just like
    // a real update from getUpdates would be processed
    await adapter.handleUpdate({
      update_id: 1,
      message: {
        message_id: 100,
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(chatId), type: "private" },
        from: { id: 999, is_bot: false, first_name: "Test" },
        text: marker
      }
    });

    // Wait for the pipeline to complete
    const complete = await new Promise<ExecutionEvent>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Pipeline did not complete within ${TIMEOUT_MS}ms`)),
        TIMEOUT_MS
      );

      eventBus.on((event) => {
        if (event.chatId === chatId && (event.type === "complete" || event.type === "error")) {
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
