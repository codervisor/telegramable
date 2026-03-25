import { execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const SERVICE_NAME = "telegramable";
const UNIT_DIR = join(homedir(), ".config", "systemd", "user");
const UNIT_PATH = join(UNIT_DIR, `${SERVICE_NAME}.service`);

function getBinPath(): string {
  try {
    return execSync("which telegramable", { encoding: "utf8" }).trim();
  } catch {
    return process.execPath;
  }
}

function buildUnit(binPath: string): string {
  const isNodeFallback = binPath === process.execPath;
  // __dirname at runtime = dist/service/, so ../cli.js resolves to dist/cli.js
  const execStart = isNodeFallback
    ? `${binPath} ${join(__dirname, "..", "cli.js")} start`
    : `${binPath} start`;

  return `[Unit]
Description=Telegramable IM Gateway Daemon
After=network.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=5
StandardOutput=append:${join(homedir(), ".telegramable", "logs", "daemon.log")}
StandardError=append:${join(homedir(), ".telegramable", "logs", "daemon.error.log")}
Environment=PATH=/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
`;
}

export function install(): void {
  mkdirSync(UNIT_DIR, { recursive: true });
  mkdirSync(join(homedir(), ".telegramable", "logs"), { recursive: true });

  const binPath = getBinPath();
  writeFileSync(UNIT_PATH, buildUnit(binPath), { encoding: "utf8" });
  execSync("systemctl --user daemon-reload", { stdio: "inherit" });
  execSync(`systemctl --user enable ${SERVICE_NAME}`, { stdio: "inherit" });
  console.log(`Installed systemd user service: ${UNIT_PATH}`);
  console.log(`Run: telegramable service start`);
}

export function uninstall(): void {
  try {
    execSync(`systemctl --user stop ${SERVICE_NAME} 2>/dev/null`, { stdio: "pipe" });
    execSync(`systemctl --user disable ${SERVICE_NAME} 2>/dev/null`, { stdio: "pipe" });
  } catch { /* ignore */ }

  if (existsSync(UNIT_PATH)) {
    rmSync(UNIT_PATH);
    execSync("systemctl --user daemon-reload", { stdio: "pipe" });
    console.log(`Removed: ${UNIT_PATH}`);
  } else {
    console.log("Service not installed.");
  }
}

export function start(): void {
  execSync(`systemctl --user start ${SERVICE_NAME}`, { stdio: "inherit" });
  console.log("Service started.");
}

export function stop(): void {
  execSync(`systemctl --user stop ${SERVICE_NAME}`, { stdio: "inherit" });
  console.log("Service stopped.");
}

export function restart(): void {
  execSync(`systemctl --user restart ${SERVICE_NAME}`, { stdio: "inherit" });
  console.log("Service restarted.");
}

export function status(): void {
  try {
    execSync(`systemctl --user status ${SERVICE_NAME}`, { stdio: "inherit" });
  } catch {
    // systemctl exits non-zero for stopped services, still prints output via inherit
  }
}
