import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test, { afterEach, beforeEach } from "node:test";
import {
  activeDocumentIdFromLocation,
  archiveDocumentSession,
  clearInvalidDocumentSessionHash,
  createDocumentSession,
  deleteDocumentSession,
  documentSessionHash,
  ensureDocumentSession,
  getDocumentSession,
  listDocumentSessions,
  parseActiveDocumentLocation,
  pinDocumentSession,
  purgeDocumentSession,
  renameDocumentSession,
  restoreExistingDocumentSession,
  touchDocumentSession,
  unarchiveDocumentSession,
  unpinDocumentSession,
  updateAutomaticSessionTitle,
} from "./document-sessions.ts";
import { deleteLocalDocument, isLocalDocumentDeleted, resetLocalVaultStateForTests } from "./local-vault.ts";

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

class InterleavingStorage extends MemoryStorage {
  onSet?: (key: string, value: string) => boolean | void;

  override setItem(key: string, value: string) {
    super.setItem(key, value);
    const callback = this.onSet;
    if (callback && callback(key, value) !== false) this.onSet = undefined;
  }
}

class ThrowOnceStorage extends MemoryStorage {
  throwOnKey: string | null = null;

  override setItem(key: string, value: string) {
    super.setItem(key, value);
    if (key === this.throwOnKey) {
      this.throwOnKey = null;
      throw new Error("storage quota exceeded after metadata write");
    }
  }
}

const descriptors = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
  for (const name of ["localStorage", "crypto", "navigator"]) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  }
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: new MemoryStorage() });
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks: { request: async (_name: string, _options: unknown, callback: () => unknown) => callback() } },
  });
  resetLocalVaultStateForTests();
});

afterEach(() => {
  resetLocalVaultStateForTests();
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  descriptors.clear();
});

test("the hash keeps the original document implicit and scopes named sessions", () => {
  assert.equal(activeDocumentIdFromLocation({ hash: "" } as Location), "default");
  assert.equal(activeDocumentIdFromLocation({ hash: "#session=alpha_1" } as Location), "alpha_1");
  assert.equal(activeDocumentIdFromLocation({ hash: "#session=../../bad" } as Location), "default");
  assert.deepEqual(parseActiveDocumentLocation({ hash: "#session=../../bad" }), {
    id: "default",
    hadInvalidSessionHash: true,
  });
  assert.deepEqual(parseActiveDocumentLocation({ hash: "#session=%ZZ" }), {
    id: "default",
    hadInvalidSessionHash: true,
  });
  assert.deepEqual(parseActiveDocumentLocation({ hash: "#session=alpha_1" }), {
    id: "alpha_1",
    hadInvalidSessionHash: false,
  });
  assert.deepEqual(parseActiveDocumentLocation({ hash: "" }), {
    id: "default",
    hadInvalidSessionHash: false,
  });
  assert.equal(documentSessionHash("default"), "");
  assert.equal(documentSessionHash("alpha_1"), "#session=alpha_1");
});

test("invalid session hashes are rewritten so the URL matches default storage", () => {
  const location = {
    hash: "#session=../../bad",
    pathname: "/lab",
    search: "?x=1",
  };
  let replaced: { state: unknown; url: string } | undefined;
  const history = {
    replaceState(state: unknown, _title: string, url: string) {
      replaced = { state, url };
      location.hash = "";
    },
  };

  assert.equal(clearInvalidDocumentSessionHash(location, history), true);
  assert.deepEqual(replaced, { state: { labDocumentId: "default" }, url: "/lab?x=1" });
  assert.equal(clearInvalidDocumentSessionHash({ ...location, hash: "" }, history), false);
  assert.equal(clearInvalidDocumentSessionHash({ ...location, hash: "#session=ok_id" }, history), false);
});

