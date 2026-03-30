import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Logger } from "../logging";
import { MemoryStore, MemoryTag } from "./store";
import { MemorySync } from "./sync";

const VALID_TAGS: MemoryTag[] = ["project", "personal", "preference", "decision", "context"];

export interface MemoryMcpServerOptions {
  memoryStore: MemoryStore;
  memorySync: MemorySync;
  logger?: Logger;
}

/**
 * Creates an in-process MCP server that exposes memory tools to the agent.
 * The agent decides on its own when to save, update, or delete memories.
 */
export const createMemoryMcpServer = (options: MemoryMcpServerOptions): McpServer => {
  const { memoryStore, memorySync, logger } = options;

  const server = new McpServer({
    name: "memory",
    version: "1.0.0",
  });

  const syncToTelegram = async (): Promise<void> => {
    try {
      await memorySync.save(memoryStore.snapshot());
    } catch (err) {
      logger?.warn("Failed to sync memory to Telegram.", {
        reason: err instanceof Error ? err.message : "unknown",
      });
    }
  };

  const sendChangelog = async (text: string): Promise<void> => {
    try {
      await memorySync.sendChangelog(text);
    } catch (err) {
      logger?.warn("Failed to send memory changelog.", {
        reason: err instanceof Error ? err.message : "unknown",
      });
    }
  };

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
      const fact = memoryStore.add(tag, text);
      await syncToTelegram();
      const changelog = `<b>🧠 Memory updated</b>\n\n➕ <code>${fact.id}</code> [${fact.tag}] ${fact.text}`;
      await sendChangelog(changelog);
      logger?.info("Memory saved via agent tool.", { id: fact.id, tag, text });
      return { content: [{ type: "text", text: `Saved memory ${fact.id}: [${tag}] ${text}` }] };
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
      const existing = memoryStore.get(id);
      if (!existing) {
        return { content: [{ type: "text", text: `Memory ${id} not found.` }] };
      }
      const oldText = existing.text;
      memoryStore.update(id, text);
      await syncToTelegram();
      const changelog = `<b>🧠 Memory updated</b>\n\n✏️ <code>${id}</code> → ${text}`;
      await sendChangelog(changelog);
      logger?.info("Memory updated via agent tool.", { id, oldText, newText: text });
      return { content: [{ type: "text", text: `Updated memory ${id}: ${text}` }] };
    },
  );

  server.tool(
    "delete_memory",
    "Delete a memory fact that is no longer relevant or accurate.",
    {
      id: z.string().describe("The memory ID to delete (e.g. 'f001')."),
    },
    async ({ id }) => {
      const existing = memoryStore.get(id);
      if (!existing) {
        return { content: [{ type: "text", text: `Memory ${id} not found.` }] };
      }
      memoryStore.remove(id);
      await syncToTelegram();
      const changelog = `<b>🧠 Memory updated</b>\n\n🗑️ <code>${id}</code> ${existing.text}`;
      await sendChangelog(changelog);
      logger?.info("Memory deleted via agent tool.", { id, text: existing.text });
      return { content: [{ type: "text", text: `Deleted memory ${id}: ${existing.text}` }] };
    },
  );

  server.tool(
    "list_memories",
    "List all stored memories. Use this to review what you currently know before saving or updating.",
    {},
    async () => {
      const facts = memoryStore.all();
      if (facts.length === 0) {
        return { content: [{ type: "text", text: "No memories stored yet." }] };
      }
      const lines = facts.map((f) => `${f.id} [${f.tag}] ${f.text} (${f.at})`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  return server;
};
