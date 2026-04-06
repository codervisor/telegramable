import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Logger } from "../logging";
import { MemoryTag } from "./store";
import { MemoryProvider } from "./provider";

const VALID_TAGS: MemoryTag[] = ["project", "personal", "preference", "decision", "context"];

export interface MemoryMcpServerOptions {
  memoryProvider: MemoryProvider;
  logger?: Logger;
}

/**
 * Creates an in-process MCP server that exposes memory tools to the agent.
 * The agent decides on its own when to save, update, or delete memories.
 */
export const createMemoryMcpServer = (options: MemoryMcpServerOptions): McpServer => {
  const { memoryProvider, logger } = options;

  const server = new McpServer({
    name: "memory",
    version: "1.0.0",
  });

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
      const fact = await memoryProvider.add(tag, text);
      const changelog = `<b>🧠 Memory updated</b>\n\n➕ <code>${fact.id}</code> [${fact.tag}] ${fact.text}`;
      await memoryProvider.sendChangelog(changelog);
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
      const existing = memoryProvider.get(id);
      if (!existing) {
        return { content: [{ type: "text", text: `Memory ${id} not found.` }] };
      }
      const oldText = existing.text;
      const ok = await memoryProvider.update(id, text);
      if (!ok) {
        return { content: [{ type: "text", text: `Failed to update memory ${id}.` }] };
      }
      const changelog = `<b>🧠 Memory updated</b>\n\n✏️ <code>${id}</code> → ${text}`;
      await memoryProvider.sendChangelog(changelog);
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
      const existing = memoryProvider.get(id);
      if (!existing) {
        return { content: [{ type: "text", text: `Memory ${id} not found.` }] };
      }
      const ok = await memoryProvider.remove(id);
      if (!ok) {
        return { content: [{ type: "text", text: `Failed to delete memory ${id}.` }] };
      }
      const changelog = `<b>🧠 Memory updated</b>\n\n🗑️ <code>${id}</code> ${existing.text}`;
      await memoryProvider.sendChangelog(changelog);
      logger?.info("Memory deleted via agent tool.", { id, text: existing.text });
      return { content: [{ type: "text", text: `Deleted memory ${id}: ${existing.text}` }] };
    },
  );

  server.tool(
    "list_memories",
    "List all stored memories. Use this to review what you currently know before saving or updating.",
    {},
    async () => {
      const facts = memoryProvider.all();
      if (facts.length === 0) {
        return { content: [{ type: "text", text: "No memories stored yet." }] };
      }
      const lines = facts.map((f) => `${f.id} [${f.tag}] ${f.text} (${f.at})`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.tool(
    "search_memories",
    "Search memories by keyword. Use this to check if something is already remembered before saving a duplicate.",
    {
      query: z.string().describe("Search term to match against memory text and tags."),
    },
    async ({ query }) => {
      const results = memoryProvider.search(query);
      if (results.length === 0) {
        return { content: [{ type: "text", text: `No memories matching "${query}".` }] };
      }
      const lines = results.map((f) => `${f.id} [${f.tag}] ${f.text} (${f.at})`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.tool(
    "get_memory",
    "Get a specific memory by ID.",
    {
      id: z.string().describe("The memory ID (e.g. 'f001')."),
    },
    async ({ id }) => {
      const fact = memoryProvider.get(id);
      if (!fact) {
        return { content: [{ type: "text", text: `Memory ${id} not found.` }] };
      }
      return { content: [{ type: "text", text: `${fact.id} [${fact.tag}] ${fact.text} (${fact.at})` }] };
    },
  );

  return server;
};
