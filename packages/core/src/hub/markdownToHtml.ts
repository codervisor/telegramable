/**
 * Convert Markdown text to Telegram-compatible HTML.
 *
 * Telegram HTML supports: <b>, <i>, <u>, <s>, <code>, <pre>, <a href="">,
 * <blockquote>, <tg-spoiler>.
 *
 * This is a lightweight, dependency-free converter that handles the most common
 * Markdown patterns produced by LLMs (headings, bold, italic, code, links, lists).
 */

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Convert a markdown string to Telegram HTML.
 *
 * Strategy: process fenced code blocks first (they must not be transformed),
 * then convert inline patterns line-by-line.
 */
export const markdownToTelegramHtml = (md: string): string => {
  const segments: string[] = [];
  let cursor = 0;

  // 1. Extract fenced code blocks (```lang\n...\n```)
  const fenceRe = /^```(\w*)\n([\s\S]*?)^```\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(md)) !== null) {
    // Process text before this fence
    if (match.index > cursor) {
      segments.push(convertInline(md.slice(cursor, match.index)));
    }
    const lang = match[1];
    const code = escapeHtml(match[2].replace(/\n$/, ""));
    segments.push(
      lang
        ? `<pre><code class="language-${escapeHtml(lang)}">${code}</code></pre>`
        : `<pre>${code}</pre>`
    );
    cursor = match.index + match[0].length;
  }

  // Remaining text after last fence
  if (cursor < md.length) {
    segments.push(convertInline(md.slice(cursor)));
  }

  return segments.join("");
};

/**
 * Detect whether a sequence of lines forms a markdown table.
 * A table needs at least a header row and a separator row (e.g. |---|---|).
 */
const isTableBlock = (lines: string[]): boolean => {
  if (lines.length < 2) return false;
  // Check the second line is a separator row: cells containing only dashes/colons/spaces
  const sepLine = lines[1].trim().replace(/^\||\|$/g, "");
  return /^[\s|:-]+$/.test(sepLine) && sepLine.includes("-");
};

/**
 * Render a markdown table as a Telegram-friendly monospace <pre> block.
 * Parses cells, pads them to equal widths, and uses box-drawing-style separators.
 */
const renderTable = (lines: string[]): string => {
  // Parse each row into cells
  const rows = lines.map((line) => {
    const trimmed = line.trim().replace(/^\||\|$/g, "");
    return trimmed.split("|").map((cell) => cell.trim());
  });

  // Remove the separator row (index 1)
  const dataRows = rows.filter((_, i) => i !== 1);

  // Calculate max width per column
  const colCount = Math.max(...dataRows.map((r) => r.length));
  const colWidths: number[] = Array.from({ length: colCount }, () => 0);
  for (const row of dataRows) {
    for (let i = 0; i < colCount; i++) {
      colWidths[i] = Math.max(colWidths[i], (row[i] || "").length);
    }
  }

  // Build formatted rows
  const formatRow = (cells: string[]): string => {
    return cells
      .map((cell, i) => (cell || "").padEnd(colWidths[i] || 0))
      .join(" │ ");
  };

  const separator = colWidths.map((w) => "─".repeat(w)).join("─┼─");

  const formatted: string[] = [];
  for (let i = 0; i < dataRows.length; i++) {
    formatted.push(formatRow(dataRows[i]));
    // Add separator after header (first data row)
    if (i === 0) {
      formatted.push(separator);
    }
  }

  return `<pre>${escapeHtml(formatted.join("\n"))}</pre>`;
};

/** Detect if a line looks like a markdown table row (starts/contains pipe-delimited cells). */
const isTableRow = (line: string): boolean => /^\s*\|.+\|/.test(line);

/** Convert inline markdown (everything except fenced code blocks). */
const convertInline = (text: string): string => {
  const lines = text.split("\n");
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    // Detect table blocks: consecutive lines that look like table rows
    if (isTableRow(lines[i])) {
      const tableStart = i;
      while (i < lines.length && isTableRow(lines[i])) {
        i++;
      }
      const tableLines = lines.slice(tableStart, i);
      if (isTableBlock(tableLines)) {
        result.push(renderTable(tableLines));
      } else {
        // Not a real table — convert lines normally
        result.push(...tableLines.map(convertLine));
      }
      continue;
    }

    result.push(convertLine(lines[i]));
    i++;
  }

  return result.join("\n");
};

/** Convert a single line of markdown to Telegram HTML. */
const convertLine = (line: string): string => {
  // Headings → bold (Telegram has no heading tag)
  const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
  if (headingMatch?.[2]) {
    return `<b>${convertInlineFormatting(escapeHtml(headingMatch[2]))}</b>`;
  }

  // Horizontal rules
  if (/^[-*_]{3,}\s*$/.test(line)) {
    return "———";
  }

  // Unordered list items: preserve bullet
  const ulMatch = line.match(/^(\s*)[-*+]\s+(.+)$/);
  if (ulMatch) {
    return `${ulMatch[1]}• ${convertInlineFormatting(escapeHtml(ulMatch[2]))}`;
  }

  // Ordered list items: preserve number
  const olMatch = line.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
  if (olMatch?.[3]) {
    return `${olMatch[1]}${olMatch[2]}. ${convertInlineFormatting(escapeHtml(olMatch[3]))}`;
  }

  // Blockquote lines
  const bqMatch = line.match(/^>\s?(.*)$/);
  if (bqMatch) {
    // We don't wrap individual lines in <blockquote> here because multi-line
    // blockquotes need grouping. Instead, just use a visual indicator.
    return `│ ${convertInlineFormatting(escapeHtml(bqMatch[1]))}`;
  }

  // Regular line
  return convertInlineFormatting(escapeHtml(line));
};

/**
 * Convert inline formatting tokens on already-HTML-escaped text.
 * Order matters: process longer/more specific patterns first.
 */
const convertInlineFormatting = (escaped: string): string => {
  let result = escaped;

  // Inline code: `code` (must come before bold/italic to avoid conflicts)
  result = result.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Bold + italic: ***text*** or ___text___
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, "<b><i>$1</i></b>");
  result = result.replace(/___(.+?)___/g, "<b><i>$1</i></b>");

  // Bold: **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  result = result.replace(/__(.+?)__/g, "<b>$1</b>");

  // Italic: *text* or _text_ (but not mid-word underscores like foo_bar_baz)
  result = result.replace(/(?<!\w)\*([^\s*](?:.*?[^\s*])?)\*(?!\w)/g, "<i>$1</i>");
  result = result.replace(/(?<!\w)_([^\s_](?:.*?[^\s_])?)_(?!\w)/g, "<i>$1</i>");

  // Strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Links: [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  return result;
};
