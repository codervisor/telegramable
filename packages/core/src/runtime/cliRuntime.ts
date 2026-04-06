import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdtempSync, chmodSync, rmdirSync, openSync, closeSync, constants as fsConstants } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AgentConfig } from "../config";
import { EventBus } from "../events/eventBus";
import { IMMessage } from "../gateway/types";
import { Logger } from "../logging";
import type { MemorySnapshot } from "../memory";
import { MemoryProvider } from "../memory/provider";
import { TelegramMemoryProvider } from "../memory/telegramProvider";
import { Runtime } from "./types";
import { FileSessionStore } from "./session/fileSessionStore";

export interface CliRuntimeOptions {
  dataDir?: string;
  /** Returns an additional system prompt section at call time (e.g. memory facts). */
  getSystemPromptSuffix?: () => string;
  memoryProvider?: MemoryProvider;
  /** When true, attach the memory MCP stdio server to the CLI via --mcp-config. */
  useAgentDrivenMemory?: boolean;
}

export class CliRuntime implements Runtime {
  /** Map of "channelId::chatId" → Claude CLI session ID for conversation continuity. */
  private readonly sessions = new Map<string, string>();
  /** Per-session execution queue to serialize sequential messages and prevent concurrent CLI processes on the same session. */
  private readonly executionQueues = new Map<string, Promise<void>>();
  private readonly fileStore?: FileSessionStore;
  private readonly getSystemPromptSuffix?: () => string;
  private readonly memoryProvider?: MemoryProvider;
  private readonly useAgentDrivenMemory: boolean;

  /** Resolve the path to the compiled memoryMcpStdio.js once. */
  private memoryMcpStdioPath?: string;

  /** Prevent repeated root-fallback warnings from flooding logs. */
  private rootWarningLogged = false;

  constructor(private readonly config: AgentConfig, private readonly logger: Logger, options?: CliRuntimeOptions) {
    if (options?.dataDir) {
      this.fileStore = new FileSessionStore(options.dataDir, "cli-sessions.json", logger);
    }
    this.getSystemPromptSuffix = options?.getSystemPromptSuffix;
    this.memoryProvider = options?.memoryProvider;
    this.useAgentDrivenMemory = options?.useAgentDrivenMemory ?? false;

    // Warn about config fields that are silently ignored by the CLI runtime.
    // These fields exist on AgentConfig for other runtimes (SDK, session-claude)
    // but the CLI runtime always uses bypassPermissions.
    if (config.permissionMode && config.permissionMode !== "bypassPermissions") {
      this.logger.warn("CLI runtime ignores PERMISSION_MODE — always uses bypassPermissions (non-root) or auto (root).", { configured: config.permissionMode });
    }
    if (config.allowedTools?.length) {
      this.logger.warn("CLI runtime ignores ALLOWED_TOOLS — bypassPermissions approves all tools.", { tools: config.allowedTools });
    }
    if (config.disallowedTools?.length) {
      this.logger.warn("CLI runtime ignores DISALLOWED_TOOLS — bypassPermissions approves all tools.", { tools: config.disallowedTools });
    }
  }

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

    // Append the user-configured system prompt (SYSTEM_PROMPT env var)
    if (this.config.systemPrompt) {
      args.push("--append-system-prompt", this.config.systemPrompt);
    }

    // Append memory facts and (optionally) memory tool instructions
    const memorySuffix = this.getSystemPromptSuffix?.() || "";
    if (memorySuffix) {
      args.push("--append-system-prompt", memorySuffix);
    }

