import assert from "node:assert/strict";
import test from "node:test";
import { activeOutlineIndex, areOutlineItemsEqual, buildOutline } from "./outline.ts";

test("buildOutline preserves heading hierarchy and normalizes labels", () => {
  const outline = buildOutline([
    { level: 1, title: "  Project plan  ", position: 0 },
    { level: 2, title: "Research\nnotes", position: 12 },
    { level: 3, title: "   ", position: 24 },
    { level: 2, title: "Launch", position: 36 },
  ]);

  assert.deepEqual(outline, [
    { id: "heading-0", level: 1, title: "Project plan", position: 0, depth: 0 },
    { id: "heading-1", level: 2, title: "Research notes", position: 12, depth: 1 },
    { id: "heading-2", level: 3, title: "Untitled section", position: 24, depth: 2 },
    { id: "heading-3", level: 2, title: "Launch", position: 36, depth: 1 },
  ]);
});

test("activeOutlineIndex tracks the last heading before the cursor", () => {
  const outline = buildOutline([
    { level: 1, title: "First", position: 4 },
    { level: 2, title: "Second", position: 18 },
    { level: 1, title: "Third", position: 42 },
  ]);

  assert.equal(activeOutlineIndex(outline, 0), -1);
  assert.equal(activeOutlineIndex(outline, 4), 0);
  assert.equal(activeOutlineIndex(outline, 31), 1);
  assert.equal(activeOutlineIndex(outline, 80), 2);
});

test("areOutlineItemsEqual allows cached outline arrays to be reused", () => {
  const outline = buildOutline([
    { level: 1, title: "First", position: 4 },
    { level: 2, title: "Second", position: 18 },
  ]);

  assert.equal(areOutlineItemsEqual(outline, outline.map((item) => ({ ...item }))), true);
  assert.equal(
    areOutlineItemsEqual(outline, buildOutline([
      { level: 1, title: "First", position: 4 },
      { level: 2, title: "Changed", position: 18 },
    ])),
    false,
  );
  assert.equal(
    areOutlineItemsEqual(outline, buildOutline([
      { level: 1, title: "First", position: 4 },
      { level: 2, title: "Second", position: 19 },
    ])),
    false,
  );
});
