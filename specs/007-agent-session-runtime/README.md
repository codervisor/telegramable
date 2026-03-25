---
status: complete
created: 2026-02-24
priority: high
tags:
- agent-runtime
- session
- claude
- gemini
- codex
- copilot
depends_on:
- 006-multi-channel-agent-hub
created_at: 2026-02-24T06:08:11.719765Z
updated_at: 2026-02-24T07:04:23.109254Z
completed_at: 2026-02-24T07:04:23.109254Z
transitions:
- status: complete
  at: 2026-02-24T07:04:23.109254Z
---

# Agent Session Runtime

> **Status**: planned · **Priority**: high · **Created**: 2026-02-24
> **North Star**: Deliver stateful, multi-turn AI agent sessions over any IM channel — telegramable opens a persistent session per chat, executes requests through a local AI CLI, and returns a single clean reply.

## Overview

The current `CliRuntime` spawns a fresh, stateless process for every message. This umbrella spec tracks the full work to upgrade telegramable with proper agent session support:

- Persistent conversation state across messages
- Agent-specific invocation protocols (Claude Code, Gemini CLI, Copilot CLI)
- Response aggregation (one IM reply per agent response, no per-chunk spam)

## Child Specs

| Spec                                                                 | Scope                   | Notes                                                                                                                                       |
| -------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| [011-session-runtime-foundation](../011-session-runtime-foundation/) | Core infrastructure     | `AgentSession` / `SessionManager` interfaces, `InMemorySessionManager`, `SessionRuntime`, `AgentConfig` extension, `ChannelHub` aggregation |
| [008-claude-code-session](../008-claude-code-session/)               | Claude Code integration | Native session via `claude --resume <id>`                                                                                                   |
| [009-gemini-cli-session](../009-gemini-cli-session/)                 | Gemini CLI integration  | Native session via `gemini --chat-id <id>`                                                                                                  |
| [010-copilot-cli-session](../010-copilot-cli-session/)               | Copilot CLI integration | Transcript fallback via `copilot -p`                                                                                                        |

## Sequencing

```
006-multi-channel-agent-hub (complete)
        │
        ▼
011-session-runtime-foundation
        │
        ├──▶ 008-claude-code-session
        ├──▶ 009-gemini-cli-session
        └──▶ 010-copilot-cli-session
```

008, 009, and 010 can be implemented in parallel once 011 is complete.
