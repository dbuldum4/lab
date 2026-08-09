import assert from "node:assert/strict";
import test from "node:test";
import { searchWorkspace } from "./workspace-search.ts";

const sessions = [
  { id: "a", name: "Project Alpha", createdAt: 1, updatedAt: 10 },
  { id: "b", name: "Research", createdAt: 2, updatedAt: 20 },
  { id: "c", name: "Alpha", createdAt: 3, updatedAt: 5 },
];

const markdown = new Map([
  ["a", "nothing special"],
  ["b", "This note contains alpha in its body."],
  ["c", "exact title match"],
]);

test("searchWorkspace ranks exact and prefix name matches ahead of content", async () => {
  const results = await searchWorkspace(sessions, "alpha", async (id) => markdown.get(id) ?? "");
  assert.deepEqual(results.map((result) => result.session.id), ["c", "a", "b"]);
  assert.match(results[2].snippet, /alpha/i);
});

test("searchWorkspace returns recent sessions for an empty query without reading content", async () => {
  let reads = 0;
  const results = await searchWorkspace(sessions, "", async () => {
    reads += 1;
    return "";
  });
  assert.equal(reads, 0);
  assert.deepEqual(results.map((result) => result.session.id), ["a", "b", "c"]);
});

test("searchWorkspace tolerates one inaccessible document", async () => {
  const results = await searchWorkspace(sessions, "project", async (id) => {
    if (id === "a") throw new Error("unavailable");
    return markdown.get(id) ?? "";
  });
  assert.equal(results[0].session.id, "a");
  assert.equal(results[0].snippet, "Session name match");
});
