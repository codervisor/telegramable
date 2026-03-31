---
status: draft
created: 2026-03-31
priority: medium
tags:
- memory
- telegram
- ux
- inline-keyboard
parent: 019-persistent-memory
created_at: 2026-03-31T01:50:06.847818857Z
updated_at: 2026-03-31T01:50:06.847818857Z
---

# Memory Quick Actions & Cache Management

## Overview

Memory management currently requires typing slash commands (`/memory delete f001`, `/memory search ...`). This is unintuitive — users don't know command syntax, can't discover features, and have no quick way to manage cache or bulk-clear facts.

Meanwhile, the Telegram adapter already supports inline keyboards (used for permission approve/deny buttons). We should leverage this existing infrastructure to add quick-action buttons to memory responses, plus add cache management commands.

Two gaps addressed:
1. **No inline keyboard buttons** for memory — facts listed as plain text with no actionable UI
2. **No cache/channel management** — stale `memory-chat-ids.json` entries can't be cleared; no bulk reset; no way to verify which channel is active

## Design

### Callback Routing

`handleCallbackQuery()` currently only routes `perm:*` callbacks. Extend it to route `mem:*` callbacks too:

```
mem:delete:<factId>        → delete fact, edit message to confirm
mem:clear:confirm          → bulk-clear all facts
mem:clear:cancel           → cancel bulk clear
mem:page:<offset>          → paginate fact list
mem:cache:flush            → clear cached chat ID, re-resolve on next boot
```

### Inline Keyboards on Memory Responses

**`/memory` list** — each fact gets a 🗑 button; footer row with "Clear All | Export | 🔄 Channel Info":

```
🧠 Memory (3 facts)

[project] f001: Uses pnpm monorepo
[preference] f002: Prefers dark mode
[decision] f003: Chose PostgreSQL over MySQL

[🗑 f001] [🗑 f002] [🗑 f003]
[Clear All 🧹] [Export 📄] [Channel ℹ️]
```

**Delete confirmation** — tapping 🗑 immediately deletes and edits the message to remove that fact (no extra confirmation for single deletes).

**Clear All** — shows confirmation row: `[Yes, clear all ⚠️] [Cancel]`

**Channel Info** — shows resolved chat ID, cache status, and a "Flush Cache" button.

### New Commands

| Command | Description |
|---------|-------------|
| `/memory clear` | Bulk-clear all facts (with inline confirm/cancel) |
| `/memory channel` | Show resolved chat ID, cache source, flush button |

### Cache Management

`/memory channel` response:
```
📡 Memory Channel

Chat ID: -1001234567890
Source: cached (from @my_agent_memory)
Cache file: /data/memory-chat-ids.json

[🔄 Flush Cache]
```

Flushing deletes the cache entry for current `rawChatId` and shows instructions to restart. The bot does NOT hot-reload the channel — that would risk data loss. Flush + restart is the safe path.

### Hub Changes

In `hub.ts`:
- `handleCallbackQuery()` → add `else if (message.callbackData?.startsWith("mem:"))` branch
- `handleBuiltinCommand()` → memory list uses `sendMessageWithMarkup()` instead of `sendMessage()`
- New `handleMemoryCallback(adapter, message)` private method
- New `buildMemoryListMarkup(facts)` helper for keyboard layout
- Add `memory-clear` and `memory-channel` to `parseBuiltinCommand()`

### Pagination

If facts > 8, paginate with 8 per page. Footer shows `[◀ Prev] [Page 1/3] [Next ▶]` using `mem:page:<offset>` callbacks. Message is edited in-place on page change.

## Plan

- [ ] Extend `parseBuiltinCommand()` with `memory-clear` and `memory-channel` types
- [ ] Create `buildMemoryListMarkup(facts, page)` → returns `{ text, markup }` with inline keyboard
- [ ] Create `buildChannelInfoMarkup(config, cacheStore)` → returns channel info with flush button
- [ ] Refactor `/memory` handler to use `sendMessageWithMarkup()` when adapter supports it
- [ ] Add `handleMemoryCallback(adapter, message)` to route `mem:*` callbacks
- [ ] Extend `handleCallbackQuery()` to dispatch `mem:*` alongside `perm:*`
- [ ] Implement delete-via-button (edit message to remove fact, re-render list)
- [ ] Implement clear-all flow (confirm → bulk delete → edit message)
- [ ] Implement channel-info with flush-cache button
- [ ] Add pagination for large fact lists (>8 facts)
- [ ] Expose `FileSessionStore.delete()` to hub for cache flush (already exists on the class)

## Test

- [ ] `/memory` shows inline keyboard with delete buttons per fact
- [ ] Tapping 🗑 deletes fact and edits message to updated list
- [ ] `/memory clear` shows confirm/cancel buttons; confirm clears all facts
- [ ] Cancel on clear-all dismisses without deleting
- [ ] `/memory channel` shows resolved ID and cache source
- [ ] Flush Cache button deletes cache entry, shows restart instructions
- [ ] Pagination works: >8 facts shows page controls, page navigation edits message
- [ ] Adapters without `sendMessageWithMarkup` fall back to plain text (existing behavior)
- [ ] `mem:*` callbacks are acknowledged via `answerCallbackQuery()`

## Notes

- **No hot-reload of memory channel.** Flushing cache only takes effect on restart. This avoids data loss from switching channels mid-session while facts are in memory.
- **Single deletes skip confirmation** — the 🗑 button is already intentional. Bulk clear requires confirmation because it's destructive.
- Callback data is limited to 64 bytes by Telegram — `mem:delete:f001` fits comfortably.
- Pagination edits the same message rather than sending new ones, keeping the chat clean.
- The existing `FileSessionStore.delete(key)` method (line 27) already supports cache entry removal — no new code needed there.
