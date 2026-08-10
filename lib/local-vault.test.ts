import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test, { afterEach, beforeEach } from "node:test";
import {
  compareSnapshotOrder,
  deleteLocalDocument,
  inspectLocalStorage,
  isLocalDocumentDeleted,
  listLocalRecoveryDrafts,
  loadLocalDocument,
  readVerifiedLocalDocument,
  resetLocalVaultStateForTests,
  sameSnapshot,
  saveLocalDocument,
  selectCurrentSnapshot,
  setLocalDocumentScope,
  shouldAcceptSnapshot,
  stageLocalDocument,
  type LocalSnapshot,
} from "./local-vault.ts";

type FaultConfig = {
  open: "error" | "blocked" | null;
  readKeys: Set<IDBValidKey>;
  putKeys: Set<IDBValidKey>;
  quotaOnWrite: boolean;
  abortOnWrite: boolean;
};

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  throwOnGet = false;
  throwOnSet = false;
  quotaOnSet = false;
  throwOnRemove = false;
  throwOnLength = false;
  throwOnKey = false;

  get length() {
    if (this.throwOnLength) throw new Error("Storage enumeration failed");
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    if (this.throwOnGet) throw new Error("Storage read failed");
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    if (this.throwOnKey) throw new Error("Storage key lookup failed");
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    if (this.throwOnRemove) throw new Error("Storage remove failed");
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    if (this.throwOnSet) {
      throw (this.quotaOnSet
        ? new DOMException("Storage quota exceeded", "QuotaExceededError")
        : new Error("Storage write failed"));
    }
    this.values.set(key, value);
  }
}

function cloneValue<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

type FakeIndexedDb = {
  factory: IDBFactory;
  faults: FaultConfig;
  stores: Map<string, Map<IDBValidKey, unknown>>;
  read: (key: IDBValidKey) => unknown;
  write: (key: IDBValidKey, value: unknown) => void;
  remove: (key: IDBValidKey) => void;
};

function createFakeIndexedDb(): FakeIndexedDb {
  const stores = new Map<string, Map<IDBValidKey, unknown>>();
  const faults: FaultConfig = {
    open: null,
    readKeys: new Set(),
    putKeys: new Set(),
    quotaOnWrite: false,
    abortOnWrite: false,
  };
  let upgraded = false;

  const database = {
    get objectStoreNames() {
      return { contains: (name: string) => stores.has(name) } as DOMStringList;
    },
    createObjectStore(name: string) {
      const store = new Map<IDBValidKey, unknown>();
      stores.set(name, store);
      return { name } as unknown as IDBObjectStore;
    },
    transaction(name: string) {
      const store = stores.get(name);
      if (!store) throw new Error(`Missing fake store: ${name}`);
      let pending = 0;
      let completionQueued = false;
      let settled = false;
      const transactionState = {
        error: null as DOMException | null,
        oncomplete: null as ((event: Event) => void) | null,
        onerror: null as ((event: Event) => void) | null,
        onabort: null as ((event: Event) => void) | null,
        objectStore: () => ({
          get(key: IDBValidKey) {
            pending += 1;
            const requestState = {
              result: undefined as unknown,
              error: null as DOMException | null,
              onsuccess: null as ((event: Event) => void) | null,
              onerror: null as ((event: Event) => void) | null,
            };
            const request = requestState as unknown as IDBRequest;
            setTimeout(() => {
              if (settled) return;
              pending -= 1;
              if (faults.readKeys.has(key)) {
                requestState.error = new DOMException("Fake request failure", "UnknownError");
                requestState.onerror?.({} as Event);
                settled = true;
                transactionState.error = requestState.error;
                queueMicrotask(() => transactionState.onerror?.({} as Event));
                return;
              }
              requestState.result = cloneValue(store.get(key));
              requestState.onsuccess?.({} as Event);
              maybeComplete();
            }, 0);
            return request;
          },
          put(value: unknown, key: IDBValidKey) {
            pending += 1;
            const requestState = {
              result: key,
              error: null as DOMException | null,
              onsuccess: null as ((event: Event) => void) | null,
              onerror: null as ((event: Event) => void) | null,
            };
            const request = requestState as unknown as IDBRequest;
            setTimeout(() => {
              if (settled) return;
              pending -= 1;
              if (faults.abortOnWrite || faults.putKeys.has(key)) {
                requestState.error = new DOMException(
                  faults.quotaOnWrite ? "Fake quota exceeded" : "Fake put failure",
                  faults.quotaOnWrite ? "QuotaExceededError" : "UnknownError",
                );
                requestState.onerror?.({} as Event);
                settled = true;
                transactionState.error = requestState.error;
                queueMicrotask(() => transactionState.onabort?.({} as Event));
                return;
              }
              store.set(key, cloneValue(value));
              requestState.onsuccess?.({} as Event);
              maybeComplete();
            }, 0);
            return request;
          },
          delete(key: IDBValidKey) {
            pending += 1;
            const requestState = {
              result: undefined as unknown,
              error: null as DOMException | null,
              onsuccess: null as ((event: Event) => void) | null,
              onerror: null as ((event: Event) => void) | null,
            };
            const request = requestState as unknown as IDBRequest;
            setTimeout(() => {
              if (settled) return;
              pending -= 1;
              store.delete(key);
              requestState.onsuccess?.({} as Event);
              maybeComplete();
            }, 0);
            return request;
          },
        }),
      };
      const transaction = transactionState as unknown as IDBTransaction;

      const maybeComplete = () => {
        if (pending !== 0 || completionQueued || settled) return;
        completionQueued = true;
        queueMicrotask(() => {
          if (settled) return;
          settled = true;
          transactionState.oncomplete?.({} as Event);
        });
      };
      return transaction;
    },
    close() {},
  } as unknown as IDBDatabase;

  const factory = {
    open() {
      const requestState = {
        result: database,
        error: null as DOMException | null,
        onupgradeneeded: null as ((event: IDBVersionChangeEvent) => void) | null,
        onsuccess: null as ((event: Event) => void) | null,
        onerror: null as ((event: Event) => void) | null,
        onblocked: null as ((event: Event) => void) | null,
      };
      const request = requestState as unknown as IDBOpenDBRequest;
      setTimeout(() => {
        if (faults.open === "blocked") {
          request.onblocked?.({} as IDBVersionChangeEvent);
          return;
        }
        if (faults.open === "error") {
          requestState.error = new DOMException("Fake open failure", "UnknownError");
          request.onerror?.({} as Event);
          return;
        }
        if (!upgraded) {
          upgraded = true;
          requestState.onupgradeneeded?.({} as IDBVersionChangeEvent);
        }
        request.onsuccess?.({} as Event);
      }, 0);
      return request;
    },
  } as unknown as IDBFactory;

  const store = () => stores.get("documents") ?? new Map<IDBValidKey, unknown>();
  return {
    factory,
    faults,
    stores,
    read: (key) => cloneValue(store().get(key)),
    write: (key, value) => {
      if (!stores.has("documents")) stores.set("documents", new Map());
      stores.get("documents")?.set(key, cloneValue(value));
    },
    remove: (key) => stores.get("documents")?.delete(key),
  };
}

