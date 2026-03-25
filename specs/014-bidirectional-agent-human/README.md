---
status: planned
created: 2026-03-20
priority: high
tags:
- strategy
- inbound-api
- notifications
created_at: 2026-03-20T06:48:52.584833610Z
updated_at: 2026-03-20T06:48:52.584833610Z
---

# Bidirectional Agent-to-Human Communication

## Overview

Currently Telegramable is human→agent only. This spec adds agent→human flow: external systems and agents can push messages into Telegramable for delivery to specific IM channels/chats.

This is a quick win — the ChannelHub already has `sendMessage` on every adapter. We just need an inbound API to trigger it.

## Design

### Inbound API

A lightweight HTTP server (or webhook endpoint) that accepts messages for delivery:

```
POST /api/notify
{
  "channelId": "tg-personal",
  "chatId": "12345",
  "text": "Build failed. Root cause: missing env var DB_URL",
  "metadata": { "source": "ci", "priority": "high" }
}
```

### Use Cases

1. **Agent completion notifications** — long-running task finishes, notifies user on Slack/Telegram
2. **CI/CD integration** — pipeline fails → agent analyzes → posts root cause to your IM
3. **Human-in-the-loop** — agent needs approval → asks via IM → waits for reply
4. **Scheduled reports** — cron triggers agent → results delivered to email/IM

### Authentication

- API key-based auth for the inbound endpoint
- Per-channel delivery permissions (which API keys can send to which channels)

### Agent-Initiated Sessions

Extend the existing session model so agents can start conversations:
- `ChannelHub.notify(channelId, chatId, text)` — send without a prior user message
- Optional: reply-tracking so the agent can receive the human's response

## Plan

- [ ] HTTP inbound API server (lightweight, alongside daemon)
- [ ] `POST /api/notify` endpoint with channel routing
- [ ] API key authentication and per-channel permissions
- [ ] `ChannelHub.notify()` method for programmatic sends
- [ ] Reply-tracking for human-in-the-loop flows
- [ ] CLI command: `telegramable notify <channel> <chat> <message>`

## Test

- [ ] POST to /api/notify delivers message to correct adapter and chat
- [ ] Invalid channelId returns 404; missing auth returns 401
- [ ] Human-in-the-loop: agent sends question, user replies, agent receives reply
- [ ] Notify works across all active adapters (Telegram, Slack, etc.)

## Notes

- Keep the HTTP server minimal — this is not a full REST API, just a notification ingress
- Consider WebSocket support later for real-time bidirectional streaming
- Human-in-the-loop reply-tracking is the most complex part — scope it carefully
