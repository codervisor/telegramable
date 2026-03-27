---
status: draft
created: 2026-03-27
priority: critical
tags:
- memory
- persistence
- telegram
- architecture
depends_on:
- 016-telegram-ai-agent-proxy
---

# Persistent Memory via Telegram

> **Status**: draft · **Priority**: critical · **Created**: 2026-03-27
> **North Star**: The agent never forgets. Conversations accumulate knowledge across sessions, reboots, and container replacements — with zero local state.

## Problem

Today every session starts from scratch. `InMemorySessionManager` loses all state on restart. The Claude Agent SDK’s `resume` only works within a single session lifecycle. There is no mechanism for the agent to know who the user is, what projects they’re working on, or what decisions were made in past conversations.

This makes telegramable feel like a stranger every time you talk to it.

## Goal

Build a persistent memory system that:

1. **Survives container destruction** — no local files, no local databases
1. **Uses Telegram as the persistence layer** — the only durable store is Telegram’s cloud
1. **Is simple** — no vector databases, no embeddings, no RAG pipeline
1. **Grows smarter over time** — the more you use it, the better it knows you
1. **Is transparent and user-controllable** — you can see, edit, and delete what the agent remembers

## Prior Art Comparison

|System                      |Storage             |Transparency                   |Retrieval                     |Complexity    |
|----------------------------|--------------------|-------------------------------|------------------------------|--------------|
|Claude.ai memory            |Cloud (opaque)      |View/delete only               |Full inject into system prompt|Low (for user)|
|OpenAI memory               |Cloud (opaque)      |View/edit/delete               |Full inject                   |Low (for user)|
|OpenClaw                    |Local Markdown files|Fully transparent, git-friendly|Hybrid BM25 + vector          |Medium-high   |
|**Telegramable (this spec)**|**Telegram cloud**  |**Fully transparent in-chat**  |**Full inject (phase 1)**     |**Low**       |

Key differentiator: Telegram IS the database. No separate storage system to maintain, back up, or migrate.

## Design

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Telegram                                                │
│                                                          │
│  📱 Conversation Chat (existing)                         │
│     User ↔ Agent normal interaction                      │
│                                                          │
│  🧠 Memory Topic / Channel                               │
│     Pinned message = memory snapshot (structured JSON)   │
│     Message history = changelog (human-readable)         │
│     Bot is sole writer; user can view anytime            │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│  Telegramable Daemon (stateless — can be destroyed)      │
│                                                          │
│  ┌─────────────┐   ┌──────────────┐   ┌──────────────┐ │
│  │ MemoryLoader │   │ MemoryInjector│   │ MemoryExtract│ │
│  │ (cold start) │   │ (per query)   │   │ (post query) │ │
│  └──────┬──────┘   └──────┬───────┘   └──────┬───────┘ │
│         │                  │                   │         │
│   Read pinned msg    Build system prompt   Analyze conv  │
│   → in-memory cache  with memory facts     → update pin  │
└─────────────────────────────────────────────────────────┘
```

### Memory Storage Format

The pinned message in the Memory Topic/Channel contains the full memory snapshot as JSON:

```json
{
  "v": 1,
  "updated": "2026-03-27T10:30:00Z",
  "facts": [
    {
      "id": "f001",
      "tag": "project",
      "text": "Primary project is Synodic — AI harness platform, Rust+TS+Python monorepo",
      "at": "2026-03-25"
    },
    {
      "id": "f002",
      "tag": "preference",
      "text": "Prefers concise, low-token responses with structured hierarchy",
      "at": "2026-03-20"
    }
  ]
}
```

**Constraints:**

- Single Telegram message limit: 4096 characters
- At ~80 chars per fact: **~45-50 facts per message**
- For most personal use cases, this is sufficient for 6-12 months

**Overflow strategy (phase 2):** When facts exceed single-message capacity, split across multiple messages using a reply chain. First message is pinned, subsequent messages reply to it. Loader reads the chain.

### Memory Topic/Channel Selection

Two options, choose based on deployment:

**Option A: Forum Topic** (recommended when using Forum Group for sessions)

- Memory is a dedicated topic named “🧠 Memory” in the same Forum Group
- Consistent with spec-016’s Forum Topics as session threads
- User sees everything in one Group

**Option B: Private Channel** (recommended for Private Chat deployments)

- A separate Telegram Channel where Bot is admin
- User can join to view, but doesn’t need to
- Cleaner separation; conversation chat stays uncluttered

Config:

```ts
interface MemoryConfig {
  enabled: boolean;
  chatId: string;        // Memory channel/group chat ID
  topicId?: number;      // Forum topic ID (if using Forum Group)
}
```

Set via environment variables:

```
MEMORY_CHAT_ID="-1001234567890"
MEMORY_TOPIC_ID="42"           # optional, for Forum Group mode
```

### Lifecycle

#### 1. Cold Start (container boot)

```
daemon starts
  → MemoryLoader reads pinned message from Memory chat/topic
  → Parse JSON → populate in-memory MemoryStore
  → If no pinned message exists → initialize empty store, send + pin initial message
  → Ready to serve