type OpfsHarness = {
  files: Map<string, string>;
  faults: {
    root: boolean;
    read: boolean;
    write: boolean;
    close: boolean;
    quotaWrite: boolean;
    quotaClose: boolean;
  };
  storage: StorageManager;
};

function createOpfsHarness(persisted = true): OpfsHarness {
  const files = new Map<string, string>();
  const faults = {
    root: false,
    read: false,
    write: false,
    close: false,
    quotaWrite: false,
    quotaClose: false,
  };
  const root = {
    getFileHandle: async (name: string, options?: { create?: boolean }) => {
      if (!files.has(name) && !options?.create) throw new DOMException("Missing file", "NotFoundError");
      if (!files.has(name)) files.set(name, "");
      return {
        getFile: async () => {
          if (faults.read) throw new Error("OPFS read failed");
          return { text: async () => files.get(name) ?? "" };
        },
        createWritable: async () => {
          if (faults.write) {
            throw (faults.quotaWrite
              ? new DOMException("OPFS quota exceeded", "QuotaExceededError")
              : new Error("OPFS write failed"));
          }
          let next = files.get(name) ?? "";
          return {
            write: async (value: string) => {
              next = value;
            },
            close: async () => {
              if (faults.close) {
                throw (faults.quotaClose
                  ? new DOMException("OPFS quota exceeded", "QuotaExceededError")
                  : new Error("OPFS close failed"));
              }
              files.set(name, next);
            },
          };
        },
      } as unknown as FileSystemFileHandle;
    },
    removeEntry: async (name: string) => {
      if (!files.has(name)) throw new DOMException("Missing file", "NotFoundError");
      files.delete(name);
    },
  } as unknown as FileSystemDirectoryHandle;
  const storage = {
    persisted: async () => persisted,
    persist: async () => persisted,
    getDirectory: async () => {
      if (faults.root) throw new Error("OPFS root failed");
      return root;
    },
  } as unknown as StorageManager;
  return { files, faults, storage };
}

type TestEnvironment = {
  local: MemoryStorage;
  session: MemoryStorage;
  idb: FakeIndexedDb | null;
  opfs: OpfsHarness | null;
  restore: () => void;
};

type EnvironmentOptions = {
  browser?: boolean;
  indexedDb?: boolean;
  opfs?: boolean;
  persisted?: boolean;
  locks?: "success" | "reject" | null;
  crypto?: "webcrypto" | "missing";
};

