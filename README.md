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
| RUNTIME_WORKING_DIR | `/data`¹ | Working directory for the agent    |
| RUNTIME_TIMEOUT_MS  | 600000   | Agent execution timeout in ms      |
| DEFAULT_AGENT       | default  | Default agent name                 |
| LOG_LEVEL           | info     | Log verbosity (`debug`, `info`, `warn`, `error`) |
| PERMISSION_MODE     | -        | Claude permission mode (see below) |
| ALLOWED_TOOLS       | -        | Comma-separated tool names to allow |
| DISALLOWED_TOOLS    | -        | Comma-separated tool names to deny |
| CLAUDE_MODEL        | -        | Claude model override (e.g., `claude-sonnet-4-6`) |
| SYSTEM_PROMPT       | -        | Custom system prompt for the agent |
| MAX_TURNS           | -        | Max agentic turns per execution    |
| MAX_BUDGET_USD      | -        | Max spend per execution (USD)      |
| BARE                | false    | Strip all formatting from output   |

¹ Defaults to `/data` automatically whenever the `/data` directory exists (commonly in Docker/Railway/containerized environments).

Supported runtimes: `cli`, `session-claude`, `session-claude-sdk`, `session-gemini`, `session-copilot`.

### Permissions

The `PERMISSION_MODE` variable controls how the agent handles tool approval:

| Mode                | Behavior |
| ------------------- | -------- |
| `plan`              | Agent can read files and search, but asks for approval before writes/commands |
| `auto`              | Agent auto-approves safe tools; still asks for destructive ones |
| `bypassPermissions` | Agent runs all tools without asking (requires non-root user in Docker) |

For the **SDK runtime** (`session-claude-sdk`), permission requests are forwarded to Telegram as inline keyboard buttons — tap "Allow" or "Deny" to approve each tool call.

For the **CLI runtime**, permission mode maps directly to `claude --permission-mode <mode>`.

**Fine-grained tool control** — use `ALLOWED_TOOLS` and `DISALLOWED_TOOLS` to whitelist or blacklist specific tools:

```bash
# Only allow file reads and searches
ALLOWED_TOOLS=Read,Glob,Grep

# Allow everything except bash
DISALLOWED_TOOLS=Bash
```

> **Tip for Railway/Docker deployments:** If the agent's first response is a generic "I'm Claude Code, here's what I can do" message instead of answering your question, set `PERMISSION_MODE=auto` or `PERMISSION_MODE=bypassPermissions` so it doesn't wait for tool approvals that can't be delivered in CLI mode.

### Long-Term Memory

Persist facts across sessions using a pinned Telegram message as storage.

**Create a memory chat:**

1. Open Telegram → New Channel (or New Group).
2. Name it anything (e.g., "Agent Memory").
3. Set it to **Public** and pick a username (e.g., `my_agent_memory`).
4. Go to channel settings → Administrators → **Add your bot** as admin.
5. Add to `.env`:
   ```bash
   MEMORY_CHAT_ID=@my_agent_memory
   ```

That's it. On first startup the bot pins a JSON message in the channel and uses it as persistent storage. You can make the channel private afterward — the bot resolves the username to an ID on boot.

**Automatic extraction** uses a cheap LLM to pick up facts from conversations. It auto-detects from env vars you likely already have:

| If you have...                          | Extraction works via        |
| --------------------------------------- | --------------------------- |
| `ANTHROPIC_API_KEY` (set for SDK runtime) | Anthropic Haiku (no extra config) |
| `OPENAI_BASE_URL` + `OPENAI_API_KEY`   | Any OpenAI-compatible API   |

For OpenRouter: set `OPENAI_BASE_URL=https://openrouter.ai/api/v1` and `OPENAI_API_KEY=sk-or-v1-...`. Override the model with `MEMORY_LLM_MODEL` if needed (defaults to Haiku / gpt-4o-mini).

**Commands:**

| Command                    | Description             |
| -------------------------- | ----------------------- |
| `/memory`                  | List all stored facts   |
| `/memory search <query>`   | Search facts by keyword |
| `/memory edit <id> <text>` | Update a fact           |
| `/memory delete <id>`      | Remove a fact           |
| `/memory export`           | Export facts as JSON    |

### Finding Telegram Chat IDs

Several config values require numeric Telegram IDs. Here's how to get each one.

**Bot token** (`TELEGRAM_BOT_TOKEN`):
1. Message [@BotFather](https://t.me/BotFather) on Telegram.
2. Send `/newbot`, follow the prompts, and copy the token it gives you.

**Your user ID** (`ALLOWED_USER_IDS`):
1. Message [@userinfobot](https://t.me/userinfobot) on Telegram.
2. It replies with your numeric user ID (e.g., `123456789`).

**Group/channel chat ID** (`MEMORY_CHAT_ID`):

*Option A — use the bot API directly:*
1. Add your bot to the group/channel as an admin.
2. Send any message in that chat.
3. Open this URL in your browser (replace `<TOKEN>` with your bot token):
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
4. Look for `"chat":{"id":-100xxxxxxxxxx}` in the response. That negative number is the chat ID.

*Option B — use [@RawDataBot](https://t.me/RawDataBot):*
1. Add `@RawDataBot` to your group temporarily.
2. It prints the chat info including the chat ID.
3. Remove the bot afterward.

**Forum topic ID** (`MEMORY_TOPIC_ID`):
1. In a group with Topics enabled, open the target topic.
2. Look at the URL in Telegram Desktop or Web — it ends with `/<topicId>` (e.g., `.../2`).
3. Or use the `getUpdates` method above — the topic ID appears as `"message_thread_id"` in messages sent within a topic.

**Example `.env`:**

```bash
TELEGRAM_BOT_TOKEN=7123456789:AAF...
ALLOWED_USER_IDS=123456789,987654321
MEMORY_CHAT_ID=@my_agent_memory      # or -1001234567890
MEMORY_TOPIC_ID=2
```

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
4. **Add a volume** — in the Railway dashboard, go to your service → **Settings → Volumes**, click **Add Volume**, and set the mount path to `/data`. This gives the container persistent storage for SQLite databases, agent session data, Claude Code conversation history (`~/.claude`), and any files the agent writes. Without a volume, all data is lost on each redeploy. On startup, the container automatically symlinks `~/.claude` → `/data/.claude` so that Claude Code sessions survive redeploys.
5. Deploy.

Alternatively, use the Railway CLI:

```bash
railway login
railway link
railway up
```

> **Note:** You still need to add the volume through the Railway dashboard — the CLI does not configure volumes.
