import { execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const LABEL = "ai.telegramable.daemon";
const PLIST_DIR = join(homedir(), "Library", "LaunchAgents");
const PLIST_PATH = join(PLIST_DIR, `${LABEL}.plist`);

function getBinPath(): string {
  try {
    return execSync("which telegramable", { encoding: "utf8" }).trim();
  } catch {
    // fallback to node running the built cli
    return process.execPath;
  }
}

function buildPlist(binPath: string): string {
  const isNodeFallback = binPath === process.execPath;
  // __dirname at runtime = dist/service/, so ../cli.js resolves to dist/cli.js
  const programArgs = isNodeFallback
    ? `<string>${binPath}</string>\n    <string>${join(__dirname, "..", "cli.js")}</string>\n    <string>start</string>`
    : `<string>${binPath}</string>\n    <string>start</string>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    ${programArgs}
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>

  <key>RunAtLoad</key>
  <false/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${join(homedir(), ".telegramable", "logs", "daemon.log")}</string>

  <key>StandardErrorPath</key>
  <string>${join(homedir(), ".telegramable", "logs", "daemon.error.log")}</string>
</dict>
</plist>
`;
}

export function install(): void {
  mkdirSync(PLIST_DIR, { recursive: true });
  mkdirSync(join(homedir(), ".telegramable", "logs"), { recursive: true });

  const binPath = getBinPath();
  writeFileSync(PLIST_PATH, buildPlist(binPath), { encoding: "utf8" });
  console.log(`Installed launchd service: ${PLIST_PATH}`);
  console.log(`Run: telegramable service start`);
}

export function uninstall(): void {
  try {
    execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null`, { stdio: "pipe" });
  } catch { /* not loaded, ignore */ }

  if (existsSync(PLIST_PATH)) {
    rmSync(PLIST_PATH);
    console.log(`Removed: ${PLIST_PATH}`);
  } else {
    console.log("Service not installed.");
  }
}

export function start(): void {
  if (!existsSync(PLIST_PATH)) {
    console.error("Service not installed. Run: telegramable service install");
    process.exit(1);
  }
  execSync(`launchctl load "${PLIST_PATH}"`, { stdio: "inherit" });
  console.log("Service started.");
}

export function stop(): void {
  try {
    execSync(`launchctl unload "${PLIST_PATH}"`, { stdio: "inherit" });
    console.log("Service stopped.");
  } catch {
    console.log("Service was not running.");
  }
}

export function restart(): void {
  stop();
  start();
}

export function status(): void {
  try {
    const out = execSync(`launchctl list "${LABEL}" 2>&1`, { encoding: "utf8" });
    const pidMatch = out.match(/"PID"\s*=\s*(\d+)/);
    if (pidMatch) {
      console.log(`Service is running (PID ${pidMatch[1]})`);
    } else {
      console.log("Service is installed but not running.");
    }
  } catch {
    if (existsSync(PLIST_PATH)) {
      console.log("Service is installed but not running.");
    } else {
      console.log("Service is not installed.");
    }
  }
}