function installEnvironment(options: EnvironmentOptions = {}): TestEnvironment {
  const names = ["localStorage", "sessionStorage", "indexedDB", "navigator", "window", "crypto"] as const;
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const name of names) descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const idb = options.indexedDb ? createFakeIndexedDb() : null;
  const opfs = options.opfs ? createOpfsHarness(options.persisted ?? true) : null;
  const locks = options.locks === "success"
    ? { request: async (_name: string, _options: unknown, callback: () => Promise<unknown>) => callback() }
    : options.locks === "reject"
      ? { request: async () => { throw new Error("Web Locks rejected"); } }
      : undefined;
  const navigatorValue = (opfs || locks || options.browser)
    ? { storage: opfs?.storage, locks }
    : undefined;

  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: local });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: session });
  if (idb) Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: idb.factory });
  else Reflect.deleteProperty(globalThis, "indexedDB");
  if (navigatorValue) Object.defineProperty(globalThis, "navigator", { configurable: true, value: navigatorValue });
  else Reflect.deleteProperty(globalThis, "navigator");
  if (options.browser) Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  else Reflect.deleteProperty(globalThis, "window");
  if (options.crypto === "missing") Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
  else Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });

  return {
    local,
    session,
    idb,
    opfs,
    restore() {
      for (const name of names) {
        const descriptor = descriptors.get(name);
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

let environment: TestEnvironment;

beforeEach(() => {
  resetLocalVaultStateForTests();
  environment = installEnvironment();
});

afterEach(() => {
  environment.restore();
  resetLocalVaultStateForTests();
});

function snapshot(markdown: string, updatedAt: number, checksum = markdown): LocalSnapshot {
  return { markdown, updatedAt, checksum, version: 1 };
}

async function legacyChecksum(markdown: string) {
  const digest = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(markdown));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function pendingChecksum(markdown: string, updatedAt: number) {
  const value = JSON.stringify(["lab.pending.v2", updatedAt, markdown]);
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function localSnapshot() {
  const raw = environment.local.values.get("lab.document.v1");
  return raw ? JSON.parse(raw) as LocalSnapshot : null;
}

function switchEnvironment(options: EnvironmentOptions) {
  environment.restore();
  resetLocalVaultStateForTests();
  environment = installEnvironment(options);
}

test("snapshot ordering is total and deterministic", () => {
  const cases: Array<[LocalSnapshot, LocalSnapshot, number]> = [
    [snapshot("old", 1, "z"), snapshot("new", 2, "a"), -1],
    [snapshot("alpha", 10, "aaa"), snapshot("beta", 10, "bbb"), -1],
    [snapshot("same", 10, "same"), snapshot("same", 10, "same"), 0],
    [snapshot("beta", 10, "bbb"), snapshot("alpha", 10, "aaa"), 1],
  ];
  for (const [left, right, expected] of cases) assert.equal(Math.sign(compareSnapshotOrder(left, right)), expected);
  assert.equal(selectCurrentSnapshot([cases[0][0], cases[1][0], cases[3][0]]), cases[3][0]);
});

test("replica equality and acceptance require matching metadata", () => {
  const current = snapshot("note", 20, "digest");
  assert.equal(sameSnapshot(current, snapshot("note", 20, "digest")), true);
  assert.equal(sameSnapshot(current, snapshot("changed", 20, "digest")), false);
  assert.equal(sameSnapshot(current, snapshot("note", 19, "digest")), false);
  assert.equal(shouldAcceptSnapshot(current, snapshot("older", 19, "older")), false);
  assert.equal(shouldAcceptSnapshot(current, snapshot("newer", 21, "newer")), true);
});

test("v1 and v2 integrity cases reject shape and content/timestamp tampering", async () => {
  const markdown = "legacy note";
  const checksum = await legacyChecksum(markdown);
  const cases: Array<{ name: string; value: unknown; expected: string }> = [
    { name: "valid v1", value: { markdown, updatedAt: 10, checksum, version: 1 }, expected: markdown },
    { name: "malformed v1 shape", value: { markdown, updatedAt: 10, checksum, version: 3 }, expected: "" },
    { name: "malformed v2 shape", value: { markdown, updatedAt: 10, checksum: 42, version: 2 }, expected: "" },
    { name: "v1 content tamper", value: { markdown: "tampered", updatedAt: 10, checksum, version: 1 }, expected: "" },
  ];
  for (const current of cases) {
    environment.local.clear();
    environment.local.setItem("lab.document.v1", JSON.stringify(current.value));
    assert.equal(await loadLocalDocument(), current.expected, current.name);
  }

  environment.local.clear();
  await saveLocalDocument("v2 note");
  const valid = localSnapshot();
  assert.ok(valid);
  assert.equal(await loadLocalDocument(), "v2 note");

  for (const tamper of [
    { field: "markdown", value: "changed" },
    { field: "updatedAt", value: (valid?.updatedAt ?? 0) + 100000 },
  ] as const) {
    environment.local.clear();
    const corrupted = { ...valid, [tamper.field]: tamper.value };
    environment.local.setItem("lab.document.v1", JSON.stringify(corrupted));
    assert.equal(await loadLocalDocument(), "", `${tamper.field} tamper`);
  }
});

test("timestamp issuance remains monotonic across equal and backwards clocks", () => {
  const originalNow = Date.now;
  try {
    let now = 1000;
    Date.now = () => now;
    const timestamps: number[] = [];
    for (const next of [1000, 1000, 900]) {
      now = next;
      assert.equal(stageLocalDocument(`note-${next}`), true);
      timestamps.push(JSON.parse(environment.local.values.get("lab.document.pending.v1") ?? "null").updatedAt);
    }
    assert.deepEqual(timestamps, [1000, 1001, 1002]);
  } finally {
    Date.now = originalNow;
  }
});

test("invalid pending metadata cannot future-date a save, while valid and legacy pending records migrate", async () => {
  assert.equal(stageLocalDocument("pending note"), true);
  const pending = JSON.parse(environment.local.values.get("lab.document.pending.v1") ?? "null") as Record<string, unknown>;
  const forgedTimestamp = Number(pending.updatedAt) + 1000000000;
  pending.updatedAt = forgedTimestamp;
  environment.local.setItem("lab.document.pending.v1", JSON.stringify(pending));

  const health = await saveLocalDocument("pending note");
  assert.equal(health.saved, true);
  assert.ok((localSnapshot()?.updatedAt ?? 0) < forgedTimestamp);

  environment.local.clear();
  environment.local.setItem("lab.document.pending.v1", JSON.stringify({ markdown: "legacy draft", updatedAt: 1, version: 1 }));
  assert.equal(await loadLocalDocument(), "legacy draft");
});

test("missing, stale, and corrupt replicas self-heal to three agreeing copies", async () => {
  switchEnvironment({ browser: true, indexedDb: true, opfs: true, locks: null });
  await saveLocalDocument("repaired note");
  assert.ok(environment.idb && environment.opfs);

  environment.local.removeItem("lab.document.v1");
  environment.opfs.files.delete("lab.md.snapshot");
  const current = environment.idb?.read("current") as LocalSnapshot;
  environment.idb?.write("current", { ...current, updatedAt: current.updatedAt + 999999 });

  assert.equal(await loadLocalDocument(), "repaired note");
  const health = await inspectLocalStorage();
  assert.equal(health.copies, 3);
  assert.deepEqual(new Set(health.labels), new Set(["localStorage", "IndexedDB", "browser file system"]));
  assert.equal(JSON.parse(environment.local.values.get("lab.document.v1") ?? "null").markdown, "repaired note");
  assert.equal(JSON.parse(environment.opfs.files.get("lab.md.snapshot") ?? "null").markdown, "repaired note");
});

test("each individual replica missing, stale, or corrupt is repaired", async () => {
  const targets = ["localStorage", "IndexedDB", "browser file system"] as const;
  const states = ["missing", "stale", "corrupt"] as const;
  for (const target of targets) {
    for (const state of states) {
      switchEnvironment({ browser: true, indexedDb: true, opfs: true, locks: null });
      await saveLocalDocument("old replica");
      await loadLocalDocument();
      const oldLocal = localSnapshot();
      const oldAuthority = environment.idb?.read("authority");
      const oldCurrent = environment.idb?.read("current");
      const oldOpfs = environment.opfs?.files.get("lab.md.snapshot") ?? null;
      await saveLocalDocument("new replica");
      await loadLocalDocument();
      const newLocal = localSnapshot();
      const newAuthority = environment.idb?.read("authority") as { snapshot: LocalSnapshot };
      const newCurrent = environment.idb?.read("current") as LocalSnapshot;
      const newOpfs = environment.opfs?.files.get("lab.md.snapshot") ?? null;
      assert.ok(oldLocal && oldAuthority && oldCurrent && oldOpfs && newLocal && newAuthority && newCurrent && newOpfs);

      if (target === "localStorage") {
        if (state === "missing") environment.local.removeItem("lab.document.v1");
        if (state === "stale") environment.local.setItem("lab.document.v1", JSON.stringify(oldLocal));
        if (state === "corrupt") environment.local.setItem("lab.document.v1", JSON.stringify({ ...newLocal, updatedAt: newLocal.updatedAt + 999999 }));
      }
      if (target === "IndexedDB") {
        if (state === "missing") {
          environment.idb?.remove("authority");
          environment.idb?.remove("current");
        }
        if (state === "stale") {
          environment.idb?.write("authority", oldAuthority);
          environment.idb?.write("current", oldCurrent);
        }
        if (state === "corrupt") {
          environment.idb?.write("authority", { ...newAuthority, snapshot: { ...newAuthority.snapshot, updatedAt: newAuthority.snapshot.updatedAt + 999999 } });
          environment.idb?.write("current", { ...newCurrent, updatedAt: newCurrent.updatedAt + 999999 });
        }
      }
      if (target === "browser file system") {
        if (state === "missing") environment.opfs?.files.delete("lab.md.snapshot");
        if (state === "stale") environment.opfs?.files.set("lab.md.snapshot", oldOpfs);
        if (state === "corrupt") environment.opfs?.files.set("lab.md.snapshot", "corrupt payload");
      }

      assert.equal(await loadLocalDocument(), "new replica", `${target} ${state}`);
      const health = await inspectLocalStorage();
      assert.equal(health.copies, 3, `${target} ${state}`);
      assert.equal(health.errors.some((error) => error.includes("out of sync")), false, `${target} ${state}`);
    }
  }
});

test("orphaned namespaced drafts are discoverable without deleting another pending record", async () => {
  switchEnvironment({ browser: true, locks: "success" });
  const originalNow = Date.now;
  try {
    Date.now = () => 1_000;
    await saveLocalDocument("durable base");

    Date.now = () => 2_000;
    resetLocalVaultStateForTests();
    assert.equal(stageLocalDocument("live draft"), true);
    const liveKey = [...environment.local.values.keys()].find((key) => key.startsWith("lab.document.pending.v2."));
    const liveRecord = liveKey ? environment.local.values.get(liveKey) : null;
    assert.ok(liveKey && liveRecord);

    Date.now = () => 3_000;
    resetLocalVaultStateForTests();
    assert.equal(stageLocalDocument("orphan winner"), true);
    const orphanKey = [...environment.local.values.entries()]
      .find(([, value]) => JSON.parse(value).markdown === "orphan winner")?.[0];
    assert.ok(orphanKey);

    resetLocalVaultStateForTests();
    assert.equal(await loadLocalDocument(), "orphan winner");
    assert.equal(environment.local.values.has(orphanKey), false);
    assert.equal(environment.local.values.get(liveKey), liveRecord);
  } finally {
    Date.now = originalNow;
  }
});

test("copied session owners cannot make two page realms overwrite the same recovery slot", () => {
  switchEnvironment({ browser: true, locks: "success" });
  environment.session.setItem("lab.document.pending.owner.v1", "copied-owner");
  assert.equal(stageLocalDocument("first tab"), true);

  // Each browser page has its own module realm. Resetting module-local state
  // models the second realm while retaining copied sessionStorage contents.
  resetLocalVaultStateForTests();
  assert.equal(stageLocalDocument("second tab"), true);

  const keys = [...environment.local.values.keys()].filter((key) => key.startsWith("lab.document.pending.v2."));
  assert.equal(keys.length, 2);
  assert.deepEqual(
    new Set(keys.map((key) => JSON.parse(environment.local.values.get(key) ?? "null").markdown)),
    new Set(["first tab", "second tab"]),
  );
});

test("failed durable recovery does not accumulate one pending slot per reload", async () => {
  switchEnvironment({ browser: true, locks: null });
  const originalNow = Date.now;
  try {
    for (let index = 0; index < 12; index += 1) {
      Date.now = () => 10_000 + index;
      resetLocalVaultStateForTests();
      assert.equal(stageLocalDocument(`reload draft ${index}`), true);
      assert.equal(await loadLocalDocument(), `reload draft ${index}`);
    }

    const pending = [...environment.local.values.entries()]
      .filter(([key]) => key.startsWith("lab.document.pending.v2."));
    assert.ok(pending.length <= 8);
    assert.ok(pending.some(([, value]) => JSON.parse(value).markdown === "reload draft 11"));
  } finally {
    Date.now = originalNow;
  }
});

test("verified conflict drafts are recoverable, deduplicated, and bounded", async () => {
  switchEnvironment({ browser: true, indexedDb: true });
  const originalNow = Date.now;
  try {
    Date.now = () => 10_000;
    assert.equal((await saveLocalDocument("durable winner")).saved, true);
    for (let index = 1; index <= 12; index += 1) {
      const markdown = `conflict-${index}`;
      environment.local.setItem(`lab.document.pending.v2.conflict-${index}`, JSON.stringify({
        markdown,
        updatedAt: index,
        checksum: pendingChecksum(markdown, index),
        version: 2,
      }));
    }
    environment.local.setItem("lab.document.pending.v2.duplicate", JSON.stringify({
      markdown: "conflict-12",
      updatedAt: 13,
      checksum: pendingChecksum("conflict-12", 13),
      version: 2,
    }));
    environment.local.setItem("lab.document.pending.v2.represented", JSON.stringify({
      markdown: "durable winner",
      updatedAt: 14,
      checksum: pendingChecksum("durable winner", 14),
      version: 2,
    }));

    assert.equal(await loadLocalDocument(), "durable winner");
    const drafts = await listLocalRecoveryDrafts();
    assert.equal(drafts.length, 8);
    assert.deepEqual(drafts.map((draft) => draft.markdown), [
      "conflict-12",
      "conflict-11",
      "conflict-10",
      "conflict-9",
      "conflict-8",
      "conflict-7",
      "conflict-6",
      "conflict-5",
    ]);
    assert.equal((await inspectLocalStorage()).conflicts, 8);
    const remaining = [...environment.local.values.keys()].filter((key) => key.startsWith("lab.document.pending.v2."));
    assert.equal(remaining.length, 8);
  } finally {
    Date.now = originalNow;
  }
});

test("corrupt IndexedDB authority or current data cannot block a later save", async () => {
  switchEnvironment({ indexedDb: true });
  await saveLocalDocument("initial");
  const authority = environment.idb?.read("authority") as Record<string, unknown>;
  environment.idb?.write("authority", {
    ...authority,
    snapshot: { ...(authority.snapshot as object), updatedAt: 9999999999999 },
  });
  assert.equal((await saveLocalDocument("newer")).saved, true);
  assert.equal(await loadLocalDocument(), "newer");

  environment.idb?.remove("authority");
  const current = environment.idb?.read("current") as LocalSnapshot;
  environment.idb?.write("current", { ...current, updatedAt: 9999999999999 });
  assert.equal((await saveLocalDocument("recovered")).saved, true);
  assert.equal(await loadLocalDocument(), "recovered");
});

test("a verified newer IndexedDB current record outranks an older authority record", async () => {
  switchEnvironment({ indexedDb: true });
  await saveLocalDocument("authority revision");
  const olderAuthority = environment.idb?.read("authority");
  await saveLocalDocument("current revision");
  const newerCurrent = environment.idb?.read("current");
  assert.ok(olderAuthority && newerCurrent);

  environment.idb?.write("authority", olderAuthority);
  environment.local.clear();
  assert.equal(await loadLocalDocument(), "current revision");
  assert.deepEqual(environment.idb?.read("current"), newerCurrent);
});

test("partial replica failure preserves authority success and reports degradation", async () => {
  switchEnvironment({ indexedDb: true, opfs: true });
  assert.equal(stageLocalDocument("partial write"), true);
  assert.ok(environment.opfs);
  environment.opfs.faults.write = true;
  const health = await saveLocalDocument("partial write");
  assert.equal(health.saved, true);
  assert.ok(health.errors.some((error) => error.includes("browser file system")));
  assert.equal(await loadLocalDocument(), "partial write");
  assert.equal(environment.local.values.has("lab.document.pending.v1"), false);
});

test("authority success with both replica writes failed retains pending until recovery", async () => {
  switchEnvironment({ indexedDb: true, opfs: true });
  assert.equal(stageLocalDocument("both replicas fail"), true);
  assert.ok(environment.opfs);
  environment.local.throwOnSet = true;
  environment.opfs.faults.write = true;
  const health = await saveLocalDocument("both replicas fail");
  assert.equal(health.saved, true);
  assert.ok(health.errors.some((error) => error.includes("localStorage")));
  assert.ok(health.errors.some((error) => error.includes("browser file system")));
  assert.equal(environment.local.values.has("lab.document.pending.v1"), true);

  environment.local.throwOnSet = false;
  environment.opfs.faults.write = false;
  assert.equal(await loadLocalDocument(), "both replicas fail");
  assert.equal(environment.local.values.has("lab.document.pending.v1"), false);
});

test("standards-shaped quota failures preserve target-specific save and recovery semantics", async () => {
  const cases: Array<{
    name: string;
    configure: (current: TestEnvironment) => void;
    expectedSaved: boolean;
    errorLabel: string;
  }> = [
    {
      name: "localStorage quota",
      configure: (current) => {
        current.local.throwOnSet = true;
        current.local.quotaOnSet = true;
      },
      expectedSaved: true,
      errorLabel: "localStorage",
    },
    {
      name: "IndexedDB transaction quota",
      configure: (current) => {
        current.idb?.faults.putKeys.add("current");
        if (current.idb) current.idb.faults.quotaOnWrite = true;
      },
      expectedSaved: false,
      errorLabel: "IndexedDB authority",
    },
    {
      name: "OPFS write quota",
      configure: (current) => {
        if (current.opfs) {
          current.opfs.faults.write = true;
          current.opfs.faults.quotaWrite = true;
        }
      },
      expectedSaved: true,
      errorLabel: "browser file system",
    },
    {
      name: "OPFS close quota",
      configure: (current) => {
        if (current.opfs) {
          current.opfs.faults.close = true;
          current.opfs.faults.quotaClose = true;
        }
      },
      expectedSaved: true,
      errorLabel: "browser file system",
    },
  ];

  for (const currentCase of cases) {
    switchEnvironment({ indexedDb: true, opfs: true });
    assert.equal(stageLocalDocument(currentCase.name), true);
    currentCase.configure(environment);
    const health = await saveLocalDocument(currentCase.name);
    assert.equal(health.saved, currentCase.expectedSaved, currentCase.name);
    assert.ok(health.errors.some((error) => error.includes(currentCase.errorLabel)), currentCase.name);
    assert.equal(environment.local.values.has("lab.document.pending.v1"), true, currentCase.name);

    environment.local.throwOnSet = false;
    environment.local.quotaOnSet = false;
    if (environment.idb) {
      environment.idb.faults.putKeys.clear();
      environment.idb.faults.quotaOnWrite = false;
    }
    if (environment.opfs) {
      environment.opfs.faults.write = false;
      environment.opfs.faults.close = false;
      environment.opfs.faults.quotaWrite = false;
      environment.opfs.faults.quotaClose = false;
    }

    assert.equal(await loadLocalDocument(), currentCase.name, currentCase.name);
    assert.equal(environment.local.values.has("lab.document.pending.v1"), false, currentCase.name);
    assert.equal((await inspectLocalStorage()).copies, 3, currentCase.name);
  }
});

test("localStorage property and method failures remain isolated from readable fallbacks", async () => {
  switchEnvironment({ indexedDb: true, opfs: true });
  await saveLocalDocument("fallback note");
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new DOMException("Access denied", "SecurityError");
    },
  });
  try {
    assert.equal(await loadLocalDocument(), "fallback note");
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
  }

  environment.local.throwOnSet = true;
  const health = await saveLocalDocument("method failure");
  assert.equal(health.saved, true);
  assert.ok(health.errors.some((error) => error.includes("localStorage")));
});

test("recovery staging does not depend on sessionStorage availability", () => {
  switchEnvironment({ browser: true, locks: "success" });
  environment.session.throwOnGet = true;
  environment.session.throwOnSet = true;
  assert.equal(stageLocalDocument("session fallback"), true);
  assert.ok([...environment.local.values.keys()].some((key) => key.startsWith("lab.document.pending.v2.")));
});

test("missing crypto preserves a verified staged recovery draft but cannot create a durable snapshot", async () => {
  assert.equal(stageLocalDocument("crypto recovery"), true);
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
  assert.equal(await loadLocalDocument(), "crypto recovery");
  await assert.rejects(saveLocalDocument("crypto recovery"), /hashing|crypto|Secure/i);
  assert.ok(environment.local.values.has("lab.document.pending.v1"));
});

test("Web Locks absence or rejection fails replica-only browser writes closed", async () => {
  switchEnvironment({ browser: true, locks: null });
  assert.equal((await saveLocalDocument("no lock")).saved, false);

  switchEnvironment({ browser: true, locks: "reject" });
  const rejected = await saveLocalDocument("rejected lock");
  assert.equal(rejected.saved, false);
  assert.equal(localSnapshot(), null);

  switchEnvironment({ browser: true, indexedDb: true, locks: "reject" });
  assert.equal((await saveLocalDocument("IndexedDB authority")).saved, true);
  assert.equal(await loadLocalDocument(), "IndexedDB authority");
});

test("OPFS handles not-found, corruption, and write failures independently", async () => {
  switchEnvironment({ opfs: true });
  assert.equal((await saveLocalDocument("opfs note")).saved, true);
  assert.ok(environment.opfs);
  environment.opfs.files.delete("lab.md.snapshot");
  assert.equal(await loadLocalDocument(), "opfs note");
  environment.opfs.files.set("lab.md.snapshot", "not-json");
  assert.equal(await loadLocalDocument(), "opfs note");
  environment.opfs.faults.write = true;
  const health = await saveLocalDocument("opfs degraded");
  assert.equal(health.saved, true);
  assert.ok(health.errors.some((error) => error.includes("browser file system")));
});

test("IndexedDB open, request, abort, and put failures retain the recovery draft", async () => {
  const cases: Array<{ name: string; configure: (faults: FaultConfig) => void }> = [
    { name: "open error", configure: (faults) => { faults.open = "error"; } },
    { name: "blocked open", configure: (faults) => { faults.open = "blocked"; } },
    { name: "request error", configure: (faults) => { faults.readKeys.add("authority"); } },
    { name: "transaction abort", configure: (faults) => { faults.abortOnWrite = true; } },
    { name: "put failure", configure: (faults) => { faults.putKeys.add("current"); } },
  ];
  for (const current of cases) {
    switchEnvironment({ indexedDb: true });
    current.configure(environment.idb?.faults as FaultConfig);
    assert.equal(stageLocalDocument(current.name), true);
    const health = await saveLocalDocument(current.name);
    assert.equal(health.saved, false, current.name);
    assert.ok(environment.local.values.has("lab.document.pending.v1"), current.name);
  }
});

test("a newer staged edit cannot be cleared by an older save in flight", async () => {
  let started = false;
  let release: (() => void) | undefined;
  const originalCrypto = globalThis.crypto;
  const digest = async (...args: Parameters<SubtleCrypto["digest"]>) => {
    if (!started) {
      started = true;
      await new Promise<void>((resolve) => { release = resolve; });
    }
    return webcrypto.subtle.digest(...args);
  };
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: { subtle: { digest } } });
  try {
    assert.equal(stageLocalDocument("older"), true);
    const save = saveLocalDocument("older");
    while (!started) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stageLocalDocument("newer"), true);
    release?.();
    const health = await save;
    assert.equal(health.saved, false);
    assert.equal(await loadLocalDocument(), "newer");
  } finally {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: originalCrypto });
  }
});

