#!/usr/bin/env node
/**
 * Standalone stdio MCP server for memory tools.
 *
 * Usage:  node memoryMcpStdio.js <state-file.json>
 *
 * Reads initial memory state from the JSON file on startup.
 * Writes back on every mutation so the parent process can pick up changes.
 * Communicates with the Claude CLI via stdio (stdin/stdout).
 */
import { readFileSync, writeFileSync } from "fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---------- types (mirrored from store.ts to keep this self-contained) ----------

type MemoryTag = "project" | "personal" | "preference" | "decision" | "context";

interface MemoryFact {
  id: string;
  tag: MemoryTag;
  text: string;
  at: string;
}

interface MemorySnapshot {
  v: number;
  updated: string;
  facts: MemoryFact[];
}

// ---------- in-process store ----------

const VALID_TAGS: MemoryTag[] = ["project", "personal", "preference", "decision", "context"];

class MiniStore {
  private facts = new Map<string, MemoryFact>();
  private nextId = 1;

  load(snapshot: MemorySnapshot): void {
    this.facts.clear();
    let maxId = 0;
    for (const fact of snapshot.facts) {
      this.facts.set(fact.id, fact);
      const num = parseInt(fact.id.replace("f", ""), 10);
      if (num > maxId) maxId = num;
    }
    this.nextId = maxId + 1;
  }

  snapshot(): MemorySnapshot {
    return { v: 1, updated: new Date().toISOString(), facts: this.all() };
  }

  all(): MemoryFact[] {
    return Array.from(this.facts.values());
  }

  get(id: string): MemoryFact | undefined {
    return this.facts.get(id);
  }

  add(tag: MemoryTag, text: string): MemoryFact {
    const id = `f${String(this.nextId++).padStart(3, "0")}`;
    const fact: MemoryFact = { id, tag, text, at: new Date().toISOString().slice(0, 10) };
    this.facts.set(id, fact);
    return fact;
  }

  update(id: string, text: string): boolean {
    const fact = this.facts.get(id);
    if (!fact) return false;
    fact.text = text;
    fact.at = new Date().toISOString().slice(0, 10);
    return true;
  }

  remove(id: string): boolean {
    return this.facts.delete(id);
  }

  search(query: string): MemoryFact[] {
    const lower = query.toLowerCase();
    return this.all().filter(
      (f) => f.text.toLowerCase().includes(lower) || f.tag.includes(lower),
    );
  }
}

// ---------- main ----------

const stateFile = process.argv[2];
if (!stateFile) {
  process.stderr.write("Usage: memoryMcpStdio.js <state-file.json>\n");
  process.exit(1);
}

const store = new MiniStore();

// Load initial state
try {
  const raw = readFileSync(stateFile, "utf-8");
  const snapshot: MemorySnapshot = JSON.parse(raw);
  if (snapshot.v && Array.isArray(snapshot.facts)) {
    store.load(snapshot);
  }
} catch {
  // Start with empty state if file doesn't exist or is invalid
}

const flush = (): void => {
  writeFileSync(stateFile, JSON.stringify(store.snapshot(), null, 2), "utf-8");
};

// ---------- MCP server ----------

const server = new McpServer({ name: "memory", version: "1.0.0" });

server.tool(
  "save_memory",
  "Save a new fact about the user to long-term memory. Use this when the user shares something worth remembering across conversations: projects, preferences, personal context, decisions, or technical choices. Do NOT save transient or trivial information.",
  {
    tag: z.enum(["project", "personal", "preference", "decision", "context"])
      .describe("Category: project (work/projects), personal (life context), preference (likes/dislikes/style), decision (choices made), context (background info)"),
    text: z.string().max(120)
      .describe("The fact to remember. Keep it concise — under 120 characters."),
  },
  async ({ tag, text }) => {
    const fact = store.add(tag, text);
    flush();
    return { content: [{ type: "text" as const, text: `Saved memory ${fact.id}: [${tag}] ${text}` }] };
  },
);

server.tool(
  "update_memory",
  "Update an existing memory fact. Use this when the user provides new information that supersedes or refines something you already know.",
  {
    id: z.string().describe("The memory ID to update (e.g. 'f001'). Check your current memories in the system prompt."),
    text: z.string().max(120).describe("The updated fact text."),
  },
  async ({ id, text }) => {
    const existing = store.get(id);
    if (!existing) {
      return { content: [{ type: "text" as const, text: `Memory ${id} not found.` }] };
    }
    store.update(id, text);
    flush();
    return { content: [{ type: "text" as const, text: `Updated memory ${id}: ${text}` }] };
  },
);

server.tool(
  "delete_memory",
  "Delete a memory fact that is no longer relevant or accurate.",
  {
    id: z.string().describe("The memory ID to delete (e.g. 'f001')."),
  },
  async ({ id }) => {
    const existing = store.get(id);
    if (!existing) {
      return { content: [{ type: "text" as const, text: `Memory ${id} not found.` }] };
    }
    store.remove(id);
    flush();
    return { content: [{ type: "text" as const, text: `Deleted memory ${id}: ${existing.text}` }] };
  },
);

server.tool(
  "list_memories",
  "List all stored memories. Use this to review what you currently know before saving or updating.",
  {},
  async () => {
    const facts = store.all();
    if (facts.length === 0) {
      return { content: [{ type: "text" as const, text: "No memories stored yet." }] };
    }
    const lines = facts.map((f) => `${f.id} [${f.tag}] ${f.text} (${f.at})`);
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
);

server.tool(
  "search_memories",
  "Search memories by keyword. Use this to check if something is already remembered before saving a duplicate.",
  {
    query: z.string().describe("Search term to match against memory text and tags."),
  },
  async ({ query }) => {
    const results = store.search(query);
    if (results.length === 0) {
      return { content: [{ type: "text" as const, text: `No memories matching "${query}".` }] };
    }
    const lines = results.map((f) => `${f.id} [${f.tag}] ${f.text} (${f.at})`);
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
);

server.tool(
  "get_memory",
  "Get a specific memory by ID.",
  {
    id: z.string().describe("The memory ID (e.g. 'f001')."),
  },
  async ({ id }) => {
    const fact = store.get(id);
    if (!fact) {
      return { content: [{ type: "text" as const, text: `Memory ${id} not found.` }] };
    }
    return { content: [{ type: "text" as const, text: `${fact.id} [${fact.tag}] ${fact.text} (${fact.at})` }] };
  },
);

// Connect via stdio
const transport = new StdioServerTransport();
server.connect(transport).catch((err) => {
  process.stderr.write(`MCP server error: ${err}\n`);
  process.exit(1);
});
