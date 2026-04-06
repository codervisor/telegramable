import { Logger } from "../logging";
import { MemoryExtractor } from "./extractor";
import { MemoryChangelog, MemoryProvider } from "./provider";
import { MemoryFact, MemoryStore, MemoryTag } from "./store";
import { MemorySync } from "./sync";

/**
 * Memory provider backed by Telegram pinned messages.
 * Wraps the existing MemoryStore + MemorySync + MemoryExtractor.
 */
export class TelegramMemoryProvider implements MemoryProvider {
  readonly store: MemoryStore;

  constructor(
    private readonly sync: MemorySync,
    private readonly extractor: MemoryExtractor | undefined,
    private readonly logger?: Logger,
  ) {
    this.store = new MemoryStore();
  }

  async load(): Promise<void> {
    const snapshot = await this.sync.load();
    if (snapshot) {
      this.store.load(snapshot);
      this.logger?.info("Memory loaded from Telegram.", { facts: this.store.all().length });
    } else {
      await this.sync.save(this.store.snapshot());
      this.logger?.info("Memory initialized (empty).");
    }
  }

  all(): MemoryFact[] {
    return this.store.all();
  }

  get(id: string): MemoryFact | undefined {
    return this.store.get(id);
  }

  search(query: string): MemoryFact[] {
    return this.store.search(query);
  }

  byTag(tag: MemoryTag): MemoryFact[] {
    return this.store.byTag(tag);
  }

  async add(tag: MemoryTag, text: string): Promise<MemoryFact> {
    const fact = this.store.add(tag, text);
    await this.syncToTelegram();
    return fact;
  }

  async update(id: string, text: string): Promise<boolean> {
    const ok = this.store.update(id, text);
    if (ok) await this.syncToTelegram();
    return ok;
  }

  async remove(id: string): Promise<boolean> {
    const ok = this.store.remove(id);
    if (ok) await this.syncToTelegram();
    return ok;
  }

  async clear(): Promise<void> {
    this.store.clear();
    await this.syncToTelegram();
  }

  isEmpty(): boolean {
    return this.store.isEmpty();
  }

  async ingest(userText: string, assistantText: string): Promise<MemoryChangelog> {
    const empty: MemoryChangelog = { added: [], updated: [], removed: [] };
    if (!this.extractor) return empty;

    const conversation = `User: ${userText}\n\nAssistant: ${assistantText}`;
    const changes = await this.extractor.extract(conversation, this.store.all());

    const hasChanges = changes.add.length > 0 || changes.update.length > 0 || changes.remove.length > 0;
    if (!hasChanges) return empty;

    const changelog: MemoryChangelog = { added: [], updated: [], removed: [] };

    for (const item of changes.add) {
      const fact = this.store.add(item.tag, item.text);
      changelog.added.push(fact);
    }

    for (const item of changes.update) {
      if (this.store.update(item.id, item.text)) {
        changelog.updated.push({ id: item.id, text: item.text });
      }
    }

    for (const id of changes.remove) {
      const fact = this.store.get(id);
      if (fact && this.store.remove(id)) {
        changelog.removed.push({ id, text: fact.text });
      }
    }

    await this.syncToTelegram();

    this.logger?.info("Memory updated.", {
      added: changelog.added.length,
      updated: changelog.updated.length,
      removed: changelog.removed.length,
    });

    return changelog;
  }

  async sendChangelog(text: string): Promise<void> {
    await this.sync.sendChangelog(text);
  }

  /** Persist current store state to Telegram. Exposed for CLI runtime sync. */
  async syncToTelegram(): Promise<void> {
    try {
      await this.sync.save(this.store.snapshot());
    } catch (err) {
      this.logger?.warn("Failed to sync memory to Telegram.", {
        reason: err instanceof Error ? err.message : "unknown",
      });
    }
  }
}