test("document scopes isolate durable snapshots and pending recovery drafts", async () => {
  switchEnvironment({ browser: true, indexedDb: true, opfs: true, locks: "success" });

  assert.equal(stageLocalDocument("original note"), true);
  assert.equal((await saveLocalDocument("original note")).saved, true);

  setLocalDocumentScope("alpha");
  assert.equal(await loadLocalDocument(), "");
  assert.equal(stageLocalDocument("alpha note"), true);
  assert.equal((await saveLocalDocument("alpha note")).saved, true);

  setLocalDocumentScope("beta");
  assert.equal(stageLocalDocument("beta draft"), true);
  assert.ok([...environment.local.values.keys()].some((key) => key.startsWith("lab.document.pending.scoped.v2.beta.")));
  setLocalDocumentScope("default");
  assert.equal(await loadLocalDocument(), "original note");
  setLocalDocumentScope("beta");
  assert.equal(await loadLocalDocument(), "beta draft");

  setLocalDocumentScope("alpha");
  assert.equal(await loadLocalDocument(), "alpha note");
  setLocalDocumentScope("default");
  assert.equal(await loadLocalDocument("alpha"), "alpha note");
  assert.equal(await loadLocalDocument(), "original note");

  assert.ok(environment.local.values.has("lab.document.v1"));
  assert.ok(environment.local.values.has("lab.document.v2.alpha"));
});

