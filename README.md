# Telegramable

Telegramable is a Telegram-first AI agent interface — ask your AI (Claude, Gemini, Copilot, etc.) to do things for you via instant messaging. It bridges the gap between mainstream IM experiences (like WeChat, Telegram) and AI coding agents, providing a single continuous conversation instead of fragmented multi-session interactions.

## Quick Start

1. Install dependencies (requires Node.js >= 22 and pnpm):

```bash
pnpm install
```

2. Configure environment variables:

```bash
cp .env.example .env
# Edit .env with your Telegram bot token and agent settings
```

3. Run in development:

```bash
pnpm dev
```

Or run only the CLI gateway:

```bash
pnpm --filter @telegramable/cli dev
```

## Project Structure

```
apps/
  cli/          # Gateway daemon (@telegramable/cli)
  web/          # Next.js frontend (@telegramable/web)
packages/
  core/         # Shared gateway, hub, and runtime library (@telegramable/core)
  tsconfig/     # Shared TypeScript config
  ui/           # Shared UI components
```

## Configuration

Telegramable supports multi-channel and multi-agent setups via JSON environment variables, with legacy single-channel/agent fallbacks.

### Channels

Configure one or more IM channels:

```bash
# Option A: JSON (multiple channels)
CHANNELS_JSON='[{"type":"telegram","id":"my-telegram","token":"<BOT_TOKEN>","defaultAgent":"copilot"}]'

# Option B: Single Telegram channel (legacy)
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_CHANNEL_ID=<id>
```

### Agents

Configure one or more AI agents:

```bash
# Option A: JSON (multiple agents)
AGENTS_JSON='[{"name":"copilot","runtime":"session-copilot","command":"copilot","timeoutMs":120000,"sessionTimeoutMs":1800000,"maxTurns":10}]'

# Option B: Single agent (legacy)
RUNTIME_COMMAND=copilot
RUNTIME_WORKING_DIR=
RUNTIME_TIMEOUT_MS=120000
DEFAULT_AGENT=copilot
```

Supported runtimes: `cli`, `session-claude`, `session-claude-sdk`, `session-gemini`, `session-copilot`.

### General

| Variable       | Default | Description    |
| -------------- | ------- | -------------- |
| DEFAULT_AGENT  | -       | Default agent name |
| LOG_LEVEL      | info    | Log verbosity (`debug`, `info`, `warn`, `error`) |

## Testing

```bash
# Run all tests
pnpm test

# Run end-to-end tests (mock adapter + mock runtime)
pnpm test:e2e
```

## Deployment

### Docker

```bash
docker build -f apps/cli/Dockerfile -t telegramable .
docker run --env-file .env telegramable
```

### Railway

1. Create a new project on [Railway](https://railway.app) and connect the GitHub repo.
2. In service settings:
   - **Builder**: Dockerfile
   - **Dockerfile Path**: `apps/cli/Dockerfile`
3. Add your environment variables (see [Configuration](#configuration) above).
4. Deploy — Railway builds and runs the CLI gateway automatically.

Alternatively, use the Railway CLI:

```bash
railway login
railway link
railway up
```

No additional config files (`railway.toml`, `Procfile`) are needed — Railway auto-detects the Dockerfile.
