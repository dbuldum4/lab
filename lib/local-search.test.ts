import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeSearchQuery,
  normalizeSearchText,
  searchableMarkdown,
  searchMatchRanges,
  searchExcerpt,
  searchLocalDocuments,
} from "./local-search.ts";

test("normalizes accents, compatibility characters, case, and repeated whitespace", () => {
  assert.equal(normalizeSearchText("  Rosé   PINE  "), "rose pine");
  assert.equal(normalizeSearchQuery("CAFÉ\u00a0  plans"), "cafe plans");
  assert.equal(normalizeSearchText("ﬃnal"), "ffinal");
});

test("matches accented names and content while preserving readable originals", () => {
  const results = searchLocalDocuments([
    { id: "cafe", name: "Café plans", markdown: "Meet for crème brûlée after lunch." },
  ], "  CAFE   creme ");

  assert.equal(results[0]?.name, "Café plans");
  assert.equal(results[0]?.match, "name-and-content");
  assert.match(results[0]?.excerpt ?? "", /crème brûlée/);
});

test("maps accent-insensitive highlights back to original source ranges", () => {
  assert.deepEqual(searchMatchRanges("Café and cafe\u0301", "CAFE"), [
    { start: 0, end: 4 },
    { start: 9, end: 14 },
  ]);
  assert.deepEqual(searchMatchRanges("office ﬃnal", "ffinal"), [{ start: 7, end: 11 }]);
});

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

test("allows a multi-word query to span a session name and its note body", () => {
  const results = searchLocalDocuments([
    { id: "planning", name: "Planning", markdown: "Prepare the launch checklist." },
    { id: "unrelated", name: "Planning", markdown: "Review the budget." },
  ], "planning launch");

  assert.deepEqual(results.map((result) => result.documentId), ["planning"]);
  assert.equal(results[0]?.match, "name-and-content");
  assert.match(results[0]?.excerpt ?? "", /launch/);
});

test("keeps literal punctuation searchable", () => {
  const markdown = "# Budget\n\nCost $5; use snake_case and C:\\tmp.\n\n$$x^2$$";
  assert.match(searchableMarkdown(markdown), /Cost \$5; use snake_case and C:\\tmp\. \$\$x\^2\$\$/);

  for (const query of ["$5", "snake_case", "C:\\tmp", "x^2"]) {
    assert.deepEqual(
      searchLocalDocuments([{ id: "budget", name: "Budget", markdown }], query).map((result) => result.documentId),
      ["budget"],
      query,
    );
  }
});

test("excerpts remove Markdown chrome and center the useful match", () => {
  const markdown = "# Weekly plan\n\nA very long introduction that should move out of the way.\n\n[Launch checklist](https://example.com) is ready for review.";
  assert.equal(searchableMarkdown(markdown), "Weekly plan A very long introduction that should move out of the way. Launch checklist is ready for review.");
  const excerpt = searchExcerpt(markdown, "checklist", 48);
  assert.match(excerpt, /checklist/);
  assert.match(excerpt, /^…/);
});

test("excerpts keep a distant match near the visible start of the card", () => {
  const markdown = `${"long introduction ".repeat(40)}needle ${"trailing context ".repeat(40)}`;
  const excerpt = searchExcerpt(markdown, "needle", 48);
  assert.ok(excerpt.indexOf("needle") >= 0);
  assert.ok(excerpt.indexOf("needle") < 30, excerpt);
});

test("accent-insensitive excerpt matches do not use normalized indexes on original text", () => {
  const decomposedCafe = `cafe\u0301`;
  const markdown = `${"long introduction ".repeat(40)}${decomposedCafe} ${"trailing context ".repeat(40)}`;
  const excerpt = searchExcerpt(markdown, "cafe", 32);
  assert.match(excerpt, new RegExp(decomposedCafe));
  assert.ok(excerpt.indexOf(decomposedCafe) < 20, excerpt);
});

test("empty queries do not expose any local documents", () => {
  assert.deepEqual(searchLocalDocuments([
    { id: "alpha", name: "Private", markdown: "secret" },
  ], "   "), []);
});

test("returns every matching session beyond the first 24 results", () => {
  const documents = Array.from({ length: 30 }, (_, index) => ({
    id: `match-${index}`,
    name: `Result ${index}`,
    markdown: "shared searchable token",
    updatedAt: index,
  }));

  const results = searchLocalDocuments(documents, "searchable token");

  assert.equal(results.length, 30);
  assert.deepEqual(
    new Set(results.map((result) => result.documentId)),
    new Set(documents.map((document) => document.id)),
  );
  assert.equal(results.at(-1)?.documentId, "match-0");
});
