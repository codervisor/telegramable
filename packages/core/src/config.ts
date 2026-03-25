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
  pollingInterval?: number;
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

const parseJson = <T>(raw: string | undefined): T | undefined => {
  if (!raw) {
    return undefined;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
};

const parseChannels = (): ChannelConfig[] => {
  const fromJson = parseJson<ChannelConfig[]>(process.env.CHANNELS_JSON);
  if (fromJson && Array.isArray(fromJson) && fromJson.length > 0) {
    return fromJson;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const id = process.env.TELEGRAM_CHANNEL_ID;
  const pollingInterval = Number(process.env.TELEGRAM_POLLING_INTERVAL || 300);

  if (!token) {
    return [];
  }

  if (!id) {
    throw new Error("TELEGRAM_CHANNEL_ID is required when TELEGRAM_BOT_TOKEN is set.");
  }

  return [{
    type: "telegram",
    id,
    token,
    pollingInterval: Number.isFinite(pollingInterval) ? pollingInterval : 300
  }];
};

const parseAgents = (): AgentConfig[] => {
  const fromJson = parseJson<AgentConfig[]>(process.env.AGENTS_JSON);
  if (fromJson && Array.isArray(fromJson) && fromJson.length > 0) {
    return fromJson;
  }

  const command = process.env.RUNTIME_COMMAND;
  if (!command) {
    return [];
  }

  const timeoutMs = Number(process.env.RUNTIME_TIMEOUT_MS || 10 * 60 * 1000);
  return [{
    name: process.env.DEFAULT_AGENT || "default",
    command,
    workingDir: process.env.RUNTIME_WORKING_DIR,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 10 * 60 * 1000
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
