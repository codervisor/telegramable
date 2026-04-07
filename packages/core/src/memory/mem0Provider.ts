import { randomUUID } from "crypto";
import { Logger } from "../logging";
import { MemoryChangelog, MemoryProvider } from "./provider";
import { MemoryFact, MemoryTag } from "./store";

export interface Mem0Config {
  apiKey: string;
  baseUrl?: string; // defaults to https://api.mem0.ai
  userId: string;   // scoping key for memories
}

interface Mem0Memory {
  id: string;
  memory: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

interface Mem0AddResponse {
  results: Array<{
    id: string;
    memory: string;
    event: "ADD" | "UPDATE" | "DELETE" | "NOOP";
  }>;
}

interface Mem0SearchResponse {
  results: Array<Mem0Memory>;
}

const DEFAULT_BASE_URL = "https://api.mem0.ai";
const DEFAULT_TAG: MemoryTag = "context";

/**
 * Memory provider backed by Mem0 (https://mem0.ai).
 *
 * Mem0 handles extraction, deduplication, and semantic search internally.
 * Facts are cached locally after load() for synchronous reads (all/get/search).
 */
export class Mem0MemoryProvider implements MemoryProvider {
  private readonly baseUrl: string;
  private cache = new Map<string, MemoryFact>();

  constructor(
    private readonly config: Mem0Config,
    private readonly logger?: Logger,
  ) {
    this.baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  async load(): Promise<void> {
    const memories = await this.fetchAll();
    this.rebuildCache(memories);
    this.logger?.info("Memory loaded from Mem0.", { facts: this.cache.size });
  }

  all(): MemoryFact[] {
    return Array.from(this.cache.values());
  }

  get(id: string): MemoryFact | undefined {
    return this.cache.get(id);
  }

  search(query: string): MemoryFact[] {
    // Use local cache for substring search (synchronous)
    const lower = query.toLowerCase();
    return this.all().filter(
      (f) => f.text.toLowerCase().includes(lower) || f.tag.includes(lower),
    );
  }

  byTag(tag: MemoryTag): MemoryFact[] {
    return this.all().filter((f) => f.tag === tag);
  }

  async add(tag: MemoryTag, text: string): Promise<MemoryFact> {
    const body = {
      messages: [{ role: "user", content: text }],
      user_id: this.config.userId,
      metadata: { tag },
      infer: false, // store verbatim — caller already decided what to save
    };

    const res = await this.request<Mem0AddResponse>("POST", "/v1/memories/", body);
    const entry = res.results?.[0];
    const id = entry?.id || randomUUID();

    const fact: MemoryFact = {
      id,
      tag,
      text: entry?.memory || text,
      at: new Date().toISOString().slice(0, 10),
    };
    this.cache.set(id, fact);
    return fact;
  }

  async update(id: string, text: string): Promise<boolean> {
    try {
      await this.request("PUT", `/v1/memories/${id}/`, { text });
      const existing = this.cache.get(id);
      if (existing) {
        existing.text = text;
        existing.at = new Date().toISOString().slice(0, 10);
      }
      return true;
    } catch {
      return false;
    }
  }

  async remove(id: string): Promise<boolean> {
    try {
      await this.request("DELETE", `/v1/memories/${id}/`);
      return this.cache.delete(id);
    } catch {
      return false;
    }
  }

  async clear(): Promise<void> {
    await this.request("DELETE", `/v1/memories/`, { user_id: this.config.userId });
    this.cache.clear();
  }

  isEmpty(): boolean {
    return this.cache.size === 0;
  }

  async ingest(userText: string, assistantText: string): Promise<MemoryChangelog> {
    const body = {
      messages: [
        { role: "user", content: userText },
        { role: "assistant", content: assistantText },
      ],
      user_id: this.config.userId,
      infer: true, // let Mem0 extract and deduplicate
    };

    const res = await this.request<Mem0AddResponse>("POST", "/v1/memories/", body);

    const changelog: MemoryChangelog = { added: [], updated: [], removed: [] };

    for (const entry of res.results || []) {
      switch (entry.event) {
        case "ADD": {
          const fact: MemoryFact = {
            id: entry.id,
            tag: DEFAULT_TAG,
            text: entry.memory,
            at: new Date().toISOString().slice(0, 10),
          };
          this.cache.set(entry.id, fact);
          changelog.added.push(fact);
          break;
        }
        case "UPDATE": {
          const existing = this.cache.get(entry.id);
          if (existing) {
            existing.text = entry.memory;
            existing.at = new Date().toISOString().slice(0, 10);
          }
          changelog.updated.push({ id: entry.id, text: entry.memory });
          break;
        }
        case "DELETE": {
          const removed = this.cache.get(entry.id);
          if (removed) {
            this.cache.delete(entry.id);
            changelog.removed.push({ id: entry.id, text: removed.text });
          }
          break;
        }
        // NOOP — skip
      }
    }

    if (changelog.added.length || changelog.updated.length || changelog.removed.length) {
      this.logger?.info("Memory updated via Mem0.", {
        added: changelog.added.length,
        updated: changelog.updated.length,
        removed: changelog.removed.length,
      });
    }

    return changelog;
  }

  async sendChangelog(_text: string): Promise<void> {
    // Mem0 provider doesn't have a built-in audit channel.
    // Callers (e.g. ChannelHub) can optionally forward to Telegram.
  }

  async saveNewSnapshot(): Promise<void> {
    // Mem0 handles persistence internally — no versioned snapshots needed.
  }

  // -- Semantic search via Mem0 API (async, for richer retrieval) --

  async semanticSearch(query: string, limit = 20): Promise<MemoryFact[]> {
    const body = {
      query,
      user_id: this.config.userId,
      limit,
    };

    const res = await this.request<Mem0SearchResponse>("POST", "/v1/memories/search/", body);

    return (res.results || []).map((m) => ({
      id: m.id,
      tag: (m.metadata?.tag as MemoryTag) || DEFAULT_TAG,
      text: m.memory,
      at: m.updated_at?.slice(0, 10) || m.created_at?.slice(0, 10) || new Date().toISOString().slice(0, 10),
    }));
  }

  // -- Internal helpers --

  private async fetchAll(): Promise<Mem0Memory[]> {
    const res = await this.request<Mem0Memory[] | { results: Mem0Memory[] }>(
      "GET",
      `/v1/memories/?user_id=${encodeURIComponent(this.config.userId)}`,
    );
    return Array.isArray(res) ? res : res.results || [];
  }

  private rebuildCache(memories: Mem0Memory[]): void {
    this.cache.clear();
    for (const m of memories) {
      this.cache.set(m.id, {
        id: m.id,
        tag: (m.metadata?.tag as MemoryTag) || DEFAULT_TAG,
        text: m.memory,
        at: m.updated_at?.slice(0, 10) || m.created_at?.slice(0, 10) || new Date().toISOString().slice(0, 10),
      });
    }
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Token ${this.config.apiKey}`,
      "Content-Type": "application/json",
    };

    const init: RequestInit = { method, headers };
    if (body && method !== "GET") {
      init.body = JSON.stringify(body);
    }

    const response = await fetch(url, init);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Mem0 API ${method} ${path} failed (${response.status}): ${text.slice(0, 200)}`);
    }

    // DELETE returns 204 No Content
    if (response.status === 204) return {} as T;

    return response.json() as Promise<T>;
  }
}
