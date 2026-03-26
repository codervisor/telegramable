import assert from "assert";
import { EventBus } from "../src/events/eventBus";
import { ChannelHub } from "../src/hub/hub";
import { createLogger } from "../src/logging";
import { MockAdapter } from "./mockAdapter";
import { MockRuntime } from "./mockRuntime";
import { Router } from "../src/hub/router";
import { IMMessage } from "../src/gateway/types";

class MockRouter implements Router {
  constructor(private readonly runtime: MockRuntime) {}

  select(message: IMMessage) {
    return { runtime: this.runtime, message };
  }
}

const run = async () => {
  const logger = createLogger("error");
  const adapter = new MockAdapter();
  const runtime = new MockRuntime();
  const eventBus = new EventBus();
  const router = new MockRouter(runtime);
  const hub = new ChannelHub([adapter], router, eventBus, logger);

  await hub.start();

  await adapter.simulateIncoming({
    channelId: "mock",
    chatId: "test-chat",
    userId: "user-1",
    text: "deploy staging"
  });

  await new Promise((resolve) => setTimeout(resolve, 10));

  // No verbose messages should be sent (start/stdout/complete without response are suppressed)
  assert.strictEqual(
    adapter.sentMessages.length,
    0,
    `Expected no verbose messages, got: ${JSON.stringify(adapter.sentMessages)}`
  );

  await hub.stop();
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
