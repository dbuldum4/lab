import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import {
  clearVersions,
  getVersion,
  listVersions,
  recordVersion,
  removeVersion,
  VERSION_HISTORY_MAX_BYTES,
  VERSION_HISTORY_MAX_ENTRIES,
  VERSION_HISTORY_MAX_MARKDOWN_BYTES,
} from "./version-history.ts";

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

class RacingStorage extends MemoryStorage {
  raceAfterEntry: { aggregate: string; entry: string } | null = null;
  private raced = false;

  override setItem(storageKey: string, value: string) {
    super.setItem(storageKey, value);
    if (
      storageKey.startsWith("lab.version-history.v1.entry.alpha.")
      && !this.raced
      && this.raceAfterEntry
    ) {
      this.raced = true;
      super.setItem(key("alpha"), this.raceAfterEntry.aggregate);
      super.setItem(
        "lab.version-history.v1.entry.alpha.v2-peer",
        this.raceAfterEntry.entry,
      );
    }
  }
}

const key = (documentId: string) => `lab.version-history.v1.${documentId}`;
let originalStorage: PropertyDescriptor | undefined;

beforeEach(() => {
  originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: new MemoryStorage(),
  });
});

afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

test("records unique states per document and lists them deterministically newest first", () => {
  const first = recordVersion("alpha", "first", 100);
  const laterTieA = recordVersion("alpha", "tie a", 200);
  const laterTieB = recordVersion("alpha", "tie b", 200);
  const other = recordVersion("beta", "other", 300);

  assert.ok(first);
  assert.ok(laterTieA);
  assert.ok(laterTieB);
  assert.ok(other);
  assert.match(first.id, /^v[a-z0-9_-]+$/);
  assert.equal(recordVersion("alpha", "first", 400), null);
  assert.deepEqual(
    listVersions("alpha").map(({ id, createdAt, markdown }) => ({ id, createdAt, markdown })),
    [laterTieA, laterTieB].sort((left, right) => right.id.localeCompare(left.id)).concat(first),
  );
  assert.deepEqual(listVersions("beta"), [other]);
});

test("per-entry records survive a later aggregate overwrite by another tab", () => {
  const racing = new RacingStorage();
  racing.raceAfterEntry = {
    aggregate: JSON.stringify({
      schemaVersion: 1,
      documentId: "alpha",
      entries: [{ id: "v2-peer", createdAt: 2, markdown: "from peer" }],
    }),
    entry: JSON.stringify({
      documentId: "alpha",
      recordedAt: 2,
      entry: { id: "v2-peer", createdAt: 2, markdown: "from peer" },
    }),
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: racing,
  });

  const recorded = recordVersion("alpha", "from this tab", 1);

  assert.ok(recorded);
  assert.deepEqual(listVersions("alpha").map((entry) => entry.markdown), [
    "from peer",
    "from this tab",
  ]);
});

test("legacy aggregate history remains readable and migrates on removal", () => {
  const legacy = {
    schemaVersion: 1,
    documentId: "alpha",
    entries: [
      { id: "v1-first", createdAt: 1, markdown: "first" },
      { id: "v2-second", createdAt: 2, markdown: "second" },
    ],
  };
  localStorage.setItem(key("alpha"), JSON.stringify(legacy));

  assert.deepEqual(listVersions("alpha").map((entry) => entry.markdown), ["second", "first"]);
  assert.equal(removeVersion("alpha", "v1-first"), true);
  assert.deepEqual(listVersions("alpha").map((entry) => entry.markdown), ["second"]);
  assert.ok(localStorage.getItem("lab.version-history.v1.entry.alpha.v2-second"));
});

test("returned entries cannot mutate stored history", () => {
  const recorded = recordVersion("alpha", "original", 1);
  assert.ok(recorded);
  recorded.markdown = "changed return value";

  const listed = listVersions("alpha");
  listed[0].markdown = "changed list value";

  assert.equal(getVersion("alpha", recorded.id)?.markdown, "original");
});

test("get, remove, and clear are scoped and explicit", () => {
  const first = recordVersion("alpha", "first", 1);
  const second = recordVersion("alpha", "second", 2);
  recordVersion("beta", "other", 3);
  assert.ok(first);
  assert.ok(second);

  assert.deepEqual(getVersion("alpha", first.id), first);
  assert.equal(getVersion("beta", first.id), null);
  assert.equal(removeVersion("alpha", "vnot-found"), false);
  assert.equal(removeVersion("alpha", first.id), true);
  assert.equal(getVersion("alpha", first.id), null);
  assert.deepEqual(listVersions("alpha"), [second]);
  assert.equal(clearVersions("alpha"), true);
  assert.deepEqual(listVersions("alpha"), []);
  assert.equal(localStorage.getItem(key("alpha")), null);
  assert.equal(listVersions("beta").length, 1);
});

