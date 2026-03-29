import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { AgentConfig } from "../config";
import { EventBus } from "../events/eventBus";
import { IMMessage } from "../gateway/types";
import { Logger } from "../logging";
import { Runtime } from "./types";

export class CliRuntime implements Runtime {
  /** Map of "channelId::chatId" → Claude CLI session ID for conversation continuity. */
  private readonly sessions = new Map<string, string>();

  constructor(private readonly config: AgentConfig, private readonly logger: Logger) { }

  /**
   * Parse the command string into an executable and its initial arguments.
   * e.g. "claude --print" → { executable: "claude", initialArgs: ["--print"] }
   */
  private parseCommand(): { executable: string; initialArgs: string[] } {
    const parts = this.config.command!.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      throw new Error("Agent command is empty.");
    }
    return { executable: parts[0], initialArgs: parts.slice(1) };
  }

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

      const { executable, initialArgs } = this.parseCommand();

      // Build args: command initial args → configured args → config-derived flags → session flags → prompt
      const args = [
        ...initialArgs,
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

      // Pass prompt as a positional argument (after "--" to prevent flag interpretation).
      // This avoids stdin pipe race conditions where the child process may not be ready
      // to read stdin, causing EPIPE errors.
      args.push("--", message.text);

      const child = spawn(executable, args, {
        cwd: this.config.workingDir,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          ...(this.config.env || {})
        }
      });

      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      let receivedAnyOutput = false;
      const timeoutMs = this.config.timeoutMs ?? 10 * 60 * 1000;

      // Periodic "still alive" logging to diagnose hangs
      const heartbeat = setInterval(() => {
        this.logger.warn("CLI runtime still running — no exit yet.", {
          executionId,
          pid: child.pid,
          receivedAnyOutput,
          stdoutBytes: stdoutChunks.join("").length,
          stderrBytes: stderrChunks.join("").length
        });
      }, 30_000);

      const timeout: NodeJS.Timeout = setTimeout(() => {
        child.kill("SIGKILL");
        this.logger.error("CLI runtime timeout — killing process.", {
          executionId,
          pid: child.pid,
          timeoutMs,
          receivedAnyOutput,
          stderr: stderrChunks.join("").slice(0, 500)
        });
        eventBus.emit({
          executionId,
          channelId: message.channelId,
          chatId: message.chatId,
          type: "error",
          timestamp: Date.now(),
          payload: { reason: "Runtime timeout." }
        });
        reject(new Error("Runtime timeout."));
      }, timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        receivedAnyOutput = true;
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
        receivedAnyOutput = true;
        const text = chunk.toString();
        stderrChunks.push(text);
        this.logger.warn("CLI stderr output.", { executionId, text: text.slice(0, 500) });
        eventBus.emit({
          executionId,
          channelId: message.channelId,
          chatId: message.chatId,
          type: "stderr",
          timestamp: Date.now(),
          payload: { text }
        });
      });

      child.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timeout);
        clearInterval(heartbeat);
        let reason = error.message;
        if (error.code === "ENOENT") {
          reason = this.config.workingDir && !existsSync(this.config.workingDir)
            ? `Working directory not found: ${this.config.workingDir}`
            : `Command not found: "${executable}". Ensure it is installed and available in PATH.`;
        }
        this.logger.error("CLI runtime process error.", { executionId, reason, code: error.code });
        eventBus.emit({
          executionId,
          channelId: message.channelId,
          chatId: message.chatId,
          type: "error",
          timestamp: Date.now(),
          payload: { reason }
        });
        reject(new Error(reason));
      });

      child.on("close", (code: number | null) => {
        clearTimeout(timeout);
        clearInterval(heartbeat);

        const stderr = stderrChunks.join("").trim();

        this.logger.info("CLI runtime exited.", {
          executionId,
          pid: child.pid,
          exitCode: code,
          stdoutBytes: stdoutChunks.join("").length,
          stderrBytes: stderr.length,
          stderr: stderr.slice(0, 500) || undefined
        });

        // Exit code 127 means the shell could not find the command
        if (code === 127) {
          const reason = `Command not found: "${executable}". Ensure it is installed and available in PATH.`;
          eventBus.emit({
            executionId,
            channelId: message.channelId,
            chatId: message.chatId,
            type: "error",
            timestamp: Date.now(),
            payload: { reason }
          });
          reject(new Error(reason));
          return;
        }

        // If the CLI failed, clear the session so the next attempt starts fresh
        if (code !== 0) {
          this.logger.warn("CLI runtime exited with non-zero code.", {
            executionId,
            exitCode: code,
            stderr: stderr.slice(0, 1000) || undefined
          });
          this.sessions.delete(sessionKey);
        }

        const response = stdoutChunks.join("").trim();
        if (!response && code === 0) {
          this.logger.warn("CLI runtime exited successfully but produced no stdout output.", { executionId });
        }

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

      this.logger.info("Spawned CLI runtime.", {
        executionId,
        command: this.config.command,
        fullArgs: args.slice(0, -1).join(" "),  // omit user prompt for brevity
        sessionId: this.sessions.get(sessionKey),
        resumed: !!existingSessionId,
        pid: child.pid,
        hasOAuthToken: !!process.env.CLAUDE_CODE_OAUTH_TOKEN,
        hasApiKey: !!process.env.ANTHROPIC_API_KEY,
        cwd: this.config.workingDir || "(inherited)"
      });
    });
  }
}
