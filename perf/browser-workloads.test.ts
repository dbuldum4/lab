import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
import { ALTERNATE_DOCUMENT_SHAPES } from "./document-shapes.ts";

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

test("alternate document fixtures retain distinct large shapes and final markers", () => {
  assert.deepEqual(ALTERNATE_DOCUMENT_SHAPES.map((shape) => shape.id), [
    "long-paragraph",
    "nested-lists",
    "table-heavy",
    "render-heavy",
  ]);
  for (const shape of ALTERNATE_DOCUMENT_SHAPES) {
    assert.ok(Buffer.byteLength(shape.markdown) > 75_000, `${shape.id} fixture is too small`);
    assert.ok(shape.markdown.endsWith(shape.marker), `${shape.id} marker is not final`);
  }
});

test("the performance index has complete weights and positive baselines", () => {
  const baseline = JSON.parse(readFileSync(new URL("./score-baseline.json", import.meta.url), "utf8")) as {
    metrics: Array<{ id: string; weight: number; baselineMs: number }>;
  };
  assert.equal(new Set(baseline.metrics.map((metric) => metric.id)).size, baseline.metrics.length);
  assert.equal(baseline.metrics.reduce((total, metric) => total + metric.weight, 0), 100);
  assert.ok(baseline.metrics.every((metric) => metric.baselineMs > 0));
});
