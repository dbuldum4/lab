import assert from "node:assert/strict";
import test from "node:test";
import { calculateDocumentStats, readableMarkdown } from "./document-stats.ts";

test("counts readable Markdown instead of formatting syntax", () => {
  const markdown = "# Hello world\n\nA **small** [linked note](https://example.com).\n\n```ts\nconst value = 1\n```";
  const stats = calculateDocumentStats(markdown);
  assert.equal(stats.words, 9);
  assert.equal(stats.headings, 1);
  assert.equal(stats.paragraphs, 2);
  assert.equal(stats.codeBlocks, 1);
  assert.equal(stats.readingMinutes, 1);
});

test("empty notes have zero reading time", () => {
  assert.deepEqual(calculateDocumentStats(""), {
    words: 0,
    characters: 0,
    charactersNoSpaces: 0,
    paragraphs: 0,
    headings: 0,
    codeBlocks: 0,
    readingMinutes: 0,
  });
});

test("callout and details wrappers do not inflate readable text", () => {
  const markdown = "> [!TIP]\n> Keep it local.\n\n<details>\n<summary>More</summary>\n\nHidden words.\n\n</details>";
  assert.equal(readableMarkdown(markdown).includes("TIP"), false);
  assert.equal(calculateDocumentStats(markdown).words, 6);
});
