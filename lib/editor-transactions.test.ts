import assert from "node:assert/strict";
import test from "node:test";
import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { transactionContainsDollar, transactionTouchesHeading } from "./editor-transactions.ts";

function testSchema() {
  return new Schema({
    nodes: {
      doc: { content: "block+" },
      paragraph: { content: "inline*", group: "block" },
      heading: { attrs: { level: { default: 1 } }, content: "inline*", group: "block" },
      text: { group: "inline" },
    },
  });
}

test("heading detection uses each step's intermediate document", () => {
  const schema = testSchema();
  const firstParagraph = schema.nodes.paragraph.create(null, schema.text("before"));
  const doc = schema.nodes.doc.create(null, [
    firstParagraph,
    schema.nodes.heading.create({ level: 1 }, schema.text("heading")),
    schema.nodes.paragraph.create(null, schema.text("after")),
  ]);
  const state = EditorState.create({ schema, doc });
  const headingPosition = firstParagraph.nodeSize;
  const transaction = state.tr
    .insertText("1234567", 1, 1)
    .setNodeMarkup(headingPosition + 7, schema.nodes.heading, { level: 2 })
    .delete(1, 8);

  assert.equal(transaction.doc.child(1).attrs.level, 2);
  assert.equal(transactionTouchesHeading(transaction), true);
});

test("heading detection catches heading attribute changes without a range", () => {
  const schema = testSchema();
  const doc = schema.nodes.doc.create(null, [
    schema.nodes.heading.create({ level: 1 }, schema.text("heading")),
  ]);
  const state = EditorState.create({ schema, doc });
  const transaction = state.tr.setNodeMarkup(0, schema.nodes.heading, { level: 2 });

  assert.equal(transaction.doc.firstChild?.attrs.level, 2);
  assert.equal(transactionTouchesHeading(transaction), true);
});

test("dollar detection catches delimiters joined by a deletion", () => {
  const schema = testSchema();
  const doc = schema.nodes.doc.create(null, [
    schema.nodes.paragraph.create(null, schema.text("$a$x$$")),
  ]);
  const state = EditorState.create({ schema, doc });
  const transaction = state.tr.delete(2, 3);

  assert.equal(transaction.doc.textContent, "$$x$$");
  assert.equal(transactionContainsDollar(transaction), true);
});
