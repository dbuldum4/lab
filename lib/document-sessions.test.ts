import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test, { afterEach, beforeEach } from "node:test";
import {
  activeDocumentIdFromLocation,
  createDocumentSession,
  deleteDocumentSession,
  documentSessionHash,
  ensureDocumentSession,
  getDocumentSession,
  listDocumentSessions,
  purgeDocumentSession,
  renameDocumentSession,
  touchDocumentSession,
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
  assert.equal(documentSessionHash("default"), "");
  assert.equal(documentSessionHash("alpha_1"), "#session=alpha_1");
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
  assert.ok(touched.updatedAt > beforeTouch);
  assert.equal(sessions.find((session) => session.id === alpha.id)?.updatedAt, touched.updatedAt);
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
  await assert.rejects(() => touchDocumentSession(alpha.id), /deleted/i);
  await assert.rejects(() => ensureDocumentSession(alpha.id), /deleted/i);
  assert.equal(await getDocumentSession(alpha.id), null);
  assert.equal(listDocumentSessions().some((session) => session.id === alpha.id), false);
});
