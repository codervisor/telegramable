import { MemoryFact, MemorySnapshot, MemoryTag } from "./store";

/**
 * Abstract memory backend. Implementations handle persistence, extraction,
 * and retrieval — callers interact through this uniform interface.
 */
export interface MemoryProvider {
  /** Load initial state (cold start). */
  load(): Promise<void>;

  /** Get all stored facts. */
  all(): MemoryFact[];

  /** Get a fact by ID. */
  get(id: string): MemoryFact | undefined;

  /** Search facts by keyword. */
  search(query: string): MemoryFact[];

  /** Filter facts by tag. */
  byTag(tag: MemoryTag): MemoryFact[];

  /** Add a new fact. Returns the created fact. */
  add(tag: MemoryTag, text: string): Promise<MemoryFact>;

  /** Update a fact's text. Returns true if found and updated. */
  update(id: string, text: string): Promise<boolean>;

  /** Remove a fact. Returns true if found and removed. */
  remove(id: string): Promise<boolean>;

  /** Clear all facts. */
  clear(): Promise<void>;

  /** Whether the store is empty. */
  isEmpty(): boolean;

  /**
   * Ingest a conversation for automatic fact extraction.
   * Called after each agent response to extract new memories.
   */
  ingest(userText: string, assistantText: string): Promise<MemoryChangelog>;

  /**
   * Send a human-readable changelog to the audit channel (e.g. Telegram).
   * Providers that don't support audit logging can no-op.
   */
  sendChangelog(text: string): Promise<void>;

  /**
   * Replace the entire memory state with a new snapshot and persist it.
   * Used after refinement to atomically swap in the consolidated state
   * with a single write (e.g. new pinned message in Telegram).
   */
  loadAndSaveSnapshot(snapshot: MemorySnapshot): Promise<void>;
}

export interface MemoryChangelog {
  added: MemoryFact[];
  updated: Array<{ id: string; text: string }>;
  removed: Array<{ id: string; text: string }>;
}