```

Implementation: single `bot.api.getChat()` + `bot.api.unpinAllChatMessages()` is not needed — use a known message structure. The simplest approach: on first boot, Bot sends the initial JSON message and pins it, storing the `message_id`. On subsequent boots, Bot calls `getChat` to find the pinned message, then `getMessage` to read it.

**Fallback:** If pinned message is missing or corrupt, start with empty memory and log a warning. Never crash on memory load failure.

#### 2. Memory Injection (before each Agent SDK query)

```
user sends message
  → SessionRuntime prepares to call Agent SDK
  → MemoryInjector reads current facts from MemoryStore
  → Builds system prompt section:

    "You know the following about the user:
     
     ## Projects
     - Primary project is Synodic — AI harness platform, Rust+TS+Python monorepo
     - Ising: three-layer code graph analysis engine in Rust
     
     ## Personal
     - Planning to migrate to Sydney in 2026
     
     ## Preferences
     - Prefers concise, low-token responses"

  → Appended to SdkClaudeSession's systemPrompt option
  → Agent SDK query() executes with full context
```

#### 3. Memory Extraction (after each Agent SDK query)

```
agent response complete
  → MemoryExtractor receives (conversation, currentFacts)
  → Calls lightweight model (Haiku) with extraction prompt
  → Haiku returns: { add: [...], update: [...], remove: [...] }
  → If no changes → skip
  → If changes:
    → Update in-memory MemoryStore
    → bot.api.editMessageText(pinnedMessageId, newJSON)
    → bot.api.sendMessage(memoryChatId, changelogText)
  → Non-blocking: extraction runs async, does not delay next user message
```

#### 4. User Commands

```
/memory              → List all facts grouped by tag
/memory search <q>   → Simple substring match across facts
/memory edit <id> <text>  → Update a fact
/memory delete <id>  → Remove a fact
/memory export       → Send full JSON as a document
```

Commands are handled by the ChannelHub as built-in commands (extending the existing `/status`, `/logs`, `/list` pattern).

### Memory Extraction Prompt

```
You are a memory manager for a personal AI assistant. Analyze the conversation
below and compare against existing memories. Output changes needed.

Rules:
- Only record facts with long-term value: projects, decisions, preferences, 
  personal context, technical choices
- Ignore transient questions ("what's the weather", "translate this")
- If new info conflicts with existing memory, output an update
- If existing memory is clearly outdated, output a remove
- Keep each fact under 60 characters
- Assign a tag: project | personal | preference | decision | context
- Output strict JSON, nothing else

Current memories:
{current_facts_json}

Conversation:
{conversation_text}

