---
status: planned
created: 2026-03-20
priority: high
tags:
- strategy
- channels
- breadth
created_at: 2026-03-20T06:48:52.561176949Z
updated_at: 2026-03-20T06:48:52.561176949Z
---

# Channel Expansion - Universal IM/Email/SMS Adapters

## Overview

Expand Cueless from Telegram-only to a universal communication bridge. Every mainstream channel humans use should be able to reach AI agents through Cueless.

The IMAdapter interface and ChannelHub architecture already support multiple adapters — this is implementation work, not architectural change.

## Design

### Priority Channels (ordered by impact)

1. **Slack** (Socket Mode) — enterprise teams, highest business value
2. **Discord** (discord.js / WebSocket) — developer communities, hobbyist surface
3. **Email** (IMAP polling + SMTP send, or webhook-based via SendGrid/Resend) — async long-form tasks
4. **SMS** (Twilio API) — zero-install reach, on-the-go triggers
5. **WhatsApp** (Meta Cloud API) — dominant global messenger
6. **Feishu/Lark** (Open API) — dominant in China enterprise market, large developer base

### Adapter Contract

Each adapter implements the existing `IMAdapter` interface:
- `start()` — connect to platform
- `sendMessage(chatId, text)` — deliver response
- `stop()` — graceful disconnect
- `onMessage` callback — fan into ChannelHub

### Channel-Specific Considerations

- **Slack**: Socket Mode avoids public URLs; thread-aware replies; rich blocks for output formatting
- **Discord**: Guild/channel model maps to chatId; slash commands for discoverability
- **Email**: Subject line as command prefix; attachments as context; reply-chain as session
- **SMS**: Character limits require aggressive chunking; MMS for longer output
- **WhatsApp**: Template messages for agent-initiated; session windows (24h rule)
- **Feishu/Lark**: Bot framework with card messages; supports rich interactive cards; i18n required (zh-CN)

## Plan

- [ ] Slack adapter (Socket Mode)
- [ ] Discord adapter (discord.js)
- [ ] Email adapter (IMAP/SMTP or webhook)
- [ ] SMS adapter (Twilio)
- [ ] WhatsApp adapter (Cloud API)
- [ ] Feishu/Lark adapter (Open API)
- [ ] Per-adapter config schema and validation
- [ ] Adapter-specific message formatting (markdown → platform-native)

## Test

- [ ] Each adapter connects and receives messages in dev/sandbox environment
- [ ] Round-trip: send message via channel → receive agent response in same channel
- [ ] Multi-adapter: run 3+ adapters simultaneously without interference
- [ ] Chunking/formatting works correctly per platform constraints

## Notes

- Start with Slack — most enterprise demand, well-documented API
- Feishu/Lark is strategic for China market reach — consider as parallel track
- Email is architecturally different (async, long-form) — may need adapter extensions for attachments
- Each adapter should be a separate file following telegramAdapter.ts pattern