    // Always use bypassPermissions — the container runs as non-root (claude user),
    // and no proper HITL flow exists for interactive approval in --print mode.
    // The root guard remains as a safety net for misconfigured environments.
    if (process.getuid?.() === 0) {
      if (!this.rootWarningLogged) {
        this.rootWarningLogged = true;
        this.logger.warn(
          "bypassPermissions is not allowed as root — falling back to 'auto'. " +
          "Run the container as a non-root user to use bypassPermissions."
        );
      }
      args.push("--permission-mode", "auto");
    } else {
      args.push("--permission-mode", "bypassPermissions");
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

  /** Resolve the path to the compiled memoryMcpStdio.js script. */
  private resolveMemoryMcpStdioPath(): string {
    if (this.memoryMcpStdioPath) return this.memoryMcpStdioPath;
    // The script is compiled alongside this file in the core package dist
    this.memoryMcpStdioPath = join(__dirname, "..", "memory", "memoryMcpStdio.js");
    return this.memoryMcpStdioPath;
  }

  /**
   * Write a temporary MCP config file and memory state file for the CLI subprocess.
   * Returns paths and a baseline snapshot so changes can be diffed correctly even
   * when concurrent executions mutate the shared in-process MemoryStore.
   */
  private prepareMcpConfig(executionId: string): { mcpDir: string; mcpConfigPath: string; stateFilePath: string; baseline: MemorySnapshot } | null {
    if (!this.useAgentDrivenMemory) {
      this.logger.debug("Agent-driven memory disabled, skipping MCP config.", { executionId, hasMemoryProvider: !!this.memoryProvider });
      return null;
    }
    // CLI MCP stdio requires a TelegramMemoryProvider with direct MemoryStore access
    const telegramProvider = this.memoryProvider instanceof TelegramMemoryProvider ? this.memoryProvider : undefined;
    if (!telegramProvider) {
      this.logger.debug("Agent-driven memory via CLI MCP is only supported with telegram provider, skipping.", { executionId });
      return null;
    }

    const stdioScript = this.resolveMemoryMcpStdioPath();
    if (!existsSync(stdioScript)) {
      this.logger.warn("Memory MCP stdio script not found, skipping agent-driven memory for CLI.", { path: stdioScript });
      return null;
    }

    // Create a per-execution temp directory with restrictive permissions (0o700)
    const mcpDir = mkdtempSync(join(tmpdir(), `telegramable-mcp-${executionId}-`));
    chmodSync(mcpDir, 0o700);

    const stateFilePath = join(mcpDir, "memory-state.json");
    const mcpConfigPath = join(mcpDir, "mcp-config.json");

    // Capture baseline snapshot before spawning — used for diffing later
    const baseline = telegramProvider.store.snapshot();

    // Write files with restrictive permissions (0o600) via O_EXCL to prevent symlink attacks
    const writeSecure = (path: string, data: string): void => {
      const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      try {
        writeFileSync(fd, data, "utf-8");
      } finally {
        closeSync(fd);
      }
    };

    writeSecure(stateFilePath, JSON.stringify(baseline, null, 2));

    // Write MCP config pointing to the stdio script.
    // Use process.execPath for the absolute Node.js binary path — bare "node" may not
    // resolve correctly when the Claude CLI spawns the MCP server subprocess, especially
    // in Docker containers where PATH may differ between execution contexts.
    const mcpConfig = {
      mcpServers: {
        memory: {
          command: process.execPath,
          args: [stdioScript, stateFilePath],
        },
      },
    };
    writeSecure(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

    this.logger.info("Prepared MCP config for CLI memory tools.", { mcpDir, executionId, nodePath: process.execPath, stdioScript });
    return { mcpDir, mcpConfigPath, stateFilePath, baseline };
  }

  /**
   * Read back memory state from the temp file, diff against the baseline snapshot
   * captured at prepare time, and apply only the subprocess's changes to the live store.
   * Diffing against the baseline (not the live store) avoids misclassifying changes
   * when concurrent executions mutate the shared MemoryStore.
   */
  private async syncMemoryFromFile(stateFilePath: string, baseline: MemorySnapshot): Promise<void> {
    const telegramProvider = this.memoryProvider instanceof TelegramMemoryProvider ? this.memoryProvider : undefined;
    if (!telegramProvider) return;

    try {
      const raw = readFileSync(stateFilePath, "utf-8");
      const afterSnapshot: MemorySnapshot = JSON.parse(raw);
      if (!afterSnapshot.v || !Array.isArray(afterSnapshot.facts)) return;

      // Build lookup maps from baseline and subprocess result
      const baselineMap = new Map(baseline.facts.map((f) => [f.id, f]));
      const afterMap = new Map(afterSnapshot.facts.map((f) => [f.id, f]));

      const changelogParts: string[] = [];

      const store = telegramProvider.store;

      // Detect facts added by the subprocess (in after but not in baseline)
      for (const fact of afterSnapshot.facts) {
        if (!baselineMap.has(fact.id)) {
          const added = store.add(fact.tag, fact.text);
          changelogParts.push(`➕ <code>${added.id}</code> [${fact.tag}] ${fact.text}`);
        }
      }

      // Detect facts updated by the subprocess (in both, but text differs)
      for (const [id, baseFact] of baselineMap) {
        const afterFact = afterMap.get(id);
        if (afterFact && afterFact.text !== baseFact.text) {
          store.update(id, afterFact.text);
          changelogParts.push(`✏️ <code>${id}</code> → ${afterFact.text}`);
        }
      }

      // Detect facts removed by the subprocess (in baseline but not in after)
      for (const [id, baseFact] of baselineMap) {
        if (!afterMap.has(id)) {
          store.remove(id);
          changelogParts.push(`🗑️ <code>${id}</code> ${baseFact.text}`);
        }
      }

      if (changelogParts.length === 0) return;

      // Persist mutated store back to Telegram pinned message
      await telegramProvider.syncToTelegram();
      await telegramProvider.sendChangelog(
        `<b>🧠 Memory updated</b>\n\n${changelogParts.join("\n")}`,
      );

      this.logger.info("Memory synced from CLI MCP state file.", { changes: changelogParts.length });
    } catch (err) {
      this.logger.warn("Failed to sync memory from CLI MCP state file.", {
        reason: err instanceof Error ? err.message : "unknown",
      });
    }
  }

  /** Clean up temporary MCP directory and its files. */
  private cleanupMcpFiles(mcpDir: string, mcpConfigPath: string, stateFilePath: string): void {
    try { unlinkSync(mcpConfigPath); } catch { /* ignore */ }
    try { unlinkSync(stateFilePath); } catch { /* ignore */ }
    try { rmdirSync(mcpDir); } catch { /* ignore */ }
  }

  async execute(message: IMMessage, executionId: string, eventBus: EventBus): Promise<void> {
    const queueKey = `${message.channelId}::${message.chatId}`;
    const prev = this.executionQueues.get(queueKey) ?? Promise.resolve();

    // If there's a pending execution for this session, emit a "queued" event
    // so the hub can show the user their message is waiting (e.g. via reaction).
    if (this.executionQueues.has(queueKey)) {
      eventBus.emit({
        executionId,
        channelId: message.channelId,
        chatId: message.chatId,
        type: "queued",
        timestamp: Date.now(),
        payload: { messageId: message.messageId }
      });
    }

    const next = prev.then(
      () => this._execute(message, executionId, eventBus, false),
      () => this._execute(message, executionId, eventBus, false)
    );
    this.executionQueues.set(queueKey, next.catch(() => {}));
    return next;
  }

  private async _execute(message: IMMessage, executionId: string, eventBus: EventBus, isRetry: boolean): Promise<void> {
    if (!this.config.command) {
      throw new Error("Agent command is required for cli runtime.");
    }

    if (!isRetry) {
      eventBus.emit({
        executionId,
        channelId: message.channelId,
        chatId: message.chatId,
        type: "start",
        timestamp: Date.now(),
        payload: { agentName: this.config.name, messageId: message.messageId }
      });
    }

    // Prepare MCP config for agent-driven memory (if enabled)
    const mcpFiles = this.prepareMcpConfig(executionId);

    return new Promise((resolve, reject) => {
      const sessionKey = `${message.channelId}::${message.chatId}`;
      const existingSessionId = isRetry ? undefined : (this.sessions.get(sessionKey) || this.fileStore?.get(sessionKey));

      const { executable, initialArgs } = this.parseCommand();

      // Build args: command initial args → configured args → config-derived flags → session flags → prompt
      const args = [
        ...initialArgs,
        ...(this.config.args || []),
        ...this.buildConfigArgs()
      ];

      // Attach memory MCP server if prepared
      if (mcpFiles) {
        args.push("--mcp-config", mcpFiles.mcpConfigPath);
      }

      if (existingSessionId) {
        args.push("--resume", existingSessionId);
        // Ensure in-memory map is populated (may have been loaded from file store)
        this.sessions.set(sessionKey, existingSessionId);
      } else {
        const newSessionId = randomUUID();
        this.sessions.set(sessionKey, newSessionId);
        this.fileStore?.set(sessionKey, newSessionId);
        args.push("--session-id", newSessionId);
      }

      // Pass prompt as a positional argument (after "--" to prevent flag interpretation).
      // This avoids stdin pipe race conditions where the child process may not be ready
      // to read stdin, causing EPIPE errors.
      args.push("--", message.text);

      const child = spawn(executable, args, {
        cwd: this.config.workingDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          ...(this.config.env || {}),
          // Pass channel/chat context so the sudo wrapper can route
          // permission requests back to the correct Telegram chat.
          TELEGRAMABLE_CHANNEL_ID: message.channelId,
          TELEGRAMABLE_CHAT_ID: message.chatId,
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

      // Activity-based timeout: resets on each stdout/stderr chunk so
      // long-running but active processes don't get killed.
      let timeout: NodeJS.Timeout;
      // Cleanup helper — safe to call multiple times.
      let permissionUnsub: (() => void) | undefined;
      const cleanupPermissionSub = () => { permissionUnsub?.(); permissionUnsub = undefined; };

      const resetTimeout = () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
          child.kill("SIGKILL");
          cleanupPermissionSub();
          if (mcpFiles) this.cleanupMcpFiles(mcpFiles.mcpDir, mcpFiles.mcpConfigPath, mcpFiles.stateFilePath);
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
      };
      resetTimeout();

      // Subscribe to permission events so the timeout resets while waiting
      // for the user to approve/deny sudo requests via Telegram.  The child
      // process produces no stdout/stderr during that wait, so without this
      // the inactivity timeout would fire and kill a legitimately active run.
      permissionUnsub = eventBus.on((event) => {
        if (
          (event.type === "permission-request" || event.type === "permission-response") &&
          event.channelId === message.channelId &&
          event.chatId === message.chatId
        ) {
          resetTimeout();
        }
      });

      child.stdout?.on("data", (chunk: Buffer) => {
        receivedAnyOutput = true;
        resetTimeout(); // Reset inactivity timeout on output
        const text = chunk.toString();
        stdoutChunks.push(text);
        eventBus.emit({
          executionId,
          channelId: message.channelId,
          chatId: message.chatId,
          type: "stream-text",
          timestamp: Date.now(),
          payload: { text }
        });
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        receivedAnyOutput = true;
        resetTimeout(); // Reset inactivity timeout on output
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
        cleanupPermissionSub();
        if (mcpFiles) this.cleanupMcpFiles(mcpFiles.mcpDir, mcpFiles.mcpConfigPath, mcpFiles.stateFilePath);
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
        cleanupPermissionSub();

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
          if (mcpFiles) this.cleanupMcpFiles(mcpFiles.mcpDir, mcpFiles.mcpConfigPath, mcpFiles.stateFilePath);
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
          this.fileStore?.delete(sessionKey);

          // If this was a resumed session that failed because the conversation
          // no longer exists, transparently retry with a fresh session.
          if (existingSessionId && !isRetry && /no conversation found/i.test(stderr)) {
            if (mcpFiles) this.cleanupMcpFiles(mcpFiles.mcpDir, mcpFiles.mcpConfigPath, mcpFiles.stateFilePath);
            this.logger.info("Retrying with fresh session after stale resume ID.", { executionId, staleSessionId: existingSessionId });
            resolve(this._execute(message, executionId, eventBus, true));
            return;
          }
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

        // Sync memories from the MCP state file (agent-driven), or fall back to post-hoc extraction
        if (mcpFiles) {
          void this.syncMemoryFromFile(mcpFiles.stateFilePath, mcpFiles.baseline).finally(() => {
            this.cleanupMcpFiles(mcpFiles.mcpDir, mcpFiles.mcpConfigPath, mcpFiles.stateFilePath);
          });
        } else if (response && this.memoryProvider) {
          void this.extractMemory(message.text, response);
        }

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
        cwd: this.config.workingDir || "(inherited)",
        memoryMcp: mcpFiles ? "attached" : "none",
        mcpConfigPath: mcpFiles?.mcpConfigPath
      });
    });
  }

  private async extractMemory(userText: string, response: string): Promise<void> {
    try {
      const changelog = await this.memoryProvider!.ingest(userText, response);

      const parts: string[] = [];
      for (const fact of changelog.added) {
        parts.push(`➕ <code>${fact.id}</code> [${fact.tag}] ${fact.text}`);
      }
      for (const item of changelog.updated) {
        parts.push(`✏️ <code>${item.id}</code> → ${item.text}`);
      }
      for (const item of changelog.removed) {
        parts.push(`🗑️ <code>${item.id}</code> ${item.text}`);
      }

      if (parts.length > 0) {
        await this.memoryProvider!.sendChangelog(
          `<b>🧠 Memory updated</b>\n\n${parts.join("\n")}`
        );
      }
    } catch (err) {
      this.logger.warn("Memory extraction failed.", {
        reason: err instanceof Error ? err.message : "unknown",
      });
    }
  }
}
