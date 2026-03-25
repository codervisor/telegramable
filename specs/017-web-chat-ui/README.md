---
status: planned
created: 2026-03-25
priority: high
tags:
- web-ui
- chat
- mobile
- channel
- frontend
depends_on:
- 016-telegram-ai-agent-proxy
created_at: 2026-03-25T19:11:32.514430186Z
updated_at: 2026-03-25T19:11:32.514430186Z
---

# Web Chat UI — Telegram-Style AI Agent Interface

> **Status**: planned · **Priority**: high · **Created**: 2026-03-25
> **North Star**: Open the web app on your phone, chat with Claude Code running on your machine — same streaming, permissions, and file handling as Telegram.

## Overview

Users currently need Telegram installed to interact with AI agents. This spec adds a web-based chat UI that mirrors the Telegram experience — a responsive, mobile-first chat interface served by the Next.js app (`apps/web`). It connects to the same hub/router as Telegram, acting as a new "web" channel adapter.

**Why now?**
- Lowers the barrier to entry — no Telegram account needed
- Mobile-friendly browser UI works on any device
- Enables demo/onboarding without external app setup
- Reuses the existing hub architecture (spec 006, 016)

**North Star**: Open the web app on your phone, chat with Claude Code running on your machine — same streaming, permissions, and file handling as Telegram.

## Design

### Architecture

```
Browser (mobile/desktop)
  │
  WebSocket (Socket.IO or native WS)
  │
apps/web — Next.js
  ├─ /chat           — Chat UI (React, Tailwind)
  ├─ /api/ws         — WebSocket endpoint (or standalone WS server)
  │
  ▼
WebAdapter (implements IMAdapter interface)
  │
  ▼
Hub / Router — same as Telegram path
  │
  ▼
Agent Sessions (Claude SDK, Gemini, Copilot, etc.)
```

### Key Components

**1. WebAdapter** (`packages/core/src/gateway/webAdapter.ts`)
- Implements the `IMAdapter` interface (same as `telegramAdapter`)
- Manages WebSocket connections (one per browser session)
- Translates hub events → WebSocket messages and vice versa
- Supports: text messages, streaming tokens, inline actions (approve/deny), file upload/download

**2. Chat UI** (`apps/web/src/app/chat/`)
- Telegram-style message bubbles (user right, agent left)
- Real-time token streaming (append chunks to last message)
- Inline action buttons for tool approval (mirrors Telegram inline keyboards)
- File attachment send/receive
- Session list sidebar (mirrors Telegram forum topics)
- Mobile-first responsive layout — usable as phone home screen PWA

**3. WebSocket Protocol**
```typescript
// Client → Server
{ type: "message", text: string, sessionId?: string }
{ type: "action", actionId: string, value: string }  // approve/deny
{ type: "upload", fileName: string, data: ArrayBuffer }

// Server → Client
{ type: "message", text: string, sessionId: string }
{ type: "stream", chunk: string, sessionId: string }
{ type: "stream_end", sessionId: string }
{ type: "action_request", actionId: string, prompt: string, options: string[] }
{ type: "file", fileName: string, url: string }
{ type: "session_created", sessionId: string, title: string }
```

**4. Auth** — Simple token-based (shared secret in env var) since this is a personal/self-hosted tool. Optional for local network.

### Technology

| Layer | Choice | Status |
|-------|--------|--------|
| Framework | Next.js 16 (App Router) | Already set up |
| Components | shadcn/ui (base-nova, neutral) | Initialized — button, input, scroll-area, avatar, separator, tooltip installed |
| Styling | Tailwind CSS v4 + CSS variables | Already set up, dark mode default |
| Transport | WebSocket (ws or Socket.IO) | To implement |
| State | React useState + useReducer | Chat state is local, no need for heavy state management |
| PWA | next-pwa or manual manifest | Add-to-home-screen on mobile |

## Plan

### Phase 0: Foundation (complete)
- [x] Initialize shadcn/ui with base-nova style, neutral palette, dark mode
- [x] Install chat-relevant components (button, input, scroll-area, avatar, separator, tooltip)
- [x] Set up cn() utility, CSS variables, system font stack
- [x] Update layout with dark mode default and proper metadata

### Phase 1: WebSocket Infrastructure
- [ ] Add WebSocket server to apps/web (Next.js custom server or standalone)
- [ ] Define message protocol types in `packages/core`
- [ ] Implement `WebAdapter` implementing `IMAdapter` interface
- [ ] Register web adapter in hub alongside Telegram adapter

### Phase 2: Chat UI Shell
- [ ] Create `/chat` route with mobile-first layout
- [ ] Build message list component (bubbles, timestamps, streaming indicator)
- [ ] Build message input bar (text input, send button, attachment button)
- [ ] Connect to WebSocket, send/receive messages
- [ ] Display streaming tokens in real-time (append to last bubble)

### Phase 3: Agent Interactions
- [ ] Render inline action buttons (approve/deny tool calls)
- [ ] Handle action responses back through WebSocket
- [ ] Show agent "typing" indicator during processing
- [ ] Display session title and status

### Phase 4: Sessions & Navigation
- [ ] Session list sidebar (collapsible on mobile)
- [ ] Create new session, switch between sessions
- [ ] Session history persisted in localStorage or server-side

### Phase 5: Files & Polish
- [ ] File upload from browser → agent
- [ ] File download from agent → browser
- [ ] Code block rendering with syntax highlighting
- [ ] PWA manifest for add-to-home-screen

## Test

- [ ] Send message in web UI → agent receives it, responds with streaming tokens
- [ ] Tool approval: agent requests permission → action buttons appear → user taps approve → tool executes
- [ ] Multiple sessions visible in sidebar, switching preserves history
- [ ] Mobile viewport: chat is full-screen, usable with thumb
- [ ] File upload/download works end-to-end
- [ ] Web and Telegram channels work simultaneously on the same hub
- [ ] WebSocket reconnects automatically on disconnect

## Notes

- **Not a Telegram API emulator** — we don't replicate Telegram's API. We implement the same `IMAdapter` interface, so the hub treats web and Telegram identically.
- **Scope**: This spec covers the chat UI only, not the admin/config UI (spec 002). They coexist in `apps/web` under different routes (`/chat` vs `/admin`).
- **Spec 003 overlap**: shadcn/ui is now initialized in apps/web (base-nova style, neutral palette, dark mode). Core components installed. Spec 003's remaining scope (full design system, Storybook, etc.) is deferred — we have what we need to build the chat UI.
- **PWA**: Adding a web app manifest + service worker makes this installable on mobile home screens, giving a native-app feel without app store distribution.
