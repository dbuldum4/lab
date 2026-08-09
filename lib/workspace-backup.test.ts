import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkspaceBackup, parseWorkspaceBackup } from "./workspace-backup.ts";

test("buildWorkspaceBackup preserves session order and content", async () => {
  const sessions = [
    { id: "a", name: "Alpha", createdAt: 1, updatedAt: 3 },
    { id: "b", name: "Beta", createdAt: 2, updatedAt: 4 },
  ];
  const content = new Map([["a", "# A"], ["b", "# B"]]);
  const backup = await buildWorkspaceBackup(sessions, async (id) => content.get(id) ?? "", 10);
  assert.equal(backup.format, "lab-workspace");
  assert.equal(backup.version, 1);
  assert.equal(backup.exportedAt, 10);
  assert.deepEqual(backup.documents.map((document) => document.name), ["Alpha", "Beta"]);
  assert.deepEqual(backup.documents.map((document) => document.markdown), ["# A", "# B"]);
});

test("parseWorkspaceBackup validates and normalizes a v1 bundle", () => {
  const backup = parseWorkspaceBackup(JSON.stringify({
    format: "lab-workspace",
    version: 1,
    exportedAt: 42,
    documents: [{ name: "  My   note  ", createdAt: 1, updatedAt: 2, markdown: "hello" }],
  }));
  assert.equal(backup.documents[0].name, "My note");
  assert.equal(backup.documents[0].markdown, "hello");
});

test("parseWorkspaceBackup rejects unrelated JSON", () => {
  assert.throws(() => parseWorkspaceBackup('{"hello":"world"}'), /supported lab workspace backup/);
});
