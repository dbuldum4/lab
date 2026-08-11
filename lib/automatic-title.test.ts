import assert from "node:assert/strict";
import test from "node:test";
import { automaticTitleFromMarkdown } from "./automatic-title.ts";

test("prefers the first heading over earlier prose", () => {
  assert.equal(automaticTitleFromMarkdown("preface\n\n## **Project** plan"), "Project plan");
});
test("uses the first readable line when no heading exists", () => {
  assert.equal(automaticTitleFromMarkdown("> [!NOTE]\n> Keep [this](https://example.com) local."), "Keep this local.");
});

test("ignores fenced code and returns Untitled for empty notes", () => {
  assert.equal(automaticTitleFromMarkdown("```md\n# Not a title\n```\n\nActual text"), "Actual text");
  assert.equal(automaticTitleFromMarkdown(" \n\n"), "Untitled");
});

test("requires a matching fence type and length with a valid closing line", () => {
  assert.equal(
    automaticTitleFromMarkdown("````md\n# Not a title\n```\n# Still code\n````\n# Actual title"),
    "Actual title",
  );
  assert.equal(
    automaticTitleFromMarkdown("~~~md\n# Not a title\n```\n# Still code\n~~~\n# Actual title"),
    "Actual title",
  );
  assert.equal(
    automaticTitleFromMarkdown("```md\n# Not a title\n``` with text\n# Still code"),
    "Untitled",
  );
});

test("uses summary text without HTML wrapper tags", () => {
  assert.equal(
    automaticTitleFromMarkdown("<details open>\n<summary>Read **more**</summary>\n\nBody"),
    "Read more",
  );
  assert.equal(
    automaticTitleFromMarkdown("<details open><summary>Read **more**</summary></details>"),
    "Read more",
  );
});