test("location hash changes map back and forward session ids", () => {
  // Browser Back/Forward only update location.hash; the editor reloads when this
  // id diverges from the mount-time documentId.
  assert.equal(activeDocumentIdFromLocation({ hash: "#session=alpha" } as Location), "alpha");
  assert.equal(activeDocumentIdFromLocation({ hash: "" } as Location), "default");
  assert.equal(activeDocumentIdFromLocation({ hash: "#session=beta" } as Location), "beta");
  assert.equal(documentSessionHash("alpha"), "#session=alpha");
  assert.equal(documentSessionHash("default"), "");
});

test("sessions are independent, resumable, and rename atomically per id", async () => {
  const original = await ensureDocumentSession("default");
  const alpha = await createDocumentSession("Alpha");
  const beta = await createDocumentSession("Beta");
  await renameDocumentSession(alpha.id, "  Research   notes  ");
  const beforeTouch = listDocumentSessions().find((session) => session.id === alpha.id)?.updatedAt ?? 0;
  const touched = await touchDocumentSession(alpha.id);

  const sessions = listDocumentSessions();
  assert.equal(original.id, "default");
  assert.equal(sessions.length, 3);
  assert.equal(sessions.find((session) => session.id === alpha.id)?.name, "Research notes");
  assert.equal(sessions.find((session) => session.id === beta.id)?.name, "Beta");
  assert.equal(sessions.find((session) => session.id === beta.id)?.titleSource, "manual");
  assert.ok(touched.updatedAt > beforeTouch);
  assert.equal(sessions.find((session) => session.id === alpha.id)?.updatedAt, touched.updatedAt);
});

test("legacy session rows receive safe metadata defaults", async () => {
  localStorage.setItem("lab.session.v1.default", JSON.stringify({
    id: "default",
    name: "Untitled",
    createdAt: 1,
    updatedAt: 2,
  }));
  localStorage.setItem("lab.session.v1.legacy", JSON.stringify({
    id: "legacy",
    name: "Existing title",
    createdAt: 3,
    updatedAt: 4,
  }));

  assert.deepEqual(await getDocumentSession("default"), {
    id: "default",
    name: "Untitled",
    titleSource: "automatic",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 2,
  });
  assert.deepEqual(await getDocumentSession("legacy"), {
    id: "legacy",
    name: "Existing title",
    titleSource: "manual",
    pinned: false,
    archived: false,
    createdAt: 3,
    updatedAt: 4,
  });
});

test("automatic titles track headings but never override a manual name", async () => {
  const draft = await createDocumentSession();
  const titled = await updateAutomaticSessionTitle(draft.id, "  First   heading  ");
  assert.equal(titled.name, "First heading");
  assert.equal(titled.titleSource, "automatic");

  await pinDocumentSession(draft.id);
  const changed = await updateAutomaticSessionTitle(draft.id, "Second heading");
  assert.equal(changed.name, "Second heading");
  assert.equal(changed.pinned, true);

  const manual = await renameDocumentSession(draft.id, "My title");
  assert.equal(manual.titleSource, "manual");
  const protectedTitle = await updateAutomaticSessionTitle(draft.id, "Ignored heading");
  assert.deepEqual(protectedTitle, manual);

  const manualUntitled = await renameDocumentSession(draft.id, "Untitled");
  assert.equal(manualUntitled.titleSource, "manual");
  assert.equal((await updateAutomaticSessionTitle(draft.id, "Still ignored")).name, "Untitled");

  const explicitlyNamed = await createDocumentSession("Untitled");
  assert.equal(explicitlyNamed.titleSource, "manual");
  assert.equal((await updateAutomaticSessionTitle(explicitlyNamed.id, "Ignored too")).name, "Untitled");
});

