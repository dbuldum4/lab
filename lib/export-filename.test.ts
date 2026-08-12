import assert from "node:assert/strict";
import test from "node:test";
import { markdownExportFilename } from "./export-filename.ts";

test("uses a stable Untitled fallback for blank or default session names", () => {
  assert.equal(markdownExportFilename(""), "untitled.md");
  assert.equal(markdownExportFilename("   \n\t"), "untitled.md");
  assert.equal(markdownExportFilename("Untitled"), "untitled.md");
  assert.equal(markdownExportFilename("UNTITLED.md"), "untitled.md");
  assert.equal(markdownExportFilename(undefined), "untitled.md");
});

test("turns punctuation, whitespace, dots, and path separators into one safe separator", () => {
  assert.equal(markdownExportFilename("  Project / Q3...Plan: v2?  "), "project-q3-plan-v2.md");
  assert.equal(markdownExportFilename("already.md"), "already.md");
  assert.equal(markdownExportFilename("report.md.md"), "report.md");
  assert.equal(markdownExportFilename("..."), "untitled.md");
});

test("preserves useful Unicode letters while normalizing the filename extension", () => {
  assert.equal(markdownExportFilename("Café-日本語 Notes"), "café-日本語-notes.md");
  assert.equal(markdownExportFilename("Résumé"), "résumé.md");
});

test("caps long names without splitting the extension or leaving a separator tail", () => {
  const filename = markdownExportFilename(`${"a".repeat(120)}...`);
  assert.equal(filename, `${"a".repeat(80)}.md`);
  assert.equal(filename.endsWith(".md"), true);
  assert.equal(filename.length, 83);
});

test("avoids Windows device basenames", () => {
  assert.equal(markdownExportFilename("CON"), "note-con.md");
  assert.equal(markdownExportFilename("LPT1.md"), "note-lpt1.md");
});
