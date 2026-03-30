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

Set environment variables in `.env` or your deployment platform (Railway, Docker, etc.).

| Variable            | Default  | Description                        |
| ------------------- | -------- | ---------------------------------- |
| TELEGRAM_BOT_TOKEN  | -        | Telegram bot token (required)      |
| TELEGRAM_CHANNEL_ID | telegram | Channel identifier (optional)      |
| ALLOWED_USER_IDS    | -        | Comma-separated Telegram user IDs  |
| RUNTIME_TYPE        | cli      | Runtime type (see below)           |
| RUNTIME_COMMAND     | -        | Agent command (e.g., `copilot`)    |
| RUNTIME_WORKING_DIR | -        | Working directory for the agent    |
| RUNTIME_TIMEOUT_MS  | 600000   | Agent execution timeout in ms      |
| DEFAULT_AGENT       | default  | Default agent name                 |
| LOG_LEVEL           | info     | Log verbosity (`debug`, `info`, `warn`, `error`) |

Supported runtimes: `cli`, `session-claude`, `session-claude-sdk`, `session-gemini`, `session-copilot`.

### Long-Term Memory

Telegramable can persist facts across sessions using Telegram itself as the storage backend. The agent automatically extracts key facts from conversations and stores them as a pinned JSON message in a dedicated Telegram chat.

| Variable          | Default | Description                                    |
| ----------------- | ------- | ---------------------------------------------- |
| MEMORY_CHAT_ID    | -       | Telegram chat ID for memory storage (enables memory) |
| MEMORY_TOPIC_ID   | -       | Forum topic ID within the chat (optional)      |

**Setup:**

1. Create a private channel or group in Telegram for memory storage.
2. Add your bot to that channel/group as an admin.
3. Copy the chat ID (you can use `@userinfobot` or the Telegram API to find it).
4. Set `MEMORY_CHAT_ID` in your `.env`. If using a forum group, also set `MEMORY_TOPIC_ID`.

On startup the bot loads the pinned memory snapshot and syncs changes back after each conversation.

**Extraction LLM** — automatically picks up facts from conversations. Two options:

| Variable            | Description                                              |
| ------------------- | -------------------------------------------------------- |
| ANTHROPIC_API_KEY   | Uses Anthropic API (defaults to `claude-haiku-4-5-20251001`) |
| MEMORY_LLM_BASE_URL | OpenAI-compatible endpoint (OpenRouter, local LLMs, etc.) |
| MEMORY_LLM_API_KEY  | API key for the OpenAI-compatible endpoint               |
| MEMORY_LLM_MODEL    | Model name (default: `gpt-4o-mini` for OpenAI, `claude-haiku-4-5-20251001` for Anthropic) |

Use **Option 1** (`ANTHROPIC_API_KEY`) if you have an Anthropic API account. Use **Option 2** (`MEMORY_LLM_BASE_URL` + `MEMORY_LLM_API_KEY`) for any OpenAI-compatible provider — e.g., OpenRouter, Ollama, vLLM, or Together AI.

**Example — OpenRouter (recommended if you only have Claude Pro/Max):**

```bash
MEMORY_LLM_BASE_URL=https://openrouter.ai/api/v1
MEMORY_LLM_API_KEY=sk-or-v1-your-key
MEMORY_LLM_MODEL=anthropic/claude-haiku-4-5-20251001
```

Sign up at [openrouter.ai](https://openrouter.ai), create an API key, and pick any cheap model for extraction (Haiku, Gemini Flash, etc.).

**User commands:**

| Command                    | Description             |
| -------------------------- | ----------------------- |
| `/memory`                  | List all stored facts   |
| `/memory search <query>`   | Search facts by keyword |
| `/memory edit <id> <text>` | Update a fact           |
| `/memory delete <id>`      | Remove a fact           |
| `/memory export`           | Export facts as JSON    |

Multi-channel and multi-agent setups will be managed via CLI commands (e.g., `telegramable channel add`, `telegramable agent add`) — see spec 018.

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
docker build -t telegramable .
docker run --env-file .env -p 3000:3000 telegramable
```

Both the CLI gateway and the web frontend run in the same container. The web UI is available on port 3000.

### Railway

1. Create a new project on [Railway](https://railway.app) and connect the GitHub repo.
2. Railway picks up `railway.toml` automatically — no manual settings needed.
3. Add your environment variables (see [Configuration](#configuration) above).
4. Deploy.

Alternatively, use the Railway CLI:

```bash
railway login
railway link
railway up
```
