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

export type PermissionMode = "plan" | "auto" | "bypassPermissions";

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

  // Claude options (shared by CLI and SDK runtimes)
  model?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxBudgetUsd?: number;
  permissionMode?: PermissionMode;
  outputFormat?: "text" | "json" | "stream-json";
  bare?: boolean;
}

export interface MemoryExtractionConfig {
  provider: "anthropic" | "openai";
  apiKey: string;
  model: string;
  baseUrl?: string; // For OpenAI-compatible endpoints (OpenRouter, local LLMs, etc.)
}

export interface MemoryConfig {
  enabled: boolean;
  chatId: string;
  topicId?: number;
  extraction?: MemoryExtractionConfig;
}

export interface Config {
  channels: ChannelConfig[];
  agents: AgentConfig[];
  defaultAgent?: string;
  logLevel: "debug" | "info" | "warn" | "error";
  dataDir?: string;
  memory?: MemoryConfig;
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

const parsePermissionMode = (value?: string): PermissionMode | undefined => {
  switch (value) {
    case "plan":
    case "auto":
    case "bypassPermissions":
      return value;
    default:
      return undefined;
  }
};

const parseOutputFormat = (value?: string): AgentConfig["outputFormat"] => {
  switch (value) {
    case "text":
    case "json":
    case "stream-json":
      return value;
    default:
      return undefined;
  }
};

const splitCsv = (value?: string): string[] | undefined => {
  if (!value) return undefined;
  const items = value.split(",").map(s => s.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
};

const DEFAULT_SYSTEM_PROMPT = [
  "You are a helpful AI assistant on Telegram.",
  "Be concise and conversational — avoid unnecessary formatting or verbose explanations.",
  "Use short paragraphs. Only use bullet points or code blocks when they genuinely help.",
  "Remember context from earlier messages in our conversation.",
].join(" ");

/** Returns `/data` when the directory exists (e.g. inside the Docker image), otherwise undefined. */
export const defaultWorkingDir = (dirExists: (path: string) => boolean = existsSync): string | undefined =>
  dirExists("/data") ? "/data" : undefined;

const parseAgents = (): AgentConfig[] => {
  const runtime = parseRuntime(process.env.RUNTIME_TYPE);

  // For SDK-based runtimes, command is not required
  const command = process.env.RUNTIME_COMMAND || "";
  if (!command && !runtime) {
    return [];
  }

  const rawTimeout = process.env.RUNTIME_TIMEOUT_MS?.trim();
  const timeoutMs = rawTimeout ? Number(rawTimeout) : 10 * 60 * 1000;
  const maxTurns = process.env.MAX_TURNS ? Number(process.env.MAX_TURNS) : undefined;
  const maxBudgetUsd = process.env.MAX_BUDGET_USD ? Number(process.env.MAX_BUDGET_USD) : undefined;

  return [{
    name: process.env.DEFAULT_AGENT || "default",
    runtime,
    command,
    workingDir: process.env.RUNTIME_WORKING_DIR || defaultWorkingDir(),
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 10 * 60 * 1000,
    maxTurns: maxTurns && Number.isFinite(maxTurns) ? maxTurns : undefined,
    model: process.env.CLAUDE_MODEL,
    systemPrompt: process.env.SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT,
    allowedTools: splitCsv(process.env.ALLOWED_TOOLS),
    disallowedTools: splitCsv(process.env.DISALLOWED_TOOLS),
    maxBudgetUsd: maxBudgetUsd && Number.isFinite(maxBudgetUsd) ? maxBudgetUsd : undefined,
    permissionMode: parsePermissionMode(process.env.PERMISSION_MODE),
    outputFormat: parseOutputFormat(process.env.OUTPUT_FORMAT),
    bare: process.env.BARE === "true"
  }];
};

export const loadConfig = (): Config => {
  // Load .env files before accessing process.env
  loadEnv();

  const memoryChatId = process.env.MEMORY_CHAT_ID?.trim();
  const memoryTopicId = process.env.MEMORY_TOPIC_ID?.trim();

  // Resolve memory extraction LLM — auto-detect from standard env vars:
  // 1. ANTHROPIC_API_KEY → Anthropic (already set for session-claude-sdk)
  // 2. OPENAI_BASE_URL + OPENAI_API_KEY → OpenAI-compatible (OpenRouter, etc.)
  const parseMemoryExtraction = (): MemoryExtractionConfig | undefined => {
    const memoryModel = process.env.MEMORY_LLM_MODEL?.trim();

    const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (anthropicKey) {
      return {
        provider: "anthropic",
        apiKey: anthropicKey,
        model: memoryModel || "claude-haiku-4-5-20251001",
      };
    }

    const openaiBaseUrl = process.env.OPENAI_BASE_URL?.trim();
    const openaiApiKey = process.env.OPENAI_API_KEY?.trim();
    if (openaiBaseUrl && openaiApiKey) {
      return {
        provider: "openai",
        apiKey: openaiApiKey,
        model: memoryModel || "gpt-4o-mini",
        baseUrl: openaiBaseUrl,
      };
    }

    return undefined;
  };

  return {
    channels: parseChannels(),
    agents: parseAgents(),
    defaultAgent: process.env.DEFAULT_AGENT,
    logLevel: parseLogLevel(process.env.LOG_LEVEL),
    dataDir: process.env.DATA_DIR || defaultWorkingDir() || undefined,
    memory: memoryChatId
      ? {
          enabled: true,
          chatId: memoryChatId,
          topicId: memoryTopicId ? Number(memoryTopicId) : undefined,
          extraction: parseMemoryExtraction(),
        }
      : undefined,
  };
};