Output:
{"add": [{"tag": "...", "text": "..."}], "update": [{"id": "...", "text": "..."}], "remove": ["id1"]}
```

Model: `claude-haiku` (lowest cost, sufficient for extraction)
Estimated cost: ~200 input tokens + ~50 output tokens per extraction ≈ $0.00005/call

### Authentication Considerations

The Claude Agent SDK supports these authentication methods (in priority order):

1. **Cloud provider credentials** (`CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` / `CLAUDE_CODE_USE_FOUNDRY`)
1. **`ANTHROPIC_AUTH_TOKEN`** — Bearer token, for LLM gateways/proxies
1. **`ANTHROPIC_API_KEY`** — Standard API key from Claude Console (pay-per-token)
1. **`claude setup-token`** — Generates `CLAUDE_CODE_OAUTH_TOKEN` for Pro/Max subscription users

**Important policy constraint:** Anthropic explicitly prohibits third-party developers from offering `claude.ai` login or subscription rate limits via the Agent SDK. The official documentation states: *“Please use the API key authentication methods described in this document instead.”*

**Recommended approach for Telegramable:**

- **Primary: `ANTHROPIC_API_KEY`** — cleanest, fully compliant, works in any environment including Docker containers. Pay-per-token billing via Claude Console.
- **Alternative: Cloud providers** (Bedrock/Vertex/Foundry) — for enterprise users who want to route through their own cloud accounts.
- **For personal use: `CLAUDE_CODE_OAUTH_TOKEN`** — users who have a Max subscription can generate a long-lived token via `claude setup-token` and set it as env var. This works but carries ToS risk for third-party distribution. Telegramable should document this option but not implement OAuth flows or encourage it as the default.

The memory extraction calls (Haiku) should use the same authentication as the main agent. No separate credentials needed.

Config:

```env
# Primary (recommended)
ANTHROPIC_API_KEY=sk-ant-api03-...

# Alternative: OAuth token from claude setup-token (personal use)
# CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...

# Alternative: Cloud provider
# CLAUDE_CODE_USE_BEDROCK=1
# AWS_REGION=us-east-1
# AWS_ACCESS_KEY_ID=...
# AWS_SECRET_ACCESS_KEY=...
```

## Components

### `MemoryStore` (`/src/memory/store.ts`)

In-memory representation of the current memory state. Simple Map + array operations.

```ts
interface MemoryFact {
  id: string;           // "f001", auto-incremented
  tag: MemoryTag;
  text: string;
  at: string;           // ISO date, date only
}

type MemoryTag = "project" | "personal" | "preference" | "decision" | "context";

interface MemorySnapshot {
  v: number;
  updated: string;      // ISO datetime
  facts: MemoryFact[];
}

class MemoryStore {
  load(snapshot: MemorySnapshot): void;
  snapshot(): MemorySnapshot;
  all(): MemoryFact[];
  byTag(tag: MemoryTag): MemoryFact[];
  add(tag: MemoryTag, text: string): MemoryFact;
  update(id: string, text: string): boolean;
  remove(id: string): boolean;
  search(query: string): MemoryFact[];  // substring match
  toJSON(): string;                      // serialized for Telegram message
}
```

### `MemorySync` (`/src/memory/sync.ts`)

Handles reading from and writing to the Telegram Memory chat.

```ts
class MemorySync {
  constructor(
    private bot: Bot,
    private config: MemoryConfig,
    private logger: Logger
  ) {}

  async load(): Promise<MemorySnapshot | null>;
  async save(snapshot: MemorySnapshot): Promise<void>;
  async sendChangelog(changes: MemoryChanges): Promise<void>;
  private pinnedMessageId?: number;
}
```

### `MemoryExtractor` (`/src/memory/extractor.ts`)

Calls Haiku to analyze conversations and extract memory updates.

```ts
interface MemoryChanges {
  add: { tag: MemoryTag; text: string }[];
  update: { id: string; text: string }[];
  remove: string[];
}

class MemoryExtractor {
  constructor(private apiKey: string) {}
  
  async extract(
    conversation: string,
    currentFacts: MemoryFact[]
  ): Promise<MemoryChanges>;
}
```

### Integration Points

**`SdkClaudeSession`** — inject memory into `systemPrompt` option:

```ts
// In sdkClaudeSession.ts executeQuery():
const memoryPrompt = memoryStore
  ? buildMemoryPrompt(memoryStore.all())
  : "";

