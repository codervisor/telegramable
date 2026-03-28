import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { AgentConfig } from "../config";
import { EventBus } from "../events/eventBus";
import { IMMessage } from "../gateway/types";
import { Logger } from "../logging";
import { Runtime } from "./types";

export class CliRuntime implements Runtime {
  /** Map of "channelId::chatId" → Claude CLI session ID for conversation continuity. */
  private readonly sessions = new Map<string, string>();

  constructor(private readonly config: AgentConfig, private readonly logger: Logger) { }

  /** Build CLI args from AgentConfig (model, tools, permissions, etc.). */
  private buildConfigArgs(): string[] {
    const args: string[] = [];

    if (this.config.model) {
      args.push("--model", this.config.model);
    }

    if (this.config.systemPrompt) {
      args.push("--append-system-prompt", this.config.systemPrompt);
    }

    if (this.config.permissionMode) {
      args.push("--permission-mode", this.config.permissionMode);
    }

    if (this.config.allowedTools?.length) {
      for (const tool of this.config.allowedTools) {
        args.push("--allowedTools", tool);
      }
    }

    if (this.config.disallowedTools?.length) {
      for (const tool of this.config.disallowedTools) {
        args.push("--disallowedTools", tool);
      }
    }

    if (this.config.maxTurns != null) {
      args.push("--max-turns", String(this.config.maxTurns));
    }

    if (this.config.maxBudgetUsd != null) {
      args.push("--max-budget-usd", String(this.config.maxBudgetUsd));
    }

    if (this.config.outputFormat) {
      args.push("--output-format", this.config.outputFormat);
    }

    if (this.config.bare) {
      args.push("--bare");
    }

    return args;
  }

  async execute(message: IMMessage, executionId: string, eventBus: EventBus): Promise<void> {
    if (!this.config.command) {
      throw new Error("Agent command is required for cli runtime.");
    }

    eventBus.emit({
      executionId,
      channelId: message.channelId,
      chatId: message.chatId,
      type: "start",
      timestamp: Date.now(),
      payload: { agentName: this.config.name }
    });

    return new Promise((resolve, reject) => {
      const sessionKey = `${message.channelId}::${message.chatId}`;
      const existingSessionId = this.sessions.get(sessionKey);

      // Build args: configured args → config-derived flags → session flags
      const args = [
        ...(this.config.args || []),
        ...this.buildConfigArgs()
      ];

      if (existingSessionId) {
        args.push("--resume", existingSessionId);
      } else {
        const newSessionId = randomUUID();
        this.sessions.set(sessionKey, newSessionId);
        args.push("--session-id", newSessionId);
      }

      const child = spawn(this.config.command, args, {
        cwd: this.config.workingDir,
        shell: true,
        env: {
          ...process.env,
          ...(this.config.env || {})
        }
      });

      const stdoutChunks: string[] = [];

      const timeout: NodeJS.Timeout = setTimeout(() => {
        child.kill("SIGKILL");
        eventBus.emit({
          executionId,
          channelId: message.channelId,
          chatId: message.chatId,
          type: "error",
          timestamp: Date.now(),
          payload: { reason: "Runtime timeout." }
        });
        reject(new Error("Runtime timeout."));
      }, this.config.timeoutMs ?? 10 * 60 * 1000);

      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stdoutChunks.push(text);
        eventBus.emit({
          executionId,
          channelId: message.channelId,
          chatId: message.chatId,
          type: "stdout",
          timestamp: Date.now(),
          payload: { text }
        });
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        eventBus.emit({
          executionId,
          channelId: message.channelId,
          chatId: message.chatId,
          type: "stderr",
          timestamp: Date.now(),
          payload: { text: chunk.toString() }
        });
      });

      child.on("error", (error: Error) => {
        clearTimeout(timeout);
        eventBus.emit({
          executionId,
          channelId: message.channelId,
          chatId: message.chatId,
          type: "error",
          timestamp: Date.now(),
          payload: { reason: error.message }
        });
        reject(error);
      });

      child.on("close", (code: number | null) => {
        clearTimeout(timeout);

        // If the CLI failed, clear the session so the next attempt starts fresh
        if (code !== 0) {
          this.sessions.delete(sessionKey);
        }

        const response = stdoutChunks.join("").trim();
        eventBus.emit({
          executionId,
          channelId: message.channelId,
          chatId: message.chatId,
          type: "complete",
          timestamp: Date.now(),
          payload: { code: code ?? null, response: response || undefined }
        });
        resolve();
      });

      child.on("spawn", () => {
        this.logger.info("Spawned CLI runtime.", {
          executionId,
          command: this.config.command,
          sessionId: this.sessions.get(sessionKey),
          resumed: !!existingSessionId
        });

        if (child.stdin) {
          child.stdin.on("error", (error: Error) => {
            this.logger.warn("stdin write failed.", { executionId, error: error.message });
          });
          child.stdin.write(message.text);
          child.stdin.write("\n");
          child.stdin.end();
        }
      });
    });
  }
}
