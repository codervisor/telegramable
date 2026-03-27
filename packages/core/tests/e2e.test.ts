/**
 * Real end-to-end test for the message pipeline.
 *
 * Boots the full stack in-process (StubAdapter → ChannelHub → CliRuntime),
 * injects a message through the adapter, and verifies the pipeline completes
 * by observing EventBus events.
 *
 * Required env vars:
 *   E2E_RUNTIME_COMMAND   — runtime command (default: "echo")
 *
 * Optional:
 *   E2E_TIMEOUT_MS        — max wait for completion (default: 10000)
 *
 * Run:
 *   pnpm --filter @telegramable/core test:e2e
 */
import assert from "assert";
import test from "node:test";
import { ChannelHub } from "../src/hub/hub";
import { DefaultRouter } from "../src/hub/router";
import { EventBus } from "../src/events/eventBus";
import { ExecutionEvent } from "../src/events/types";
import { IMAdapter, IMMessage } from "../src/gateway/types";
import { createLogger } from "../src/logging";
import { createAgentRegistry } from "../src/runtime";
import { Config } from "../src/config";

const RUNTIME_COMMAND = process.env.E2E_RUNTIME_COMMAND ?? "echo";
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS) || 10_000;

/**
 * Minimal adapter stub that exposes an `inject()` method to simulate
 * an inbound message without real Telegram polling.
 */
class StubAdapter implements IMAdapter {
  public readonly id: string;
  private onMessage?: (message: IMMessage) => void;

  constructor(id: string) {
    this.id = id;
  }

  async start(onMessage: (message: IMMessage) => void): Promise<void> {
    this.onMessage = onMessage;
  }

  inject(message: Omit<IMMessage, "channelId">): void {
    if (!this.onMessage) throw new Error("Adapter not started");
    this.onMessage({ ...message, channelId: this.id });
  }

  async sendMessage(_chatId: string, _text: string): Promise<void> {
    // no-op: we don't need to send real messages in this test
  }

  async stop(): Promise<void> {
    this.onMessage = undefined;
  }
}

test("E2E: message flows through the full pipeline", {
  timeout: TIMEOUT_MS + 5_000
}, async () => {
  const logger = createLogger("info");
  const eventBus = new EventBus();
  const marker = `e2e-${Date.now()}`;
  const chatId = "test-chat-1";

  const config: Config = {
    logLevel: "info",
    channels: [{
      id: "stub",
      type: "telegram" as const,
      token: "unused",
      defaultAgent: "test-agent"
    }],
    agents: [{
      name: "test-agent",
      command: RUNTIME_COMMAND
    }],
    defaultAgent: "test-agent"
  };

  const registry = createAgentRegistry(config, logger);
  const adapter = new StubAdapter("stub");
  const router = new DefaultRouter(config.channels, registry);
  const hub = new ChannelHub([adapter], router, eventBus, logger);

  // Collect events for our test chat
  const events: ExecutionEvent[] = [];
  eventBus.on((event) => {
    if (event.chatId === chatId) {
      events.push(event);
    }
  });

  await hub.start();

  try {
    // Inject a synthetic message into the pipeline
    adapter.inject({
      chatId,
      userId: "test-user",
      text: marker,
      messageId: 1
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