const sdkQuery = query({
  prompt: userText,
  options: {
    systemPrompt: (this.options.systemPrompt || "") + memoryPrompt,
    // ... rest unchanged
  }
});
```

**`SessionRuntime`** — trigger extraction after execution completes:

```ts
// In sessionRuntime.ts execute():
// ... existing execution logic ...

// After successful execution, extract memories (non-blocking)
if (this.memoryExtractor && this.memoryStore) {
  void this.extractAndSync(message.text, response).catch(err =>
    this.logger.warn("Memory extraction failed", { reason: err.message })
  );
}
```

**`ChannelHub`** — handle `/memory` commands:

```ts
// Extend parseBuiltinCommand() to recognize /memory subcommands
```

**`startDaemon()`** — initialize memory on boot:

```ts
// In index.ts startDaemon():
const memoryConfig = loadMemoryConfig();
let memoryStore: MemoryStore | undefined;

if (memoryConfig?.enabled) {
  const sync = new MemorySync(bot, memoryConfig, logger);
  const snapshot = await sync.load();
  memoryStore = new MemoryStore();
  if (snapshot) memoryStore.load(snapshot);
  logger.info("Memory loaded.", { facts: memoryStore.all().length });
}
```

## Plan

- [ ] Create `MemoryStore` with in-memory fact CRUD + JSON serialization
- [ ] Create `MemorySync` — read/write pinned message in Telegram Memory chat
- [ ] Create `MemoryExtractor` — Haiku-based conversation analysis
- [ ] Integrate `MemoryStore` into `SdkClaudeSession` system prompt injection
- [ ] Integrate `MemoryExtractor` into `SessionRuntime` post-execution hook
- [ ] Add `/memory` command family to `ChannelHub`
- [ ] Add `MemoryConfig` to config loading (env vars)
- [ ] Initialize memory in `startDaemon()` lifecycle
- [ ] Handle Telegram message size overflow (reply chain for >4096 chars)
- [ ] Write tests: MemoryStore CRUD, MemorySync pinned message round-trip, extraction prompt parsing

## Test

- [ ] Cold start with existing pinned memory → facts loaded correctly
- [ ] Cold start with no pinned message → empty store initialized, message pinned
- [ ] Cold start with corrupt pinned message → empty store, warning logged, no crash
- [ ] User sends message → agent response includes memory context (visible in system prompt)
- [ ] Conversation about a new project → extraction adds a fact → pinned message updated
- [ ] Conversation contradicts existing fact → extraction updates the fact
- [ ] `/memory` → lists all facts grouped by tag
- [ ] `/memory edit f001 new text` → fact updated, pinned message synced
- [ ] `/memory delete f002` → fact removed, pinned message synced
- [ ] Container destroyed and recreated → memory restored from Telegram pinned message
- [ ] Memory JSON exceeds 4096 chars → overflow handling works (phase 2)
- [ ] Memory extraction failure → logged, does not block user interaction
- [ ] Concurrent messages → extraction serialized, no race conditions on pinned message

## Notes

- Memory extraction is **async and non-blocking**. The user should never wait for extraction to complete before sending the next message. If extraction fails, it’s logged but the conversation continues unaffected.
- The `MemoryExtractor` uses the **same API credentials** as the main agent. No separate auth configuration needed. For the extraction model, use Haiku to minimize cost.
- **Privacy**: all memory is visible to the user via the Memory Topic/Channel. No hidden state. The user can delete any fact at any time. This is a deliberate design choice — contrast with Claude.ai and OpenAI where the extraction process is opaque.
- **Phase 2 considerations** (not in scope for this spec):
  - Tag-based filtering when memory exceeds system prompt budget
  - SQLite FTS5 over Telegram message history for deep recall
  - Automatic memory compaction (merge similar facts, remove stale ones)
  - Multi-user memory isolation (separate memory per Telegram user)