test("keeps only the newest bounded number of entries", () => {
  for (let index = 0; index < VERSION_HISTORY_MAX_ENTRIES + 5; index += 1) {
    assert.ok(recordVersion("alpha", `state ${index}`, index));
  }

  const versions = listVersions("alpha");
  assert.equal(versions.length, VERSION_HISTORY_MAX_ENTRIES);
  assert.equal(versions[0].markdown, `state ${VERSION_HISTORY_MAX_ENTRIES + 4}`);
  assert.equal(versions.at(-1)?.markdown, "state 5");
});

test("prunes oldest snapshots to keep the serialized history under its byte cap", () => {
  const block = "x".repeat(Math.floor(VERSION_HISTORY_MAX_BYTES / 3));
  assert.ok(recordVersion("alpha", `${block}a`, 1));
  assert.ok(recordVersion("alpha", `${block}b`, 2));
  assert.ok(recordVersion("alpha", `${block}c`, 3));
  assert.ok(recordVersion("alpha", `${block}d`, 4));

  const raw = localStorage.getItem(key("alpha"));
  assert.ok(raw);
  assert.ok(new TextEncoder().encode(raw).byteLength <= VERSION_HISTORY_MAX_BYTES);
  assert.deepEqual(listVersions("alpha").map((entry) => entry.createdAt), [4, 3]);
});

test("bounds total retained history storage, including per-entry payloads", () => {
  const block = "x".repeat(120_000);
  for (let index = 0; index < 12; index += 1) {
    assert.ok(recordVersion("alpha", `${block}${index}`, index + 1));
  }

  const values = (localStorage as unknown as MemoryStorage).values;
  const totalBytes = [...values].reduce((total, [storageKey, value]) => (
    total
    + new TextEncoder().encode(storageKey).byteLength
    + new TextEncoder().encode(value).byteLength
  ), 0);
  assert.ok(totalBytes <= VERSION_HISTORY_MAX_BYTES);
  assert.equal(listVersions("alpha").length < 12, true);
});

test("rejects oversized snapshots and invalid public identifiers without writing", () => {
  assert.equal(
    recordVersion("alpha", "x".repeat(VERSION_HISTORY_MAX_MARKDOWN_BYTES + 1), 1),
    null,
  );
  assert.equal(recordVersion("../alpha", "unsafe", 1), null);
  assert.equal(recordVersion("alpha", "negative timestamp", -1), null);
  assert.equal(recordVersion("alpha", "fractional timestamp", 1.5), null);
  assert.deepEqual(listVersions("../alpha"), []);
  assert.equal(getVersion("alpha", "../../unsafe"), null);
  assert.equal(removeVersion("alpha", "../../unsafe"), false);
  assert.equal(clearVersions("../alpha"), false);
  assert.equal(localStorage.length, 0);
});

test("corrupt and unsupported schemas fail closed until explicitly cleared", () => {
  for (const raw of [
    "not json",
    JSON.stringify({ schemaVersion: 2, documentId: "alpha", entries: [] }),
    JSON.stringify({ schemaVersion: 1, documentId: "other", entries: [] }),
    JSON.stringify({
      schemaVersion: 1,
      documentId: "alpha",
      entries: [{ id: "unsafe/id", createdAt: 1, markdown: "text" }],
    }),
  ]) {
    localStorage.setItem(key("alpha"), raw);
    assert.deepEqual(listVersions("alpha"), []);
    assert.equal(recordVersion("alpha", "replacement", 10), null);
    assert.equal(localStorage.getItem(key("alpha")), raw);
  }

  assert.equal(clearVersions("alpha"), true);
  assert.ok(recordVersion("alpha", "replacement", 10));
});

test("storage access failures are contained", () => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() { throw new Error("blocked"); },
  });

  assert.equal(recordVersion("alpha", "text", 1), null);
  assert.deepEqual(listVersions("alpha"), []);
  assert.equal(getVersion("alpha", "v1-abc"), null);
  assert.equal(removeVersion("alpha", "v1-abc"), false);
  assert.equal(clearVersions("alpha"), false);
});

test("write and removal failures leave safe API results", () => {
  const throwingStorage = {
    get length() { return 0; },
    clear() { throw new Error("blocked"); },
    getItem() { return null; },
    key() { return null; },
    removeItem() { throw new Error("blocked"); },
    setItem() { throw new Error("quota"); },
  } satisfies Storage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: throwingStorage,
  });

  assert.equal(recordVersion("alpha", "text", 1), null);
  assert.equal(clearVersions("alpha"), false);
});
