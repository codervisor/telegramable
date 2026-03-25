# Telegramable

Telegramable is a Telegram-first AI agent interface — ask your AI (Claude, Gemini, Copilot, etc.) to do things for you via instant messaging. It bridges the gap between mainstream IM experiences (like WeChat, Telegram) and AI coding agents, providing a single continuous conversation instead of fragmented multi-session interactions.

## Quick Start

1. Install dependencies:

```bash
pnpm install
```

2. Configure environment variables:

```bash
cp .env.example .env
```

3. Run in development:

```bash
pnpm --filter @telegramable/cli dev
```

## Configuration

| Variable            | Default  | Description                                   |
| ------------------- | -------- | --------------------------------------------- |
| IM_PROVIDER         | telegram | IM provider (`telegram` or `mock`).           |
| TELEGRAM_BOT_TOKEN  | -        | Telegram bot token (required for Telegram).   |
| RUNTIME_TYPE        | mock     | Runtime type (`mock` or `cli`).               |
| RUNTIME_COMMAND     | -        | Shell command to run when `RUNTIME_TYPE=cli`. |
| RUNTIME_WORKING_DIR | -        | Working directory for runtime command.        |
| RUNTIME_TIMEOUT_MS  | 600000   | Runtime timeout in ms.                        |
| LOG_LEVEL           | info     | Log verbosity.                                |

## Runtime Notes

- `mock` runtime echoes the command and completes immediately.
- `cli` runtime spawns `RUNTIME_COMMAND` and streams stdout/stderr back to IM.

## End-to-End Test

Run the mock adapter + mock runtime test:

```bash
pnpm --filter @telegramable/core test:e2e
```

## Docker

```bash
docker build -f apps/cli/Dockerfile -t telegramable .
```

```bash
docker run --env-file .env telegramable
```
