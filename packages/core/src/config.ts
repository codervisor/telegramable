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

/**
 * Validate that a channel ID is a well-formed identifier.
 * Must be 1–64 characters, lowercase alphanumeric with hyphens allowed (kebab-case).
 * Cannot start or end with a hyphen, and no consecutive hyphens.
 */
const validateChannelId = (id: string): string | undefined => {
  if (id.length === 0) return "TELEGRAM_CHANNEL_ID must not be empty.";
  if (id.length > 64) return `TELEGRAM_CHANNEL_ID must be at most 64 characters (got ${id.length}).`;
  if (id !== id.toLowerCase()) return `TELEGRAM_CHANNEL_ID must be lowercase: "${id}". Use "${id.toLowerCase()}" instead.`;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    return `TELEGRAM_CHANNEL_ID must be kebab-case (lowercase letters, digits, single hyphens): "${id}".`;
  }
  return undefined;
};

const parseChannels = (): ChannelConfig[] => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const rawId = process.env.TELEGRAM_CHANNEL_ID;

  if (!token) {
    return [];
  }

  if (!rawId || !rawId.trim()) {
    throw new Error(
      "TELEGRAM_CHANNEL_ID is required when TELEGRAM_BOT_TOKEN is set. " +
      "Set a kebab-case identifier, e.g. TELEGRAM_CHANNEL_ID=my-bot"
    );
  }

  const id = rawId.trim();
  const validationError = validateChannelId(id);
  if (validationError) {
    throw new Error(validationError);
  }

  const allowedUserIds = process.env.ALLOWED_USER_IDS
    ? process.env.ALLOWED_USER_IDS.split(",").map(s => s.trim()).filter(Boolean)
    : undefined;

  return [{ type: "telegram", id, token, allowedUserIds }];
};

const parseAgents = (): AgentConfig[] => {
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
