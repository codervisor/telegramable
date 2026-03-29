import { randomUUID } from "crypto";
import { AgentConfig } from "../../config";
import { EventBus } from "../../events/eventBus";
import { NativeSessionState, AgentSession } from "./types";
import { CommandRunner, parseNativeId, spawnAndStream, stripAnsi } from "./utils";

export class GeminiSession implements AgentSession {
  readonly sessionId = randomUUID();
  private state: NativeSessionState | undefined;

  get resumeId(): string | undefined {
    return this.state?.nativeSessionId;
  }

  setResumeId(id: string): void {
    this.state = { strategy: "native", nativeSessionId: id };
  }

  constructor(
    readonly channelId: string,
    readonly chatId: string,
    private readonly config: AgentConfig,
    private readonly run: CommandRunner = spawnAndStream
  ) { }

  async send(userText: string, executionId: string, eventBus: EventBus): Promise<string> {
    try {
      return await this.execute(userText, executionId, eventBus, this.state?.nativeSessionId);
    } catch {
      if (!this.state) {
        throw new Error("Failed to start Gemini session.");
      }

      this.state = undefined;
      return this.execute(userText, executionId, eventBus, undefined);
    }
  }

  async close(): Promise<void> {
    this.state = undefined;
  }

  private async execute(userText: string, executionId: string, eventBus: EventBus, chatId?: string): Promise<string> {
    const args = [
      ...(this.config.args || []),
      ...(chatId ? ["--chat-id", chatId] : []),
      "-p",
      userText
    ];

    const result = await this.run(
      this.config.command,
      args,
      {
        cwd: this.config.workingDir,
        env: this.config.env,
        timeoutMs: this.config.timeoutMs
      },
      (type, text) => {
        eventBus.emit({
          executionId,
          channelId: this.channelId,
          chatId: this.chatId,
          type,
          timestamp: Date.now(),
          payload: { text }
        });
      }
    );

    if (result.code !== 0) {
      throw new Error(result.stderr || `Gemini command exited with code ${result.code ?? "unknown"}.`);
    }

    const cleaned = stripAnsi(result.stdout).trim();

    if (!chatId) {
      const nativeSessionId = parseNativeId(cleaned);
      if (nativeSessionId) {
        this.state = { strategy: "native", nativeSessionId };
      }
    }

    return cleaned;
  }
}