test("read-only scoped loads ignore staged recovery drafts and never reconcile them", async () => {
  switchEnvironment({ browser: true, indexedDb: true, opfs: true, locks: "success" });

  setLocalDocumentScope("alpha");
  assert.equal(stageLocalDocument("durable note"), true);
  assert.equal((await saveLocalDocument("durable note")).saved, true);
  assert.equal(await loadLocalDocument(), "durable note");

  assert.equal(stageLocalDocument("inactive unsaved draft"), true);
  const pendingKey = [...environment.local.values.keys()].find((key) => (
    key.startsWith("lab.document.pending.scoped.v2.alpha.")
  ));
  assert.ok(pendingKey);

  assert.equal(await readVerifiedLocalDocument("alpha"), "durable note");
  assert.equal(
    (environment.idb?.read("authority:alpha") as { snapshot?: { markdown?: string } } | undefined)?.snapshot?.markdown,
    "durable note",
  );
  assert.equal(
    (environment.idb?.read("current:alpha") as { markdown?: string } | undefined)?.markdown,
    "durable note",
  );
  assert.equal(
    JSON.parse(environment.local.getItem(pendingKey as string) ?? "null")?.markdown,
    "inactive unsaved draft",
  );
});

test("read-only scoped loads observe IndexedDB deletion without creating a local tombstone", async () => {
  switchEnvironment({ browser: true, indexedDb: true, opfs: true, locks: "success" });

  setLocalDocumentScope("alpha");
  assert.equal((await saveLocalDocument("to delete")).saved, true);
  await deleteLocalDocument("alpha");
  environment.local.removeItem("lab.document.deleted.v1.alpha");
  resetLocalVaultStateForTests();
  setLocalDocumentScope("alpha");

  assert.equal(await readVerifiedLocalDocument("alpha"), null);
  assert.equal(environment.local.getItem("lab.document.deleted.v1.alpha"), null);
});

