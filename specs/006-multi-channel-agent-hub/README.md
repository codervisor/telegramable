---
status: complete
created: 2026-02-24
priority: high
tags:
- architecture
- hub
- multi-channel
- agent-runtime
depends_on:
- 001-bootstrap-telegramable
- 005-cli-daemon-service-mode
created_at: 2026-02-24T04:37:33.701617Z
updated_at: 2026-02-24T05:41:34.557762Z
completed_at: 2026-02-24T05:41:34.557762Z
transitions:
- status: in-progress
  at: 2026-02-24T05:41:10.645360Z
- status: complete
  at: 2026-02-24T05:41:34.557762Z
---

# Multi-Channel Agent Hub

> **Status**: planned · **Priority**: high · **Created**: 2026-02-24
> **North Star**: telegramable is the central hub — IM channels flow in, agent runtimes execute, responses flow back out to the originating channel.

## Overview

Today telegramable wires a single `IMAdapter` to a single `Runtime`. This covers the bootstrapped use case, but the product vision is broader: telegramable should act as an **event-hub** that aggregates inbound messages from multiple IM channels simultaneously and dispatches them to the most appropriate local agent runtime (Claude, Copilot, Codex, Gemini, opencode, etc.).

**Problems with the current design:**
- `Gateway` is 1:1 — one adapter, one runtime, hardwired at startup
- `IMMessage` has no channel identity — responses can't be routed back across adapters
- `ExecutionEvent` only tracks `chatId`, not which channel (adapter) originated the message
- No concept of multiple runtimes or runtime selection

**Goals:**
- Run any number of IM adapters concurrently (Telegram, Slack, Discord, WhatsApp, …)
- Maintain a registry of local agent runtimes
- Route each inbound message to a selected runtime via a pluggable routing strategy
- Route execution events (stdout, stderr, complete, error) back to the exact channel + chat that originated the request

## Design

The hub replaces the 1:1 `Gateway` with a `ChannelHub` that fans in from multiple `IMAdapter` instances and fans out to an `AgentRegistry` via a `Router`. `channelId` threads through every message and event so responses always return to the originating channel.

### Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                         ChannelHub                               │
│                                                                  │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐           │
│  │  Telegram   │   │    Slack    │   │   Discord   │  ...       │
│  │  Adapter    │   │   Adapter   │   │   Adapter   │           │
│  └──────┬──────┘   └──────┬──────┘   └──────┬──────┘           │
│         │                 │                 │                   │
│         └─────────────────┼─────────────────┘                  │
│                           │ IMMessage (+ channelId)              │
│                    ┌──────▼──────┐                              │
│                    │   Router    │ ← routing strategy             │
│                    └──────┬──────┘                              │
│                           │                                     │
│         ┌─────────────────┼─────────────────┐                  │
│         │                 │                 │                   │
│  ┌──────▼──────┐   ┌──────▼──────┐   ┌──────▼──────┐          │
│  │    Claude   │   │   Gemini    │   │   Codex     │  ...      │
│  │   Runtime   │   │   Runtime   │   │   Runtime   │          │
│  └──────┬──────┘   └──────┬──────┘   └──────┬──────┘          │
│         └─────────────────┼─────────────────┘                  │
│                           │ ExecutionEvent (+ channelId)         │
│                    ┌──────▼──────┐                              │
│                    │  EventBus   │                              │
│                    └──────┬──────┘                              │
│                           │                                     │
│         ┌─────────────────┼─────────────────┐                  │
│         │                 │                 │                   │
│  ┌──────▼──────┐   ┌──────▼──────┐   ┌──────▼──────┐          │
│  │  Telegram   │   │    Slack    │   │   Discord   │           │
│  │  Adapter   │   │   Adapter   │   │   Adapter   │           │
│  └─────────────┘   └─────────────┘   └─────────────┘          │
└──────────────────────────────────────────────────────────────────┘
```

### Data Model Changes

#### `IMMessage` — add `channelId`

```ts
export interface IMMessage {
  channelId: string;   // NEW: identifies which IMAdapter this came from
  chatId: string;
  userId?: string;
  text: string;
  raw?: unknown;
}
```

#### `ExecutionEvent` — add `channelId`

```ts
export interface ExecutionEvent {
  executionId: string;
  channelId: string;   // NEW: mirrors IMMessage.channelId for routing
  chatId: string;
  type: ExecutionEventType;
  timestamp: number;
  payload?: { ... };
}
```

#### `IMAdapter` — add `id`

```ts
export interface IMAdapter {
  id: string;          // NEW: unique instance identifier, e.g. "telegram-personal", "slack-work"
  start: (onMessage: (message: IMMessage) => void) => Promise<void>;
  sendMessage: (chatId: string, text: string) => Promise<void>;
  stop: () => Promise<void>;
}
```

`id` is set from `ChannelConfig.id` (see config schema). It must be unique across all configured channels — the `ChannelHub` enforces this at startup and throws if two entries share the same `id`.

### New Components

#### `ChannelHub` (`/src/hub/hub.ts`)

Replaces the current `Gateway`. Owns a collection of `IMAdapter` instances keyed by `id`. On startup, all adapters are started concurrently. Inbound messages are enriched with `channelId` from the adapter, then forwarded to the `Router`. Execution events are dispatched to the adapter with the matching `channelId`.

```ts
export class ChannelHub {
  constructor(
    private adapters: Map<string, IMAdapter>,
    private router: Router,
    private eventBus: EventBus,
    private logger: Logger
  ) {}

