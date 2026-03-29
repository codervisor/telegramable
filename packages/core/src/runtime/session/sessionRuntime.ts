import { AgentConfig } from "../../config";
import { EventBus } from "../../events/eventBus";
import { IMMessage } from "../../gateway/types";
import { Logger } from "../../logging";
import { Runtime } from "../types";
import { FileSessionStore } from "./fileSessionStore";
import { SessionManager } from "./types";

export class SessionRuntime implements Runtime {
  constructor(
    private readonly config: AgentConfig,
    private readonly sessionManager: SessionManager,
    private readonly logger: Logger,
    private readonly fileStore?: FileSessionStore
  ) { }

  async execute(message: IMMessage, executionId: string, eventBus: EventBus): Promise<void> {
    const session = this.sessionManager.getOrCreate(
      message.channelId,
      message.chatId,
      this.config.name
    );

    eventBus.emit({
      executionId,
      channelId: message.channelId,
      chatId: message.chatId,
      type: "start",
      timestamp: Date.now(),
      payload: { agentName: this.config.name }
    });

    const response = await session.send(message.text, executionId, eventBus);

    // Persist the session resume ID so conversations survive restarts
    if (session.resumeId && this.fileStore) {
      const storeKey = `${message.channelId}::${message.chatId}::${this.config.name}`;
      this.fileStore.set(storeKey, session.resumeId);
    }

    if (!response) {
      this.logger.warn("Session returned empty response — runtime may have failed silently.", {
        executionId,
        sessionId: session.sessionId,
        channelId: message.channelId,
        chatId: message.chatId,
        runtime: this.config.runtime
      });
    }

    eventBus.emit({
      executionId,
      channelId: message.channelId,
      chatId: message.chatId,
      type: "complete",
      timestamp: Date.now(),
      payload: { response }
    });

    this.logger.debug("Session runtime execution completed.", {
      executionId,
      sessionId: session.sessionId,
      channelId: message.channelId,
      chatId: message.chatId,
      runtime: this.config.runtime
    });
  }
}