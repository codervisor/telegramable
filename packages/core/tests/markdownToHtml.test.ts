import assert from "assert";
import test from "node:test";
import { markdownToTelegramHtml } from "../src/hub/markdownToHtml";

test("markdownToTelegramHtml converts a simple table to a <pre> block", () => {
  const md = [
    "| Name | Age |",
    "| --- | --- |",
    "| Alice | 30 |",
    "| Bob | 25 |",
  ].join("\n");

  const html = markdownToTelegramHtml(md);

  assert.ok(html.includes("<pre>"), "should wrap in <pre>");
  assert.ok(html.includes("Alice"), "should contain cell data");
  assert.ok(html.includes("─"), "should contain box-drawing separator");
  assert.ok(html.includes("│"), "should contain box-drawing column separator");
  assert.ok(!html.includes("|"), "should not contain raw pipe characters");
});

test("markdownToTelegramHtml handles table rows with missing columns", () => {
  const md = [
    "| A | B | C |",
    "| --- | --- | --- |",
    "| 1 | 2 |",
  ].join("\n");

  const html = markdownToTelegramHtml(md);

  assert.ok(html.includes("<pre>"), "should still render as table");
  // The row with missing column should be padded to match column count
  const preContent = html.replace(/<\/?pre>/g, "");
  const lines = preContent.split("\n");
  // Header and data row should have the same number of │ separators
  const headerPipes = (lines[0].match(/│/g) || []).length;
  const dataRowPipes = (lines[2].match(/│/g) || []).length;
  assert.equal(headerPipes, dataRowPipes, "all rows should have the same number of column separators");
});

test("markdownToTelegramHtml passes non-table pipe lines through normally", () => {
  const md = "This line has a | pipe but is not a table.";
  const html = markdownToTelegramHtml(md);
  assert.ok(!html.includes("<pre>"), "should not be wrapped in <pre>");
});

test("markdownToTelegramHtml handles table mixed with other content", () => {
  const md = [
    "Here is a table:",
    "",
    "| X | Y |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
    "And some text after.",
  ].join("\n");

  const html = markdownToTelegramHtml(md);
  assert.ok(html.includes("<pre>"), "should contain a table block");
  assert.ok(html.includes("And some text after."), "should preserve surrounding text");
});
