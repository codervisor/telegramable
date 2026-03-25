---
status: in-progress
created: 2026-03-25
priority: critical
tags:
- strategy
- architecture
- telegram
- claude-sdk
- proxy
depends_on:
- 012-im-session-interactivity
created_at: 2026-03-25T13:16:51.733886253Z
updated_at: 2026-03-25T15:34:50.750960527Z
transitions:
- status: in-progress
  at: 2026-03-25T15:34:50.750960527Z
---
# Telegram AI Agent Proxy — Repositioned Architecture

## Overview

Reposition telegramable from "generic IM control plane" to **Telegram-first AI agent proxy on your host machine**. Telegram is the primary UI; other channels are secondary.

**North Star**: Open Telegram, talk to Claude Code running on your machine. It streams responses, asks you questions, sends files back — all through Telegram's native UI.

### Context: Claude Code Channels (March 2026)

Anthropic shipped an official Telegram channel plugin for Claude Code (`/plugin install telegram@claude-plugins-official`). It validates our concept but has key limitations:
- Requires Claude Code running in a terminal (not headless/daemon)
- Requires claude.ai login (no API keys, no server deployment)
- Drops messages if machine sleeps or terminal closes
- Permission prompts freeze the session, require local terminal approval

**Our differentiation**: An always-on daemon that survives reboots, uses the Agent SDK programmatically, handles permissions via Telegram inline keyboards, and supports multiple concurrent sessions.

### Key Technology Updates

1. **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk` v0.2.83) — programmatic control with `canUseTool` callback for human-in-the-loop, async generator streaming input, structured events, session resume/fork
2. **Telegram Bot API 9.5** — `sendMessageDraft` for native token streaming, private chat forum topics for per-session threads, inline keyboards, expandable blockquotes, file handling
3. **grammY** — recommended replacement for `node-telegram-bot-api` (native TypeScript, always-current Bot API coverage, middleware architecture, 10x adoption)

## Design

### Architecture

```
┌─────────────────────────────────────────────────────┐
│  HOST MACHINE — telegramable daemon (always-on)      │
│                                                       │
│  grammY Bot ←→ Telegram Bot API (long-poll/webhook)   │
│    │                                                  │
│    ├─ Forum Topics: one topic per agent session       │
│    ├─ Inline Keyboards: approve/deny tool calls       │
│    ├─ sendMessageDraft: stream tokens in real-time    │
│    ├─ File I/O: upload/download via sendDocument      │
│    │                                                  │
│    ▼                                                  │
│  Session Router                                       │
│    ├─ @claude → Claude Agent SDK (streaming input)    │
│    │   └─ canUseTool → Telegram inline keyboard       │
│    │   └─ async generator ← Telegram messages         │
│    ├─ /shell <cmd> → sandboxed shell executor         │
│    └─ /status /logs /list → execution registry        │
└─────────────────────────────────────────────────────┘
```

### Core Changes

**1. Replace `node-telegram-bot-api` with grammY**
- Native TypeScript, Bot API 9.5+ support out of the box
- Middleware architecture for inline keyboards, callbacks, file handling
- `sendMessageDraft` support for streaming (Bot API 9.3+)

**2. Replace CLI subprocess spawning with Claude Agent SDK**
- Use `query()` with async generator for streaming input (multi-turn from Telegram)
- `canUseTool` callback intercepts permission requests → forwards as Telegram inline keyboard → waits for user tap → returns decision
- Structured events replace stdout parsing — no more ANSI stripping
- Session resume/fork for persistent conversations

**3. Telegram Forum Topics as Session Threads**
- Each agent session gets its own topic in the private chat
- Topics named with task context (e.g., "Claude: fix auth bug")
- Concurrent sessions are visually separated
- Close topic when session completes

**4. Rich Telegram UI**
- `sendMessageDraft` for token-by-token streaming (private chats)
- `InlineKeyboardMarkup` for approve/deny, multiple choice, pagination
- `ForceReply` when agent asks a specific question
- `expandable_blockquote` for long tool outputs
- `sendDocument` for file exchange (code patches, logs, screenshots)
- HTML parse mode (safer than MarkdownV2 for programmatic generation)

## Plan

- [x] Migrate Telegram adapter from `node-telegram-bot-api` to grammY
- [x] Add `@anthropic-ai/claude-agent-sdk` as core dependency
- [x] Implement `SdkClaudeSession` using Agent SDK `query()` with streaming input
- [x] Wire `canUseTool` → Telegram inline keyboard → callback query → SDK response
- [x] Implement forum topic lifecycle (create on session start, close on complete)
- [x] Implement `sendMessageDraft` streaming for real-time token output
- [x] Add file upload/download support (user→agent and agent→user)
- [x] Update daemon service to ensure always-on operation with SDK sessions

## Test

- [ ] User sends message in Telegram → Claude Agent SDK session starts, tokens stream via `sendMessageDraft`
- [ ] Claude requests tool permission → inline keyboard appears → user taps Approve → tool executes
- [ ] Claude asks clarifying question → `ForceReply` prompt appears → user replies → answer flows to SDK
- [ ] Two concurrent sessions run in separate forum topics without interference
- [ ] User uploads file → agent processes it → sends result back as document
- [ ] Daemon survives reboot, reconnects to Telegram, resumes sessions

## Notes

- **grammY migration** is low-risk — current adapter is ~60 lines. grammY has direct equivalents for all methods used.
- **Agent SDK vs CLI**: SDK gives us `canUseTool`, structured events, and async generator input. CLI `--resume` is batch-oriented and cannot intercept permission prompts. SDK is strictly superior for our use case.
- **Claude Code Channels coexistence**: Users can still use Channels for quick local sessions. Telegramable adds the always-on, headless, multi-session layer on top.
- **Security**: `canUseTool` callback is the permission boundary. Default to deny-all for destructive tools; user must approve via Telegram tap.