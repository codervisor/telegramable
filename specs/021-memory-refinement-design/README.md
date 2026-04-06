---
status: draft
created: 2026-04-06
priority: high
tags:
- memory
- knowledge-graph
- mem0
- refinement
- architecture
depends_on:
- 019-persistent-memory
created_at: 2026-04-06T08:39:26.812649067Z
updated_at: 2026-04-06T08:39:26.812649067Z
---

# Memory Refinement — Knowledge Graph via External Provider

## Overview

The current memory system (spec 019) stores flat facts in a Telegram pinned message, extracted per-conversation via Haiku. As facts accumulate, they become scattered, duplicated, and lack relationships. This spec explores replacing or augmenting the storage backend with an external memory provider (primarily Mem0) that automatically refines, deduplicates, and graphs facts.

### Problem

- **Scattered facts**: No relationships between related facts (e.g., "works on Synodic" and "Synodic uses Rust" are unconnected)
- **Duplicates & conflicts**: Similar facts accumulate without consolidation
- **Capacity ceiling**: Telegram pinned message caps at ~50 facts (4096 chars)
- **No semantic retrieval**: Current search is substring-only; can't find conceptually related facts
- **Stale facts**: No automatic aging or relevance scoring

### Goal

Replace or augment the memory storage layer so that:
1. Facts are automatically consolidated and deduplicated
2. Relationships between entities are captured (knowledge graph)
3. Retrieval is semantic, not just substring
4. Capacity is effectively unlimited
5. Telegram channel remains as a transparent audit log

## Design

### Option Analysis

#### A. Mem0 as Memory Backend (Recommended)

**What**: Managed/self-hosted memory service with automatic graph extraction.

**Integration model**:
```
Conversation → Mem0.add(messages) → Mem0 extracts, deduplicates, graphs
Query        → Mem0.search(query) → Relevant facts for system prompt
Audit        → Telegram channel gets changelog (read-only)
```

**Pros**:
- Drop-in replacement for MemoryExtractor + MemoryStore
- Automatic deduplication and relationship extraction
- Semantic search built-in
- Graph mode builds entity-relationship triples
- Free tier available; self-hostable (OSS)
- Simple REST API

**Cons**:
- External dependency (SaaS or self-hosted infra)
- Less transparent than Telegram-native storage
- Mem0's graph quality depends on their extraction model

#### B. Letta (MemGPT) as Backend

**What**: Open-source agent framework with tiered memory.

**Verdict**: Over-engineered for this use case. Letta wants to be the agent runtime, not a pluggable memory layer. Would require either adopting Letta as the runtime (replacing Claude SDK sessions) or extracting just its memory server, which is poorly supported standalone.

**Recommendation**: Skip.

#### C. Custom Graph on SQLite/Postgres

**What**: Build our own entity-relationship store with periodic LLM-driven refinement.

**Verdict**: Maximum control but significant build effort. Worth considering only if Mem0 proves inadequate.

### Recommended Architecture: Mem0

```
┌──────────────────────────────────────────────┐
│  Telegramable Daemon                          │
│                                               │
│  ┌─────────────┐    ┌──────────────────────┐ │
│  │ SessionRuntime│──→│ MemoryProvider        │ │
│  │ (post-query)  │   │ (interface)           │ │
│  └──────────────┘    └──────────┬───────────┘ │
│                                 │              │
│         ┌───────────────────────┤              │
│         ▼                       ▼              │
│  ┌─────────────┐    ┌──────────────────────┐ │
│  │ TelegramSync │    │ Mem0Adapter          │ │
│  │ (audit log)  │    │ (graph + retrieval)  │ │
│  └──────┬──────┘    └──────────┬───────────┘ │
│         │                       │              │
└─────────┼───────────────────────┼──────────────┘
          ▼                       ▼
   Telegram Channel         Mem0 API (SaaS)
   (changelog only)         or self-hosted
```

### MemoryProvider Interface

Abstract the memory backend so Telegram-native (spec 019) and Mem0 are interchangeable:

```ts
interface MemoryProvider {
  /** Ingest a conversation for fact extraction */
  ingest(messages: ConversationMessage[], userId: string): Promise<void>;

  /** Retrieve relevant facts for a query/context */
  retrieve(query: string, userId: string, limit?: number): Promise<MemoryFact[]>;

  /** Get all facts (for /memory command, audit) */
  list(userId: string): Promise<MemoryFact[]>;

  /** Delete a specific memory */
  delete(memoryId: string): Promise<boolean>;
}
```