  async start(): Promise<void>;
  async stop(): Promise<void>;
  private handleMessage(message: IMMessage): Promise<void>;
  private subscribeEvents(): void;
}
```

#### `AgentRegistry` (`/src/hub/agentRegistry.ts`)

Holds named `Runtime` instances. Provides lookup by name.

```ts
export class AgentRegistry {
  register(name: string, runtime: Runtime): void;
  get(name: string): Runtime | undefined;
  list(): string[];
  default(): Runtime;
}
```

#### `Router` (`/src/hub/router.ts`)

Selects which `Runtime` handles a given `IMMessage`. Pluggable strategy interface with two built-in strategies:

1. **Prefix strategy** — `@claude do X`, `@gemini explain Y` routes to the named runtime; strips the prefix before forwarding
2. **Channel-default strategy** — each channel is assigned a default runtime in config; falls back to the global default

```ts
export interface Router {
  select(message: IMMessage): { runtime: Runtime; message: IMMessage };
}
```

### Config Schema Changes

```ts
export interface ChannelConfig {
  type: "telegram" | "slack" | "discord";   // adapter type (determines which class to instantiate)
  id: string;                                // unique instance name — REQUIRED, no default
  defaultAgent?: string;                     // runtime name for this channel
  // adapter-specific options (token, etc.)
  [key: string]: unknown;
}

export interface AgentConfig {
  name: string;                              // e.g. "claude", "gemini", "codex"
  command: string;                           // CLI command to spawn
  args?: string[];
  env?: Record<string, string>;
}

export interface Config {
  channels: ChannelConfig[];                 // replaces single `telegram` block
  agents: AgentConfig[];                     // replaces single `runtime` block
  defaultAgent?: string;                     // fallback if no match
}
```

#### Why `id` is required (not optional, not defaulting to `type`)

A single `type` (e.g. `telegram`) can appear multiple times — personal bot, work bot, test bot. Defaulting `id` to `type` silently produces duplicate keys, which would cause the hub to overwrite one adapter with another or route events to the wrong bot. Making `id` required and unique-enforced surfaces the misconfiguration immediately.

Example config with two Telegram bots:

```yaml
channels:
  - type: telegram
    id: telegram-personal
    token: "${TELEGRAM_TOKEN_PERSONAL}"
    defaultAgent: claude
  - type: telegram
    id: telegram-work
    token: "${TELEGRAM_TOKEN_WORK}"
    defaultAgent: codex
  - type: slack
    id: slack-work
    appToken: "${SLACK_APP_TOKEN}"
    defaultAgent: gemini
```

The adapter factory reads `config.id` and passes it directly to the `IMAdapter` constructor — no inference, no defaults.

### Routing Strategy Decision

The default routing order is:

1. **Prefix match** — if message starts with `@<agentName>`, use that agent (strip prefix)
2. **Channel default** — use the `defaultAgent` for the originating channel
3. **Global default** — use `config.defaultAgent` or the first registered agent

This allows per-channel agent assignment and per-message overrides without changing config.

## Plan

- [x] Update `IMMessage` type: add `channelId` field
- [x] Update `ExecutionEvent` type: add `channelId` field
- [x] Update `IMAdapter` interface: add `id` field
- [x] Update `TelegramAdapter`: accept `id` from constructor (from `ChannelConfig.id`), populate `channelId` in messages
- [x] Create `AgentRegistry` (`/src/hub/agentRegistry.ts`)
- [x] Create `Router` interface + default implementation (`/src/hub/router.ts`)
- [x] Create `ChannelHub` (`/src/hub/hub.ts`): multi-adapter lifecycle + event routing
- [x] Update `Config` schema: `channels[]` (with required `id`) and `agents[]` replacing single-adapter/runtime fields
- [x] Add startup validation: `ChannelHub` throws if any two `ChannelConfig` entries share the same `id`
- [x] Update `createRuntime` factory: read `agents[]` from config and populate `AgentRegistry`
- [x] Update `index.ts` / `startDaemon()`: wire `ChannelHub` instead of `Gateway`
- [x] Update CLI runtime adapter to accept `AgentConfig` (command + args + env)
- [x] Update tests and mocks: add `channelId` to fixtures

## Test

- [x] Single channel (Telegram) + single agent (existing behavior) works unchanged
- [x] Two adapters started concurrently; messages from each are delivered independently
- [x] Two Telegram bots (`telegram-personal`, `telegram-work`) run concurrently; events route back to the correct bot
- [x] `@claude` prefix routes to Claude runtime; `@gemini` routes to Gemini runtime
- [x] Channel-default agent assignment: `slack-work` defaults to `codex`, `telegram-personal` defaults to `claude`
- [x] Execution event `channelId` matches the originating adapter — response sent to correct channel
- [x] Unknown `@agent` prefix falls back to channel default / global default
- [x] `ChannelHub` throws on startup if two channel configs share the same `id`
- [x] `AgentRegistry.list()` returns all registered agent names
- [x] `ChannelHub.stop()` gracefully stops all adapters

## Notes

- The existing `Gateway` class should be preserved or aliased during migration to avoid breaking the daemon/service layer in spec 005.
- Future: routing strategy could be extended to a config-driven rule engine (regex on message text, user allowlist, round-robin load balancing).
- Multiple instances of the same adapter type are explicitly supported via the required `id` field — no special case or suffix magic needed.
- Agent CLI runtimes (Claude Code, Gemini CLI, opencode, etc.) are still spawned as subprocesses — the `CliRuntime` pattern from spec 001 is preserved; only the registry and dispatch layer is new.