test("pinning is explicit, idempotent, and sorts pinned sessions first", async () => {
  const alpha = await createDocumentSession("Alpha");
  const beta = await createDocumentSession("Beta");
  await touchDocumentSession(beta.id);

  const pinned = await pinDocumentSession(alpha.id);
  assert.equal(pinned.pinned, true);
  assert.equal(listDocumentSessions()[0]?.id, alpha.id);
  assert.deepEqual(await pinDocumentSession(alpha.id), pinned);

  const unpinned = await unpinDocumentSession(alpha.id);
  assert.equal(unpinned.pinned, false);
  assert.equal((await getDocumentSession(alpha.id))?.pinned, false);

  const original = await pinDocumentSession("default");
  assert.equal(original.id, "default");
  assert.equal(original.pinned, true);
});

test("archived sessions are hidden by default and available through filtered views", async () => {
  const alpha = await createDocumentSession("Alpha");
  const beta = await createDocumentSession("Beta");
  await pinDocumentSession(alpha.id);
  const archived = await archiveDocumentSession(alpha.id);

  assert.equal(archived.archived, true);
  assert.equal(archived.pinned, true);
  assert.equal(listDocumentSessions().some((item) => item.id === alpha.id), false);
  assert.deepEqual(listDocumentSessions({ archived: true }).map((item) => item.id), [alpha.id]);
  assert.equal(listDocumentSessions({ archived: "all" }).some((item) => item.id === alpha.id), true);
  assert.equal(listDocumentSessions({ archived: "all" }).some((item) => item.id === beta.id), true);

  const restored = await unarchiveDocumentSession(alpha.id);
  assert.equal(restored.archived, false);
  assert.equal(listDocumentSessions().some((item) => item.id === alpha.id), true);
  assert.deepEqual(await unarchiveDocumentSession(alpha.id), restored);
  await assert.rejects(() => archiveDocumentSession("default"), /original session cannot be archived/i);
  assert.equal(listDocumentSessions().some((item) => item.id === "default"), true);
});

test("unknown hashes do not create session metadata until first durable touch", async () => {
  assert.equal(await getDocumentSession("typoOrSharedId"), null);
  assert.equal(listDocumentSessions().some((session) => session.id === "typoOrSharedId"), false);

  const created = await touchDocumentSession("typoOrSharedId");
  assert.equal(created.name, "Untitled");
  assert.equal((await getDocumentSession("typoOrSharedId"))?.id, "typoOrSharedId");
  assert.ok(listDocumentSessions().some((session) => session.id === "typoOrSharedId"));
});

test("delete removes session metadata and activity without deleting the original", async () => {
  const alpha = await createDocumentSession("Scratch");
  await touchDocumentSession(alpha.id);
  assert.ok(listDocumentSessions().some((session) => session.id === alpha.id));
  assert.equal(localStorage.getItem(`lab.session.activity.v1.${alpha.id}`) !== null, true);

  await deleteDocumentSession(alpha.id);

  assert.equal(listDocumentSessions().some((session) => session.id === alpha.id), false);
  assert.equal(localStorage.getItem(`lab.session.v1.${alpha.id}`), null);
  assert.equal(localStorage.getItem(`lab.session.activity.v1.${alpha.id}`), null);
  assert.ok(listDocumentSessions().some((session) => session.id === "default"));

  await assert.rejects(() => deleteDocumentSession("default"), /original session cannot be deleted/i);
});

test("purge removes session metadata after content purge and refuses the original", async () => {
  const alpha = await createDocumentSession("Doomed");
  localStorage.setItem(`lab.document.v2.${alpha.id}`, JSON.stringify({
    markdown: "secret",
    updatedAt: 1,
    checksum: "x",
    version: 2,
  }));

  // purgeDocumentSession deletes content then metadata; unit env has no IDB/OPFS.
  await purgeDocumentSession(alpha.id);

  assert.equal(localStorage.getItem(`lab.document.v2.${alpha.id}`), null);
  assert.equal(isLocalDocumentDeleted(alpha.id), true);
  assert.equal(listDocumentSessions().some((session) => session.id === alpha.id), false);
  await assert.rejects(() => purgeDocumentSession("default"), /original session cannot be deleted/i);
  await assert.rejects(() => deleteLocalDocument("default"), /original session cannot be deleted/i);
});

