export type LogLevel = "debug" | "info" | "warn" | "error";

const levelOrder: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export interface Logger {
  debug: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
}

const formatValue = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
};

const formatMeta = (meta?: Record<string, unknown>): string => {
  if (!meta || Object.keys(meta).length === 0) {
    return "";
  }
  const entries = Object.entries(meta).filter(([, v]) => v !== undefined);
  if (entries.length === 0) {
    return "";
  }
  // Single short entry: inline
  if (entries.length === 1) {
    const [key, value] = entries[0];
    const formatted = formatValue(value);
    if (formatted.length <= 120) {
      return ` ${key}=${formatted}`;
    }
    // Long single value: put on next line
    return `\n  ${key}=${formatted}`;
  }
  // Multiple entries: one per line for readability
  const lines = entries.map(([key, value]) => `  ${key}=${formatValue(value)}`);
  return `\n${lines.join("\n")}`;
};

const levelLabel: Record<LogLevel, string> = {
  debug: "DBG",
  info:  "INF",
  warn:  "WRN",
  error: "ERR"
};

const isTTY = typeof process !== "undefined" && process.stdout?.isTTY;

const dim = (text: string): string => (isTTY ? `\x1b[2m${text}\x1b[22m` : text);
const bold = (text: string): string => (isTTY ? `\x1b[1m${text}\x1b[22m` : text);
const yellow = (text: string): string => (isTTY ? `\x1b[33m${text}\x1b[39m` : text);
const red = (text: string): string => (isTTY ? `\x1b[31m${text}\x1b[39m` : text);
const cyan = (text: string): string => (isTTY ? `\x1b[36m${text}\x1b[39m` : text);

const colorLevel = (target: LogLevel): string => {
  const label = levelLabel[target];
  switch (target) {
    case "debug": return dim(label);
    case "info":  return cyan(label);
    case "warn":  return yellow(label);
    case "error": return bold(red(label));
  }
};

const formatTimestamp = (date: Date): string => {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
};

export const createLogger = (level: LogLevel): Logger => {
  const threshold = levelOrder[level];

  const log = (target: LogLevel, message: string, meta?: Record<string, unknown>) => {
    if (levelOrder[target] < threshold) {
      return;
    }
    const timestamp = dim(formatTimestamp(new Date()));
    const label = colorLevel(target);
    const metaStr = formatMeta(meta);
    const output = `${timestamp} ${label} ${message}${metaStr}`;
    if (target === "error") {
      console.error(output);
      return;
    }
    if (target === "warn") {
      console.warn(output);
      return;
    }
    console.log(output);
  };

  return {
    debug: (message, meta) => log("debug", message, meta),
    info: (message, meta) => log("info", message, meta),
    warn: (message, meta) => log("warn", message, meta),
    error: (message, meta) => log("error", message, meta)
  };
};
