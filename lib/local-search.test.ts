import assert from "node:assert/strict";
import test from "node:test";
import {
  searchableMarkdown,
  searchExcerpt,
  searchLocalDocuments,
} from "./local-search.ts";

test("searches session names and Markdown text case-insensitively", () => {
  const results = searchLocalDocuments([
    { id: "alpha", name: "Project Atlas", markdown: "Review the launch checklist.", updatedAt: 2 },
    { id: "beta", name: "Recipes", markdown: "Coconut curry for Friday.", updatedAt: 3 },
    { id: "gamma", name: "Archive", markdown: "Nothing relevant here.", updatedAt: 4 },
  ], "LAUNCH");

  assert.deepEqual(results.map((result) => result.documentId), ["alpha"]);
  assert.equal(results[0]?.match, "content");
  assert.equal(results[0]?.excerpt, "Review the launch checklist.");

  const named = searchLocalDocuments([
    { id: "alpha", name: "Project Atlas", markdown: "Other content", updatedAt: 2 },
  ], "atlas");
  assert.equal(named[0]?.match, "name");
  assert.equal(named[0]?.excerpt, "");
});

test("requires every query term and prioritizes name matches", () => {
  const results = searchLocalDocuments([
    { id: "content", name: "Notes", markdown: "Alpha and beta are in the body.", updatedAt: 10 },
    { id: "name", name: "Alpha beta", markdown: "A short note.", updatedAt: 1 },
    { id: "partial", name: "Alpha", markdown: "Only one term.", updatedAt: 20 },
  ], "alpha beta");

  assert.deepEqual(results.map((result) => result.documentId), ["name", "content"]);
  assert.equal(results[0]?.match, "name");
  assert.equal(results[1]?.match, "content");
});

test("excerpts remove Markdown chrome and center the useful match", () => {
  const markdown = "# Weekly plan\n\nA very long introduction that should move out of the way.\n\n[Launch checklist](https://example.com) is ready for review.";
  assert.equal(searchableMarkdown(markdown), "Weekly plan A very long introduction that should move out of the way. Launch checklist is ready for review.");
  const excerpt = searchExcerpt(markdown, "checklist", 48);
  assert.match(excerpt, /checklist/);
  assert.match(excerpt, /^…/);
});

test("empty queries do not expose any local documents", () => {
  assert.deepEqual(searchLocalDocuments([
    { id: "alpha", name: "Private", markdown: "secret" },
  ], "   "), []);
});