test("tombstoned sessions cannot be renamed, touched, or re-listed as ghosts", async () => {
  const alpha = await createDocumentSession("Doomed");
  await purgeDocumentSession(alpha.id);

  // Simulate leftover metadata a peer might still hold (or a partial metadata delete).
  localStorage.setItem(`lab.session.v1.${alpha.id}`, JSON.stringify({
    id: alpha.id,
    name: "Stale",
    createdAt: 1,
    updatedAt: 1,
  }));

  assert.equal(listDocumentSessions().some((session) => session.id === alpha.id), false);
  await assert.rejects(() => renameDocumentSession(alpha.id, "BackFromDead"), /deleted/i);
  await assert.rejects(() => updateAutomaticSessionTitle(alpha.id, "BackFromDead"), /deleted/i);
  await assert.rejects(() => pinDocumentSession(alpha.id), /deleted/i);
  await assert.rejects(() => archiveDocumentSession(alpha.id), /deleted/i);
  await assert.rejects(() => touchDocumentSession(alpha.id), /deleted/i);
  await assert.rejects(() => ensureDocumentSession(alpha.id), /deleted/i);
  assert.equal(await getDocumentSession(alpha.id), null);
  assert.equal(listDocumentSessions().some((session) => session.id === alpha.id), false);
});

test("createDocumentSession retries when the chosen id is already tombstoned", async () => {
  const doomed = "deadbeefdeadbeefdeadbeefdeadbeef";
  let calls = 0;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      randomUUID() {
        calls += 1;
        return calls === 1
          ? "deadbeef-dead-beef-dead-beefdeadbeef"
          : "cafebabe-cafe-babe-cafe-babecafebabe";
      },
    },
  });
  // localStorage tombstone is enough for isLocalDocumentDeleted after process-local reset.
  localStorage.setItem(`lab.document.deleted.v1.${doomed}`, String(Date.now()));

  const session = await createDocumentSession("Recovered");
  assert.notEqual(session.id, doomed);
  assert.equal(session.id, "cafebabecafebabecafebabecafebabe");
  assert.equal(session.name, "Recovered");
  assert.equal(calls, 2);
});

test("createDocumentSession retries when the id is tombstoned after the lock is acquired", async () => {
  const doomed = "aabbccddeeff00112233445566778899";
  let calls = 0;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      randomUUID() {
        calls += 1;
        return calls === 1
          ? "aabbccdd-eeff-0011-2233-445566778899"
          : "11223344-5566-7788-99aa-bbccddeeff00";
      },
    },
  });

  // First lock callback races a tombstone write, second id is free.
  let lockCalls = 0;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: {
        request: async (_name: string, _options: unknown, callback: () => unknown) => {
          lockCalls += 1;
          if (lockCalls === 1) {
            localStorage.setItem(`lab.document.deleted.v1.${doomed}`, String(Date.now()));
          }
          return callback();
        },
      },
    },
  });

  const session = await createDocumentSession("UnderLock");
  assert.equal(session.id, "112233445566778899aabbccddeeff00");
  assert.equal(session.name, "UnderLock");
  assert.equal(calls, 2);
  assert.equal(lockCalls, 2);
});

test("createDocumentSession retries when the chosen id already has live metadata", async () => {
  const taken = "feedfacefeedfacefeedfacefeedface";
  localStorage.setItem(
    `lab.session.v1.${taken}`,
    JSON.stringify({
      id: taken,
      name: "Existing",
      createdAt: 1,
      updatedAt: 1,
    }),
  );

  let calls = 0;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      randomUUID() {
        calls += 1;
        return calls === 1
          ? "feedface-feed-face-feed-facefeedface"
          : "cafebabe-cafe-babe-cafe-babecafebabe";
      },
    },
  });

  const session = await createDocumentSession("Fresh");
  assert.notEqual(session.id, taken);
  assert.equal(session.id, "cafebabecafebabecafebabecafebabe");
  assert.equal(session.name, "Fresh");
  assert.equal(calls, 2);
  // Existing session metadata must not be clobbered by the collision attempt.
  assert.equal(
    JSON.parse(localStorage.getItem(`lab.session.v1.${taken}`) ?? "null").name,
    "Existing",
  );
});