test("deleteLocalDocument purges scoped replicas and refuses the original session", async () => {
  switchEnvironment({ browser: true, indexedDb: true, opfs: true, locks: "success" });

  assert.equal(stageLocalDocument("keep original"), true);
  assert.equal((await saveLocalDocument("keep original")).saved, true);

  setLocalDocumentScope("alpha");
  assert.equal(stageLocalDocument("remove me"), true);
  assert.equal((await saveLocalDocument("remove me")).saved, true);
  assert.ok(environment.local.values.has("lab.document.v2.alpha"));
  assert.ok(environment.idb?.read("authority:alpha"));
  assert.ok(environment.idb?.read("current:alpha"));
  assert.ok(environment.opfs?.files.has("lab.alpha.md.snapshot"));

  setLocalDocumentScope("default");
  await deleteLocalDocument("alpha");

  // Scope must remain the caller's document after purging another session.
  assert.equal(await loadLocalDocument(), "keep original");
  assert.equal(environment.local.values.has("lab.document.v2.alpha"), false);
  assert.equal(isLocalDocumentDeleted("alpha"), true);
  assert.equal(
    [...environment.local.values.keys()].some((key) => (
      key.includes("alpha") && !key.startsWith("lab.document.deleted.v1.")
    )),
    false,
  );
  assert.equal(environment.idb?.read("authority:alpha"), undefined);
  assert.equal(environment.idb?.read("current:alpha"), undefined);
  assert.equal(environment.opfs?.files.has("lab.alpha.md.snapshot"), false);

  setLocalDocumentScope("alpha");
  assert.equal(await loadLocalDocument(), "");
  // Peer-tab style rewrite after delete must not resurrect content.
  assert.equal(stageLocalDocument("resurrect me"), false);
  const revived = await saveLocalDocument("resurrect me");
  assert.equal(revived.saved, false);
  assert.ok(revived.errors.some((error) => /deleted in another tab/i.test(error)));
  assert.equal(environment.local.values.has("lab.document.v2.alpha"), false);

  setLocalDocumentScope("default");
  assert.equal(await loadLocalDocument(), "keep original");

  await assert.rejects(() => deleteLocalDocument("default"), /original session cannot be deleted/i);
});

