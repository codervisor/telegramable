#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig, loadEnv, startDaemon } from "@telegramable/core";
import { serviceManager } from "./service";

const program = new Command();

program
  .name("telegramable")
  .description("Telegramable — Telegram-first AI agent interface")
  .version("0.1.0");

// ─── start / daemon ───────────────────────────────────────────────────────────

program
  .command("start")
  .alias("daemon")
  .description("Start the gateway in foreground (blocking)")
  .action(async () => {
    try {
      await startDaemon();
    } catch (err) {
      console.error("Fatal error:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

// ─── status ───────────────────────────────────────────────────────────────────

program
  .command("status")
  .description("Show configuration and process status")
  .action(() => {
    loadEnv();
    const config = loadConfig();

    console.log("\ntelegramable status\n");
    console.log(`  Channels configured : ${config.channels.length}`);
    console.log(`  Agents configured   : ${config.agents.length}`);
    console.log(`  Default agent       : ${config.defaultAgent ?? "(none)"}`);
    console.log(`  Log level           : ${config.logLevel}`);
    console.log();

    // Check if a background service is running
    try {
      serviceManager.status();
    } catch {
      // platform may not support service management; that's fine
    }
  });

// ─── service ──────────────────────────────────────────────────────────────────

const service = program
  .command("service")
  .description("Manage the telegramable background service");

service
  .command("install")
  .description("Install as a system service (systemd on Linux, launchd on macOS)")
  .action(() => {
    try {
      serviceManager.install();
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

service
  .command("uninstall")
  .description("Remove the system service")
  .action(() => {
    try {
      serviceManager.uninstall();
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

service
  .command("start")
  .description("Start the background service")
  .action(() => {
    try {
      serviceManager.start();
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

service
  .command("stop")
  .description("Stop the background service")
  .action(() => {
    try {
      serviceManager.stop();
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

service
  .command("restart")
  .description("Restart the background service")
  .action(() => {
    try {
      serviceManager.restart();
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

service
  .command("status")
  .description("Show background service status")
  .action(() => {
    try {
      serviceManager.status();
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program.parse(process.argv);
