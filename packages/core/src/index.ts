import { Bot } from "grammy";
import { loadConfig } from "./config";
import { ChannelConfig } from "./config";
import { EventBus } from "./events/eventBus";
import { TelegramAdapter } from "./gateway/telegramAdapter";
import { IMAdapter } from "./gateway/types";
import { ChannelHub } from "./hub/hub";
import { DefaultRouter } from "./hub/router";
import { createLogger } from "./logging";
import { MemoryStore } from "./memory";
import { MemoryExtractor } from "./memory/extractor";
import { MemorySync } from "./memory/sync";
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

  if (config.channels.length === 0) {
    throw new Error("At least one channel must be configured.");
  }

  if (config.agents.length === 0) {
    throw new Error("At least one agent must be configured.");
  }

  // Initialize memory system if configured
  let memoryStore: MemoryStore | undefined;
  let memorySync: MemorySync | undefined;
  let memoryExtractor: MemoryExtractor | undefined;

  if (config.memory?.enabled) {
    // We need a Bot instance for MemorySync — get the token from the first Telegram channel
    const telegramChannel = config.channels.find((ch) => ch.type === "telegram");
    if (telegramChannel && typeof telegramChannel.token === "string") {
      const memBot = new Bot(telegramChannel.token);
      await memBot.init();

      memorySync = new MemorySync(memBot, config.memory, logger);
      memoryStore = new MemoryStore();

      if (config.memory.extraction) {
        memoryExtractor = new MemoryExtractor(config.memory.extraction, logger);
        logger.info("Memory extraction enabled.", { provider: config.memory.extraction.provider, model: config.memory.extraction.model });
      } else {
        logger.info("No extraction LLM configured — set ANTHROPIC_API_KEY or OPENAI_BASE_URL + OPENAI_API_KEY to enable automatic memory extraction.");
      }

      const snapshot = await memorySync.load();
      if (snapshot) {
        memoryStore.load(snapshot);
        logger.info("Memory loaded from Telegram.", { facts: memoryStore.all().length });
      } else {
        // Initialize empty memory and pin it
        await memorySync.save(memoryStore.snapshot());
        logger.info("Memory initialized (empty).");
      }
    } else {
      logger.warn("Memory enabled but no Telegram channel configured — skipping memory.");
    }
  }

  const registry = createAgentRegistry(config, logger, memoryStore, memorySync, memoryExtractor);

  const adapters = config.channels.map((channel) => createAdapter(channel, logger));
  const router = new DefaultRouter(config.channels, registry);
  const hub = new ChannelHub(adapters, router, eventBus, logger, undefined, memoryStore, memorySync);

  await hub.start();

  const shutdown = async () => {
    logger.info("Shutting down...");
    await hub.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
