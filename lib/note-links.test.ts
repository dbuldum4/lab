import assert from "node:assert/strict";
import test from "node:test";
import {
  documentIdFromLocalHref,
  findBacklinks,
  linkedDocumentIds,
  localSessionHref,
} from "./note-links.ts";

test("creates and parses safe local session links", () => {
  assert.equal(localSessionHref("note_1"), "#session=note_1");
  assert.equal(documentIdFromLocalHref("#session=note_1"), "note_1");
  assert.equal(documentIdFromLocalHref("javascript:alert(1)"), null);
  assert.equal(documentIdFromLocalHref("#session=bad%2Fid"), null);
});
test("extracts unique linked document ids", () => {
  assert.deepEqual(
    linkedDocumentIds("[Alpha](#session=a) and [again](#session=a) plus [Beta](#session=b)"),
    ["a", "b"],
  );
});

test("ignores links in fenced and inline code, escaped links, and images", () => {
  const markdown = [
    "```md",
    "[Fence](#session=fence)",
    "```",
    "",
    "`[Inline](#session=inline)`",
    "\\[Escaped](#session=escaped)",
    "![Image](#session=image)",
    "[Real](#session=real)",
  ].join("\n");

  assert.deepEqual(linkedDocumentIds(markdown), ["real"]);
});

test("backlinks only use real Markdown links", () => {
  const backlinks = findBacklinks([
    { id: "fence", name: "Fence", markdown: "```\n[Target](#session=target)\n```", updatedAt: 4 },
    { id: "inline", name: "Inline", markdown: "`[Target](#session=target)`", updatedAt: 3 },
    { id: "escaped", name: "Escaped", markdown: "\\[Target](#session=target)", updatedAt: 2 },
    { id: "image", name: "Image", markdown: "![Target](#session=target)", updatedAt: 5 },
    { id: "real", name: "Real", markdown: "See [Target](#session=target) here.", updatedAt: 1 },
  ], "target");

  assert.deepEqual(backlinks.map((item) => item.documentId), ["real"]);
});

test("treats an unmatched backtick as literal and keeps multiline code spans masked", () => {
  assert.deepEqual(
    linkedDocumentIds("Unmatched ` marker\n[Real](#session=real)"),
    ["real"],
  );
  assert.deepEqual(
    linkedDocumentIds("`[Fake]\n(#session=fake)`\n[Real](#session=real)"),
    ["real"],
  );
});

test("finds backlinks with useful excerpts and newest first", () => {
  const backlinks = findBacklinks([
    { id: "old", name: "Old", markdown: "See [Target](#session=target) for context.", updatedAt: 1 },
    { id: "new", name: "New", markdown: "# Related\n\nReview [Target](#session=target) today.", updatedAt: 2 },
    { id: "other", name: "Other", markdown: "No link", updatedAt: 3 },
  ], "target");
  assert.deepEqual(backlinks.map((item) => item.documentId), ["new", "old"]);
  assert.equal(backlinks[0].excerpt, "Review Target today.");
});
