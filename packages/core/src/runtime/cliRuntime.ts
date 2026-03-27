import { spawn } from "child_process";
import { AgentConfig } from "../config";
import { EventBus } from "../events/eventBus";
import { IMMessage } from "../gateway/types";
import { Logger } from "../logging";
import { Runtime } from "./types";

export class CliRuntime implements Runtime {
  constructor(private readonly config: AgentConfig, private readonly logger: Logger) { }

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
      const child = spawn(this.config.command, this.config.args || [], {
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

      if (child.stdin) {
        child.stdin.write(message.text);
        child.stdin.write("\n");
        child.stdin.end();
      }

      this.logger.info("Spawned CLI runtime.", { executionId, command: this.config.command });
    });
  }
}
