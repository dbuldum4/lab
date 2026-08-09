import assert from "node:assert/strict";
import test from "node:test";
import { listDocumentVersions, recordDocumentVersion } from "./version-history.ts";

class MemoryStorage implements Storage {
  #values = new Map<string, string>();
  get length() { return this.#values.size; }
  clear() { this.#values.clear(); }
  getItem(key: string) { return this.#values.get(key) ?? null; }
  key(index: number) { return [...this.#values.keys()][index] ?? null; }
  removeItem(key: string) { this.#values.delete(key); }
  setItem(key: string, value: string) { this.#values.set(key, value); }
}

function withStorage(run: () => void) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: new MemoryStorage() });
  try {
    run();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
}

test("history checkpoints are deduplicated and rate limited", () => withStorage(() => {
  assert.equal(recordDocumentVersion("default", "first", { now: 100, force: true }), true);
  assert.equal(recordDocumentVersion("default", "second", { now: 200 }), true);
  assert.deepEqual(listDocumentVersions("default").map((version) => version.markdown), ["first"]);

  assert.equal(recordDocumentVersion("default", "second", { now: 120_101 }), true);
  assert.deepEqual(listDocumentVersions("default").map((version) => version.markdown), ["second", "first"]);
  assert.equal(recordDocumentVersion("default", "second", { now: 240_500 }), true);
  assert.equal(listDocumentVersions("default").length, 2);
}));

test("forced snapshots preserve the current state before a restore", () => withStorage(() => {
  recordDocumentVersion("abc", "before", { now: 1, force: true });
  recordDocumentVersion("abc", "current", { now: 2, force: true });
  assert.deepEqual(listDocumentVersions("abc").map((version) => version.markdown), ["current", "before"]);
}));

test("history is capped at twenty checkpoints", () => withStorage(() => {
  for (let index = 0; index < 25; index += 1) {
    assert.equal(recordDocumentVersion("default", `version ${index}`, { now: index + 1, force: true }), true);
  }
  const versions = listDocumentVersions("default");
  assert.equal(versions.length, 20);
  assert.equal(versions[0].markdown, "version 24");
  assert.equal(versions.at(-1)?.markdown, "version 5");
}));

test("oversized snapshots fail closed without evicting existing history", () => withStorage(() => {
  recordDocumentVersion("default", "safe", { now: 1, force: true });
  assert.equal(recordDocumentVersion("default", "x".repeat(500_001), { now: 2, force: true }), false);
  assert.deepEqual(listDocumentVersions("default").map((version) => version.markdown), ["safe"]);
}));
