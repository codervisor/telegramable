import { config as dotenvConfig } from "dotenv";
import { existsSync } from "fs";
import { dirname, resolve } from "path";

/**
 * Walk up from `startDir` until a directory containing `filename` is found,
 * or the filesystem root is reached. Returns the resolved path or undefined.
 */
const findFileUpwards = (filename: string, startDir: string): string | undefined => {
  let dir = startDir;
  while (true) {
    const candidate = resolve(dir, filename);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined; // reached fs root
    dir = parent;
  }
};

/**
 * Load environment variables from .env files in Next.js style:
 * 1. .env - default values
 * 2. .env.local - local overrides (not committed to git)
 *
 * Searches upward from process.cwd() so .env at the monorepo root is found
 * regardless of which package directory pnpm sets as cwd.
 */
export const loadEnv = (): void => {
  const envPath = findFileUpwards(".env", process.cwd());
  if (envPath) dotenvConfig({ path: envPath });

  const envLocalPath = findFileUpwards(".env.local", process.cwd());
  if (envLocalPath) dotenvConfig({ path: envLocalPath, override: true });
};

export type ChannelType = "telegram" | "slack" | "discord";

export interface ChannelConfig {
  type: ChannelType;
  id: string;
  defaultAgent?: string;
  allowedUserIds?: string[];
  [key: string]: unknown;
}

export interface AgentConfig {
  name: string;
  runtime?: "cli" | "session-claude" | "session-claude-sdk" | "session-gemini" | "session-copilot";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  workingDir?: string;
  timeoutMs?: number;
  sessionTimeoutMs?: number;
  maxTurns?: number;

  // Claude SDK-specific options
  model?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  maxBudgetUsd?: number;
}

export interface Config {
  channels: ChannelConfig[];
  agents: AgentConfig[];
  defaultAgent?: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

const parseLogLevel = (value?: string): Config["logLevel"] => {
  const normalized = (value || "info").toLowerCase();
  switch (normalized) {
    case "debug":
    case "info":
    case "warn":
    case "error":
      return normalized as Config["logLevel"];
    default:
      return "info";
  }
};

const parseChannels = (): ChannelConfig[] => {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    return [];
  }

  const id = process.env.TELEGRAM_CHANNEL_ID?.trim() || "telegram";

  const allowedUserIds = process.env.ALLOWED_USER_IDS
    ? process.env.ALLOWED_USER_IDS.split(",").map(s => s.trim()).filter(Boolean)
    : undefined;

  return [{ type: "telegram", id, token, allowedUserIds }];
};

const parseRuntime = (value?: string): AgentConfig["runtime"] => {
  switch (value) {
    case "cli":
    case "session-claude":
    case "session-claude-sdk":
    case "session-gemini":
    case "session-copilot":
      return value;
    default:
      return undefined; // defaults to "cli" in createRuntime
  }
};

const parseAgents = (): AgentConfig[] => {
  const runtime = parseRuntime(process.env.RUNTIME_TYPE);

  // For SDK-based runtimes, command is not required
  const command = process.env.RUNTIME_COMMAND || "";
  if (!command && !runtime) {
    return [];
  }

  const timeoutMs = Number(process.env.RUNTIME_TIMEOUT_MS || 10 * 60 * 1000);
  return [{
    name: process.env.DEFAULT_AGENT || "default",
    runtime,
    command,
    workingDir: process.env.RUNTIME_WORKING_DIR,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 10 * 60 * 1000,
    model: process.env.CLAUDE_MODEL,
    systemPrompt: process.env.SYSTEM_PROMPT,
    allowedTools: process.env.ALLOWED_TOOLS?.split(",").map(s => s.trim()).filter(Boolean),
    maxBudgetUsd: process.env.MAX_BUDGET_USD ? Number(process.env.MAX_BUDGET_USD) : undefined
  }];
};

export const loadConfig = (): Config => {
  // Load .env files before accessing process.env
  loadEnv();

  return {
    channels: parseChannels(),
    agents: parseAgents(),
    defaultAgent: process.env.DEFAULT_AGENT,
    logLevel: parseLogLevel(process.env.LOG_LEVEL)
  };
};
