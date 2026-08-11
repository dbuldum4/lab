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

test("finds backlinks with useful excerpts and newest first", () => {
  const backlinks = findBacklinks([
    { id: "old", name: "Old", markdown: "See [Target](#session=target) for context.", updatedAt: 1 },
    { id: "new", name: "New", markdown: "# Related\n\nReview [Target](#session=target) today.", updatedAt: 2 },
    { id: "other", name: "Other", markdown: "No link", updatedAt: 3 },
  ], "target");
  assert.deepEqual(backlinks.map((item) => item.documentId), ["new", "old"]);
  assert.equal(backlinks[0].excerpt, "Review Target today.");
});