test("deleteLocalDocument does not redirect the caller's active scope mid-flight", async () => {
  switchEnvironment({ browser: true, indexedDb: true, opfs: true, locks: "success" });

  setLocalDocumentScope("default");
  assert.equal((await saveLocalDocument("original")).saved, true);
  setLocalDocumentScope("alpha");
  assert.equal((await saveLocalDocument("alpha body")).saved, true);
  setLocalDocumentScope("default");

  await deleteLocalDocument("alpha");
  assert.equal(await loadLocalDocument(), "original");
  assert.equal((await saveLocalDocument("original still")).saved, true);
  assert.equal(await loadLocalDocument(), "original still");
});

test("IndexedDB deletion marker blocks commits even when localStorage tombstone is missing", async () => {
  switchEnvironment({ browser: true, indexedDb: true, opfs: true, locks: null });

  setLocalDocumentScope("alpha");
  assert.equal((await saveLocalDocument("secret")).saved, true);
  await deleteLocalDocument("alpha");

  // Peer tab with a cold process-local cache and no localStorage tombstone still
  // loses to the durable IndexedDB marker inside the authority transaction.
  resetLocalVaultStateForTests();
  setLocalDocumentScope("alpha");
  environment.local.removeItem("lab.document.deleted.v1.alpha");
  assert.equal(isLocalDocumentDeleted("alpha"), false);

  const revived = await saveLocalDocument("resurrect");
  assert.equal(revived.saved, false);
  assert.ok(revived.errors.some((error) => /deleted in another tab/i.test(error)));
  assert.equal(environment.local.values.has("lab.document.v2.alpha"), false);
  assert.equal(environment.idb?.read("authority:alpha"), undefined);
  assert.ok(environment.idb?.read("deleted:alpha"));
  assert.equal(await loadLocalDocument(), "");
});

