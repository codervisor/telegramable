---
status: planned
created: 2026-04-06
priority: high
tags:
- memory
- mem0
- architecture
depends_on:
- 019-persistent-memory
created_at: 2026-04-06T08:39:26.812649067Z
updated_at: 2026-04-06T08:47:59.214113728Z
transitions:
- status: planned
  at: 2026-04-06T08:47:59.214113728Z
---
# Memory Refinement — Knowledge Graph via External Provider

## Overview

The current memory system (spec 019) stores flat facts in a Telegram pinned message. This works but hits a ~50-fact ceiling and offers only substring search. This spec adds Mem0 as an alternative storage backend — handling persistence, deduplication, and semantic retrieval — while keeping the existing Telegram-native provider as a fallback.

Refinement, knowledge graph, and dream-style consolidation are out of scope — those will be addressed in a future spec once the storage layer is proven.

## Design

### MemoryProvider Interface

Abstract the memory backend so Telegram-native (current) and Mem0 are swappable via config:

```ts
interface MemoryProvider {
  ingest(messages: ConversationMessage[], userId: string): Promise<void>;
  retrieve(query: string, userId: string, limit?: number): Promise<MemoryFact[]>;
  list(userId: string): Promise<MemoryFact[]>;
  delete(memoryId: string): Promise<boolean>;
}
```

Two implementations:
- `TelegramMemoryProvider` — wraps current spec-019 behavior (Haiku extraction + pinned message)
- `Mem0MemoryProvider` — delegates to Mem0 API

### Mem0 Integration

```ts
interface Mem0Config {
  apiKey: string;          // MEM0_API_KEY
  baseUrl?: string;        // For self-hosted; defaults to https://api.mem0.ai
}
```

Core operations:
- **After conversation**: `mem0.add(messages, { user_id })` — Mem0 extracts and deduplicates automatically (`infer=True`)
- **Before conversation**: `mem0.search(query, { user_id, limit: 20 })` — semantic retrieval for system prompt
- **`/memory` command**: `mem0.getAll({ user_id })` — list all memories

### ID Mapping

Mem0 generates its own UUIDs. For the `/memory` UI (delete, display), use Mem0's native IDs directly. No need to maintain a parallel ID scheme — the `f001` format was specific to the Telegram-native provider.

### Config

```env
MEMORY_PROVIDER=mem0          # "telegram" (default) or "mem0"
MEM0_API_KEY=m0-...           # Required when provider=mem0
MEM0_BASE_URL=                # Optional, for self-hosted
```

Provider selection in `startDaemon()`:
- `MEMORY_PROVIDER=telegram` → existing behavior, no changes
- `MEMORY_PROVIDER=mem0` → Mem0MemoryProvider, Telegram channel becomes optional audit log

### Architecture

```
SessionRuntime
  │
  ├─ pre-query:  provider.retrieve(context) → system prompt
  └─ post-query: provider.ingest(messages)  → Mem0 handles extraction + dedup
```

No Haiku extraction needed when using Mem0 — Mem0's built-in pipeline handles it.

## Plan

- [ ] Define `MemoryProvider` interface
- [ ] Refactor existing memory code into `TelegramMemoryProvider`
- [ ] Build `Mem0MemoryProvider` using Mem0 REST API
- [ ] Add config support (`MEMORY_PROVIDER`, `MEM0_API_KEY`, `MEM0_BASE_URL`)
- [ ] Wire provider selection into `startDaemon()`
- [ ] Update `SessionRuntime` to use provider interface for inject + extract
- [ ] Update `/memory` command to work with either provider
- [ ] Test with real Mem0 account

## Test

- [ ] `Mem0MemoryProvider.ingest()` sends correct payload to Mem0 API
- [ ] `Mem0MemoryProvider.retrieve()` returns relevant facts
- [ ] `TelegramMemoryProvider` continues to work unchanged (backward compat)
- [ ] Provider switch via config swaps behavior without code changes
- [ ] `/memory` command works with both providers
- [ ] Mem0 API failure degrades gracefully (agent still works)

## Notes

- **Mem0 dedup is inline only** — happens during `add()` with `infer=True`. No batch refinement API exists. A periodic "dream" consolidation pass is a future concern.
- **Graph mode**: Mem0 supports `enable_graph=True` for entity-relationship extraction. Not enabling for now but available when we tackle refinement.
- **Privacy**: Mem0 SaaS stores data on their infra. Self-hosted mode available for sensitive deployments.
- **Cost**: Free tier supports 1,000 memories — sufficient for personal use.
- **Future**: Refinement/knowledge graph/dream consolidation will be a separate spec building on top of this storage layer.

- **Next priority: Memory refinement/dream cycle.** Current system has no compaction — facts accumulate without consolidation. Need a periodic `refine()` pass (like Claude Code's AutoDream) that: (1) reads all facts, (2) merges related ones, (3) removes stale/contradicted, (4) rebalances. Triggers: time-based (24h), threshold-based (fact count), or on-demand (`/memory refine`). This is the critical missing piece before scaling beyond ~50 facts.
- **Semantic retrieval for large fact sets.** When fact count exceeds system prompt budget, switch from `all()` to `semanticSearch(query)` for prompt injection. `Mem0MemoryProvider.semanticSearch()` already implemented but not wired into the prompt builder yet.
