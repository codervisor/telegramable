import { loadConfig } from "./config";
import { ChannelConfig } from "./config";
import { EventBus } from "./events/eventBus";
import { TelegramAdapter } from "./gateway/telegramAdapter";
import { IMAdapter } from "./gateway/types";
import { ChannelHub } from "./hub/hub";
import { DefaultRouter } from "./hub/router";
import { createLogger } from "./logging";
import { createAgentRegistry } from "./runtime";

export { loadConfig, loadEnv } from "./config";

const createAdapter = (channel: ChannelConfig, logger: ReturnType<typeof createLogger>): IMAdapter => {
  if (channel.type === "telegram") {
    if (typeof channel.token !== "string" || channel.token.length === 0) {
      throw new Error(`Telegram channel '${channel.id}' is missing token.`);
    }

    return new TelegramAdapter(channel.id, channel.token, logger, channel.allowedUserIds);
  }

  throw new Error(`Unsupported channel type '${channel.type}' for channel '${channel.id}'.`);
};

export async function startDaemon(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const eventBus = new EventBus();
  const registry = createAgentRegistry(config, logger);

  if (config.channels.length === 0) {
    throw new Error("At least one channel must be configured.");
  }

  if (config.agents.length === 0) {
    throw new Error("At least one agent must be configured.");
  }

  const adapters = config.channels.map((channel) => createAdapter(channel, logger));
  const router = new DefaultRouter(config.channels, registry);
  const hub = new ChannelHub(adapters, router, eventBus, logger);

  await hub.start();

  const shutdown = async () => {
    logger.info("Shutting down...");
    await hub.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
