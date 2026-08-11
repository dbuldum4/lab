import assert from "node:assert/strict";
import test from "node:test";
import { looksLikeMarkdown } from "../lib/paste-normalization.ts";
import {
  LARGE_PAGE_MARKDOWN,
  LARGE_PAGE_SECTIONS,
  LARGE_PLAIN_TEXT_PARAGRAPHS,
  LARGE_PLAIN_TEXT_PASTE,
  LARGE_STRUCTURED_PASTE,
  LARGE_STRUCTURED_PASTE_SECTIONS,
} from "./browser-workloads.ts";

function lineCount(source: string, pattern: RegExp) {
  return source.split("\n").filter((line) => pattern.test(line)).length;
}

test("large page and structured-paste fixtures keep their intended shapes", () => {
  assert.equal(lineCount(LARGE_PAGE_MARKDOWN, /^# /), LARGE_PAGE_SECTIONS);
  assert.equal(lineCount(LARGE_PAGE_MARKDOWN, /^## /), LARGE_PAGE_SECTIONS);
  assert.match(LARGE_PAGE_MARKDOWN, new RegExp(`marker-Large-page-${LARGE_PAGE_SECTIONS - 1}$`));

  assert.equal(lineCount(LARGE_STRUCTURED_PASTE, /^# /), LARGE_STRUCTURED_PASTE_SECTIONS);
  assert.equal(lineCount(LARGE_STRUCTURED_PASTE, /^## /), LARGE_STRUCTURED_PASTE_SECTIONS);
  assert.match(LARGE_STRUCTURED_PASTE, /```js/);
  assert.match(LARGE_STRUCTURED_PASTE, /\| Key \| Value \|/);
  assert.match(
    LARGE_STRUCTURED_PASTE,
    new RegExp(`marker-Structured-paste-${LARGE_STRUCTURED_PASTE_SECTIONS - 1}$`),
  );
});

test("plain-text paste fixture stays on the literal paste path", () => {
  assert.equal(LARGE_PLAIN_TEXT_PASTE.split("\n\n").length, LARGE_PLAIN_TEXT_PARAGRAPHS);
  assert.equal(looksLikeMarkdown(LARGE_PLAIN_TEXT_PASTE), false);
  assert.match(
    LARGE_PLAIN_TEXT_PASTE,
    new RegExp(`marker-Plain-paste-${LARGE_PLAIN_TEXT_PARAGRAPHS - 1}$`),
  );
});