test("fallback metadata writes keep unrelated concurrent fields", async () => {
  const session = await createDocumentSession();
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {},
  });

  await Promise.all([
    updateAutomaticSessionTitle(session.id, "Concurrent heading"),
    pinDocumentSession(session.id),
    archiveDocumentSession(session.id),
  ]);

  const merged = await getDocumentSession(session.id);
  assert.ok(merged);
  assert.equal(merged.name, "Concurrent heading");
  assert.equal(merged.titleSource, "automatic");
  assert.equal(merged.pinned, true);
  assert.equal(merged.archived, true);
  assert.equal(merged.createdAt, session.createdAt);
  assert.ok(merged.updatedAt >= session.updatedAt);
});

test("per-field fallback writes survive an interleaved peer field write", async () => {
  const session = await createDocumentSession();
  const existing = localStorage as unknown as MemoryStorage;
  const racing = new InterleavingStorage();
  for (const [key, value] of existing.values) racing.values.set(key, value);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: racing,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {},
  });

  const nameKey = `lab.session.field.v1.${session.id}.name`;
  const pinnedKey = `lab.session.field.v1.${session.id}.pinned`;
  racing.onSet = (key) => {
    if (key !== nameKey) return false;
    racing.setItem(pinnedKey, JSON.stringify(true));
  };

  await renameDocumentSession(session.id, "Interleaved rename");

  const merged = await getDocumentSession(session.id);
  assert.ok(merged);
  assert.equal(merged.name, "Interleaved rename");
  assert.equal(merged.pinned, true);
});

test("a racing automatic title cannot replace a manual rename", async () => {
  const session = await createDocumentSession();
  const existing = localStorage as unknown as MemoryStorage;
  const racing = new InterleavingStorage();
  for (const [key, value] of existing.values) racing.values.set(key, value);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: racing,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {},
  });

  const nameKey = `lab.session.field.v1.${session.id}.name`;
  const titleSourceKey = `lab.session.field.v1.${session.id}.titleSource`;
  const manualTitleKey = `lab.session.manual-title.v1.${session.id}`;
  racing.onSet = (key) => {
    if (key !== nameKey) return;
    racing.setItem(manualTitleKey, JSON.stringify("Manual wins"));
    racing.setItem(nameKey, JSON.stringify("Manual wins"));
    racing.setItem(titleSourceKey, JSON.stringify("manual"));
  };

  await updateAutomaticSessionTitle(session.id, "Automatic loses");

  const merged = await getDocumentSession(session.id);
  assert.ok(merged);
  assert.equal(merged.name, "Manual wins");
  assert.equal(merged.titleSource, "manual");
});

test("restore rollback restores field keys after a committed metadata failure", async () => {
  const original = await createDocumentSession();
  const expected = await getDocumentSession(original.id);
  assert.ok(expected);
  const restored = {
    ...expected,
    name: "Restored title",
    pinned: true,
    updatedAt: expected.updatedAt + 10,
  };

  const existing = localStorage as unknown as MemoryStorage;
  const failing = new ThrowOnceStorage();
  for (const [key, value] of existing.values) failing.values.set(key, value);
  failing.throwOnKey = `lab.session.field.v1.${original.id}.name`;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: failing,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {},
  });

  await assert.rejects(
    () => restoreExistingDocumentSession(restored, expected),
    /could not be restored/i,
  );
  assert.deepEqual(await getDocumentSession(original.id), expected);
});
