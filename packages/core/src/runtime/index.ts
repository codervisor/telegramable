import { AgentConfig, Config } from "../config";
import { AgentRegistry } from "../hub/agentRegistry";
import { Logger } from "../logging";
import { MemoryStore, buildMemoryPrompt } from "../memory";
import { MemoryExtractor } from "../memory/extractor";
import { createMemoryMcpServer } from "../memory/mcpServer";
import { MemorySync } from "../memory/sync";
import { CliRuntime } from "./cliRuntime";
import { ClaudeSession } from "./session/claudeSession";
import { CopilotSession } from "./session/copilotSession";
import { FileSessionStore } from "./session/fileSessionStore";
import { GeminiSession } from "./session/geminiSession";
import { SdkClaudeSession } from "./session/sdkClaudeSession";
import { InMemorySessionManager } from "./session/inMemorySessionManager";
import { SessionRuntime } from "./session/sessionRuntime";
import { Runtime } from "./types";

export interface CreateRuntimeOptions {
  dataDir?: string;
  memoryStore?: MemoryStore;
  memorySync?: MemorySync;
  memoryExtractor?: MemoryExtractor;
}

export const createRuntime = (agent: AgentConfig, logger: Logger, options?: CreateRuntimeOptions): Runtime => {
  const { dataDir, memoryStore, memorySync, memoryExtractor } = options ?? {};

  // Agent-driven memory via MCP is available for both SDK and CLI runtimes
  const canUseAgentDrivenMemory = (agent.runtime === "session-claude-sdk" || !agent.runtime || agent.runtime === "cli")
    && !!(memoryStore && memorySync);

  const getSystemPromptSuffix = memoryStore
    ? () => buildMemoryPrompt(memoryStore.all(), canUseAgentDrivenMemory)
    : undefined;

  const memoryMcpServers = (agent.runtime === "session-claude-sdk" && canUseAgentDrivenMemory)
    ? {
        memory: {
          type: "sdk" as const,
          name: "memory",
          instance: createMemoryMcpServer({ memoryStore, memorySync: memorySync!, logger }),
        },
      }
    : undefined;

  if (!agent.runtime || agent.runtime === "cli") {
    return new CliRuntime(agent, logger, {
      dataDir,
      getSystemPromptSuffix,
      memoryStore,
      memorySync,
      memoryExtractor,
      useAgentDrivenMemory: canUseAgentDrivenMemory,
    });
  }

  const fileStore = dataDir ? new FileSessionStore(dataDir, `${agent.runtime}-sessions.json`, logger) : undefined;

  const sessionManager = new InMemorySessionManager({
    sessionTimeoutMs: agent.sessionTimeoutMs,
    logger,
    fileStore,
    createSession: (channelId, chatId) => {
      switch (agent.runtime) {
        case "session-claude":
          return new ClaudeSession(channelId, chatId, agent);
        case "session-claude-sdk":
          return new SdkClaudeSession(channelId, chatId, agent, {
            model: agent.model,
            systemPrompt: agent.systemPrompt,
            allowedTools: agent.allowedTools,
            maxBudgetUsd: agent.maxBudgetUsd,
            cwd: agent.workingDir,
            getSystemPromptSuffix,
            mcpServers: memoryMcpServers,
          }, logger);
        case "session-gemini":
          return new GeminiSession(channelId, chatId, agent);
        case "session-copilot":
          return new CopilotSession(channelId, chatId, agent);
        default:
          throw new Error(`Unsupported session runtime '${agent.runtime}'.`);
      }
    }
  });

  // When agent-driven memory is active (MCP server), skip post-hoc extraction
  const usePostHocExtraction = !memoryMcpServers;

  return new SessionRuntime(agent, sessionManager, logger, {
    fileStore,
    memoryStore,
    memorySync,
    memoryExtractor: usePostHocExtraction ? memoryExtractor : undefined,
  });
};

export const createAgentRegistry = (config: Config, logger: Logger, memoryStore?: MemoryStore, memorySync?: MemorySync, memoryExtractor?: MemoryExtractor): AgentRegistry => {
  const registry = new AgentRegistry(config.defaultAgent);

  for (const agent of config.agents) {
    registry.register(agent.name, createRuntime(agent, logger, { dataDir: config.dataDir, memoryStore, memorySync, memoryExtractor }));
  }

  return registry;
};
