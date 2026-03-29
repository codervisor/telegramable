import { AgentConfig, Config } from "../config";
import { AgentRegistry } from "../hub/agentRegistry";
import { Logger } from "../logging";
import { CliRuntime } from "./cliRuntime";
import { ClaudeSession } from "./session/claudeSession";
import { CopilotSession } from "./session/copilotSession";
import { FileSessionStore } from "./session/fileSessionStore";
import { GeminiSession } from "./session/geminiSession";
import { SdkClaudeSession } from "./session/sdkClaudeSession";
import { InMemorySessionManager } from "./session/inMemorySessionManager";
import { SessionRuntime } from "./session/sessionRuntime";
import { Runtime } from "./types";

export const createRuntime = (agent: AgentConfig, logger: Logger, dataDir?: string): Runtime => {
  if (!agent.runtime || agent.runtime === "cli") {
    return new CliRuntime(agent, logger, dataDir);
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
            cwd: agent.workingDir
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

  return new SessionRuntime(agent, sessionManager, logger, fileStore);
};

export const createAgentRegistry = (config: Config, logger: Logger): AgentRegistry => {
  const registry = new AgentRegistry(config.defaultAgent);

  for (const agent of config.agents) {
    registry.register(agent.name, createRuntime(agent, logger, config.dataDir));
  }

  return registry;
};
