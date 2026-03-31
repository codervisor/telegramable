import { MemoryFact, MemoryTag, TAG_ORDER } from "../memory";

const MEMORY_CALLBACK_PREFIX = "mem:";
const PAGE_SIZE = 8;

/** Escape HTML special characters for Telegram HTML parse mode. */
const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export { MEMORY_CALLBACK_PREFIX };

type InlineKeyboard = Array<Array<{ text: string; callback_data: string }>>;

/**
 * Build the /memory list response with inline keyboard buttons.
 * Returns { text, markup } for use with sendMessageWithMarkup.
 */
export function buildMemoryListMarkup(
  facts: MemoryFact[],
  page: number = 0
): { text: string; markup: { inline_keyboard: InlineKeyboard } } {
  if (facts.length === 0) {
    return {
      text: "No memories stored yet.",
      markup: { inline_keyboard: [] },
    };
  }

  const totalPages = Math.ceil(facts.length / PAGE_SIZE);
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const offset = safePage * PAGE_SIZE;
  const pageFacts = facts.slice(offset, offset + PAGE_SIZE);

  // Build text: grouped by tag (only for current page)
  const grouped = new Map<MemoryTag, MemoryFact[]>();
  for (const fact of pageFacts) {
    const list = grouped.get(fact.tag) || [];
    list.push(fact);
    grouped.set(fact.tag, list);
  }

  const sections: string[] = [];
  for (const tag of TAG_ORDER) {
    const list = grouped.get(tag);
    if (!list?.length) continue;
    const heading = tag.charAt(0).toUpperCase() + tag.slice(1);
    const bullets = list.map((f) => `  <code>${f.id}</code> ${escapeHtml(f.text)}`).join("\n");
    sections.push(`<b>${heading}</b>\n${bullets}`);
  }

  const header = `🧠 <b>Memory</b> (${facts.length} fact${facts.length === 1 ? "" : "s"})`;
  const pageInfo = totalPages > 1 ? `\n\n<i>Page ${safePage + 1}/${totalPages}</i>` : "";
  const text = `${header}\n\n${sections.join("\n\n")}${pageInfo}`;

  // Build inline keyboard
  const keyboard: InlineKeyboard = [];

  // Delete buttons — one row per 4 facts, encode current page for stable navigation
  for (let i = 0; i < pageFacts.length; i += 4) {
    const row = pageFacts.slice(i, i + 4).map((f) => ({
      text: `🗑 ${f.id}`,
      callback_data: `${MEMORY_CALLBACK_PREFIX}delete:${f.id}:${safePage}`,
    }));
    keyboard.push(row);
  }

  // Pagination row (if needed)
  if (totalPages > 1) {
    const navRow: Array<{ text: string; callback_data: string }> = [];
    if (safePage > 0) {
      navRow.push({ text: "◀ Prev", callback_data: `${MEMORY_CALLBACK_PREFIX}page:${safePage - 1}` });
    }
    navRow.push({ text: `${safePage + 1}/${totalPages}`, callback_data: `${MEMORY_CALLBACK_PREFIX}noop` });
    if (safePage < totalPages - 1) {
      navRow.push({ text: "Next ▶", callback_data: `${MEMORY_CALLBACK_PREFIX}page:${safePage + 1}` });
    }
    keyboard.push(navRow);
  }

  // Action row
  keyboard.push([
    { text: "🧹 Clear All", callback_data: `${MEMORY_CALLBACK_PREFIX}clear:prompt` },
    { text: "📄 Export", callback_data: `${MEMORY_CALLBACK_PREFIX}export` },
    { text: "ℹ️ Channel", callback_data: `${MEMORY_CALLBACK_PREFIX}channel` },
  ]);

  return { text, markup: { inline_keyboard: keyboard } };
}

/**
 * Build the clear-all confirmation message with confirm/cancel buttons.
 */
export function buildClearConfirmMarkup(factCount: number): {
  text: string;
  markup: { inline_keyboard: InlineKeyboard };
} {
  return {
    text: `⚠️ Are you sure you want to delete all <b>${factCount}</b> fact${factCount === 1 ? "" : "s"}? This cannot be undone.`,
    markup: {
      inline_keyboard: [
        [
          { text: "Yes, clear all ⚠️", callback_data: `${MEMORY_CALLBACK_PREFIX}clear:confirm` },
          { text: "Cancel", callback_data: `${MEMORY_CALLBACK_PREFIX}clear:cancel` },
        ],
      ],
    },
  };
}

/**
 * Build the channel info message with flush-cache button.
 */
export function buildChannelInfoMarkup(
  resolvedChatId: string,
  rawChatId?: string,
  cacheSource?: "cached" | "resolved" | "direct"
): { text: string; markup: { inline_keyboard: InlineKeyboard } } {
  const lines = [`📡 <b>Memory Channel</b>\n`];
  lines.push(`<b>Chat ID:</b> <code>${escapeHtml(resolvedChatId)}</code>`);

  if (rawChatId && rawChatId !== resolvedChatId) {
    lines.push(`<b>Configured as:</b> <code>${escapeHtml(rawChatId)}</code>`);
  }

  if (cacheSource) {
    const label = cacheSource === "cached" ? "Cached" : cacheSource === "resolved" ? "Resolved at startup" : "Direct (numeric)";
    lines.push(`<b>Source:</b> ${label}`);
  }

  const keyboard: InlineKeyboard = [];
  // Only show flush button if there's a cache to flush (non-numeric config)
  if (rawChatId && rawChatId !== resolvedChatId) {
    keyboard.push([
      { text: "🔄 Flush Cache", callback_data: `${MEMORY_CALLBACK_PREFIX}cache:flush` },
    ]);
  }

  return {
    text: lines.join("\n"),
    markup: { inline_keyboard: keyboard },
  };
}
