import assert from "node:assert/strict";
import test from "node:test";
import { MarkdownManager } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import {
  Callout,
  CollapsibleBody,
  CollapsibleSection,
  CollapsibleSummary,
  normalizeCalloutType,
} from "./editor-blocks.ts";

function manager() {
  return new MarkdownManager({
    extensions: [
      StarterKit,
      Callout,
      CollapsibleSummary,
      CollapsibleBody,
      CollapsibleSection,
    ],
  });
}

test("normalizeCalloutType allowlists portable alert kinds", () => {
  assert.equal(normalizeCalloutType("TIP"), "tip");
  assert.equal(normalizeCalloutType("warning"), "warning");
  assert.equal(normalizeCalloutType("caution"), "note");
  assert.equal(normalizeCalloutType({ toString: () => "tip" }), "note");
});

test("callouts parse and serialize GitHub alert blockquotes", () => {
  const markdown = [
    "> [!TIP]",
    "> **Keep** the portable syntax.",
    ">",
    "> - First",
    "> - Second",
  ].join("\n");
  const markdownManager = manager();
  const document = markdownManager.parse(markdown);

  assert.equal(document.content?.length, 1);
  const callout = document.content?.[0];
  assert.equal(callout?.type, "callout");
  assert.equal(callout?.attrs?.type, "tip");
  assert.deepEqual(callout?.content?.map((child) => child.type), ["paragraph", "bulletList"]);
  assert.equal(callout?.content?.[0]?.content?.[0]?.marks?.[0]?.type, "bold");
  assert.equal(markdownManager.serialize(document), markdown);
});

test("an empty callout remains a schema-valid editable block", () => {
  const markdownManager = manager();
  const document = markdownManager.parse("> [!IMPORTANT]");
  const callout = document.content?.[0];

  assert.equal(callout?.type, "callout");
  assert.equal(callout?.attrs?.type, "important");
  assert.deepEqual(callout?.content?.map((child) => child.type), ["paragraph"]);
  assert.equal(markdownManager.serialize(document), "> [!IMPORTANT]\n>");
});

test("collapsible sections round-trip summary marks, body blocks, and open state", () => {
  const markdown = [
    "<details open>",
    "<summary>Read **more**</summary>",
    "",
    "A body with [a link](https://example.com).",
    "",
    "- One",
    "- Two",
    "",
    "</details>",
  ].join("\n");
  const markdownManager = manager();
  const document = markdownManager.parse(markdown);
  const details = document.content?.[0];

  assert.equal(document.content?.length, 1);
  assert.equal(details?.type, "collapsibleSection");
  assert.equal(details?.attrs?.open, true);
  assert.deepEqual(details?.content?.map((child) => child.type), [
    "collapsibleSummary",
    "collapsibleBody",
  ]);
  assert.equal(details?.content?.[0]?.content?.[1]?.marks?.[0]?.type, "bold");
  assert.deepEqual(details?.content?.[1]?.content?.map((child) => child.type), [
    "paragraph",
    "bulletList",
  ]);
  assert.equal(markdownManager.serialize(document), markdown);
});

test("details parsing ignores a closing tag inside a fenced code block", () => {
  const markdown = [
    "<details>",
    "<summary>Example</summary>",
    "",
    "```html",
    "</details>",
    "```",
    "",
    "Still in the body.",
    "",
    "</details>",
  ].join("\n");
  const markdownManager = manager();
  const document = markdownManager.parse(markdown);
  const details = document.content?.[0];

  assert.equal(document.content?.length, 1);
  assert.equal(details?.type, "collapsibleSection");
  assert.deepEqual(details?.content?.[1]?.content?.map((child) => child.type), [
    "codeBlock",
    "paragraph",
  ]);
  assert.equal(markdownManager.serialize(document), markdown);
});

test("details tokenizer rejects imported attributes outside the open allowlist", () => {
  const markdownManager = manager();
  const document = markdownManager.parse([
    '<details onclick="alert(1)">',
    "<summary>Unsafe attributes</summary>",
    "",
    "Body",
    "",
    "</details>",
  ].join("\n"));

  assert.equal(
    document.content?.some((node) => node.type === "collapsibleSection"),
    false,
  );
});