Two implementations:
- `TelegramMemoryProvider` — current spec-019 behavior (Haiku extraction + pinned message)
- `Mem0MemoryProvider` — delegates to Mem0 API

### Mem0 Integration Details

```ts
// Config
interface Mem0Config {
  apiKey: string;          // MEM0_API_KEY
  orgId?: string;          // MEM0_ORG_ID (for teams)
  projectId?: string;      // MEM0_PROJECT_ID
  baseUrl?: string;        // For self-hosted: defaults to https://api.mem0.ai
  graphEnabled: boolean;   // Enable knowledge graph mode
}

// Ingest after each conversation
await mem0.add(messages, { user_id, metadata: { source: "telegram" } });

// Retrieve before each conversation
const memories = await mem0.search(query, { user_id, limit: 20 });

// Build system prompt from retrieved memories
const prompt = buildMemoryPrompt(memories);
```

### Telegram Channel Role Change

With Mem0 as the source of truth, Telegram's memory channel shifts from **primary store** to **audit log**:

- On ingest: post a changelog message showing what Mem0 extracted/changed
- On `/memory`: fetch from Mem0, display in Telegram with inline buttons
- On delete: delete from Mem0, post confirmation to channel
- Pinned message becomes a **summary view** (refreshed periodically) rather than the canonical store

### Deployment Options

| Mode | Mem0 | Storage | Cost |
|------|------|---------|------|
| **SaaS** | api.mem0.ai | Mem0 cloud | Free tier: 1K memories; paid after |
| **Self-hosted** | Docker container | Local Postgres + vector DB | Infra cost only |
| **Hybrid** | SaaS + Telegram | Mem0 for graph, Telegram for audit | Free tier + Telegram |

### Where This Lives

**Option 1: New package in Telegramable monorepo** (`packages/memory-provider`)
- Keeps everything together; shared types with `@telegramable/core`
- Provider interface + Mem0 adapter + Telegram adapter

**Option 2: Standalone package** (separate repo, e.g., `@telegramable/mem0-adapter`)
- If other projects might use the same memory abstraction
- Lighter dependency graph

**Recommendation**: Start as a module within `@telegramable/core` (alongside existing `memory/` directory), extract later if needed.

## Plan

- [ ] Design `MemoryProvider` interface and refactor existing memory code to implement it as `TelegramMemoryProvider`
- [ ] Build `Mem0MemoryProvider` implementing the same interface
- [ ] Add config support: `MEMORY_PROVIDER=telegram|mem0`, `MEM0_API_KEY`, etc.
- [ ] Wire provider selection into `startDaemon()` initialization
- [ ] Update `SessionRuntime` to use `MemoryProvider.retrieve()` for system prompt injection
- [ ] Update `SessionRuntime` to use `MemoryProvider.ingest()` for post-conversation extraction
- [ ] Update `/memory` command to work with either provider
- [ ] Shift Telegram channel to audit-log mode when Mem0 is active
- [ ] Enable Mem0 graph mode and test relationship extraction quality

## Test

- [ ] `Mem0MemoryProvider.ingest()` sends correct payload to Mem0 API
- [ ] `Mem0MemoryProvider.retrieve()` returns semantically relevant facts
- [ ] `TelegramMemoryProvider` continues to work unchanged (backward compat)
- [ ] Provider switch via config: changing `MEMORY_PROVIDER` swaps behavior without code changes
- [ ] `/memory` command works with both providers
- [ ] Telegram audit log receives changelog when Mem0 processes memories
- [ ] Graph mode produces entity relationships (manual inspection)
- [ ] Mem0 API failure degrades gracefully (agent still works, memories not updated)

## Notes

- **Why Mem0 over Letta**: Mem0 is a pluggable memory layer; Letta is a full agent framework. We already have an agent runtime (Claude SDK sessions). We need a memory backend, not a runtime replacement.
- **Migration path**: Existing Telegram-native facts can be bulk-imported into Mem0 via `mem0.add()` with the raw fact text. No complex migration needed.
- **Privacy**: Mem0 SaaS stores data on their infrastructure. For sensitive deployments, self-hosted mode keeps data local. Document this trade-off clearly.
- **Cost**: Mem0 free tier supports 1,000 memories. For personal use this is likely sufficient. Paid plans available for heavier usage.
- **Open questions**:
  - Should we run a periodic "full refinement" pass (send all facts to Mem0 for re-graphing) or rely solely on incremental ingestion?
  - How to handle Mem0's memory IDs vs our existing `f001`-style IDs in the `/memory` UI?
  - Should the audit log show Mem0's graph relationships, or just flat fact changes?