test("failed local purge before a durable marker leaves the session loadable", async () => {
  switchEnvironment({ browser: true, indexedDb: true, opfs: true, locks: "success" });

  setLocalDocumentScope("alpha");
  assert.equal((await saveLocalDocument("keep me")).saved, true);

  const originalSetItem = environment.local.setItem.bind(environment.local);
  // Corrupt removeItem only for the document snapshot so purgeLocalReplicas throws
  // before any IndexedDB deletion marker is written.
  const originalRemove = environment.local.removeItem.bind(environment.local);
  environment.local.removeItem = (key: string) => {
    if (key === "lab.document.v2.alpha") throw new Error("quota");
    originalRemove(key);
  };

  await assert.rejects(() => deleteLocalDocument("alpha"), /localStorage copies/i);
  environment.local.removeItem = originalRemove;
  environment.local.setItem = originalSetItem;

  assert.equal(isLocalDocumentDeleted("alpha"), false);
  assert.equal(environment.idb?.read("deleted:alpha"), undefined);
  assert.equal(await loadLocalDocument(), "keep me");
  assert.equal((await saveLocalDocument("keep me still")).saved, true);
});

test("in-flight save loses to peer delete after authority commit without Web Locks", async () => {
  // Cross-tab TOCTOU: authority commit accepts, then a peer writes deleted:<id>
  // and drops authority before replica writes. Without Web Locks this is the
  // gap that used to repopulate localStorage/OPFS and report saved: true.
  switchEnvironment({ browser: true, indexedDb: true, opfs: true, locks: null });
  setLocalDocumentScope("alpha");
  assert.equal((await saveLocalDocument("seed")).saved, true);

  const documents = environment.idb?.stores.get("documents");
  assert.ok(documents);
  const realSet = documents.set.bind(documents);
  let sawRacerAuthority = false;
  documents.set = ((key: IDBValidKey, value: unknown) => {
    realSet(key, value);
    if (
      key === "authority:alpha"
      && value
      && typeof value === "object"
      && (value as { snapshot?: { markdown?: string } }).snapshot?.markdown === "racer"
    ) {
      sawRacerAuthority = true;
    }
  }) as typeof documents.set;

  const originalCrypto = globalThis.crypto;
  let release: (() => void) | undefined;
  let paused = false;
  const digest = async (...args: Parameters<SubtleCrypto["digest"]>) => {
    const result = await webcrypto.subtle.digest(...args);
    // First digest after the racer authority put is post-commit normalizeSnapshot.
    if (sawRacerAuthority && !paused) {
      paused = true;
      await new Promise<void>((resolve) => { release = resolve; });
    }
    return result;
  };
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { subtle: { digest } },
  });

  try {
    const save = saveLocalDocument("racer");
    while (!release) await new Promise<void>((resolve) => setImmediate(resolve));

    // Peer tab finished deleteLocalDocument: durable marker, no authority, purged replicas.
    environment.idb?.write("deleted:alpha", { recordVersion: 1, deletedAt: Date.now() });
    environment.idb?.remove("authority:alpha");
    environment.idb?.remove("current:alpha");
    environment.local.removeItem("lab.document.v2.alpha");
    environment.opfs?.files.delete("lab.alpha.md.snapshot");
    // No localStorage tombstone yet — the cold-tab race window.

    release();
    const health = await save;
    assert.equal(health.saved, false);
    assert.ok(health.errors.some((error) => /deleted in another tab/i.test(error)));
    assert.equal(environment.local.values.has("lab.document.v2.alpha"), false);
    assert.equal(environment.opfs?.files.has("lab.alpha.md.snapshot"), false);
    assert.ok(environment.idb?.read("deleted:alpha"));
    assert.equal(environment.idb?.read("authority:alpha"), undefined);
    assert.equal(environment.idb?.read("current:alpha"), undefined);
  } finally {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: originalCrypto });
  }
});
