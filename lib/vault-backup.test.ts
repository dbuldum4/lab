import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test, { afterEach, beforeEach } from "node:test";
import {
  buildVaultBackup,
  exportLocalVault,
  parseVaultBackup,
  restoreLocalVault,
  serializeVaultBackup,
} from "./vault-backup.ts";
import {
  isLocalDocumentDeleted,
  loadLocalDocument,
  resetLocalVaultStateForTests,
  saveLocalDocument,
  saveLocalDocumentForDocument,
  setLocalDocumentScope,
} from "./local-vault.ts";
import {
  createDocumentSession,
  purgeDocumentSession,
  type DocumentSession,
} from "./document-sessions.ts";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const TEST_IMAGE = "data:image/png;base64,AAAA";
const GLOBALS = ["localStorage", "indexedDB", "window", "crypto"] as const;
let descriptors = new Map<string, PropertyDescriptor | undefined>();
let local: MemoryStorage;

beforeEach(() => {
  descriptors = new Map(GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  local = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: local });
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
  Reflect.deleteProperty(globalThis, "indexedDB");
  Reflect.deleteProperty(globalThis, "window");
  resetLocalVaultStateForTests();
});

afterEach(() => {
  for (const name of GLOBALS) {
    const descriptor = descriptors.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  resetLocalVaultStateForTests();
});

function session(id: string, name: string): DocumentSession {
  return { id, name, createdAt: 10, updatedAt: 20 };
}

test("portable backup deduplicates embedded images and round-trips the vault", async () => {
  await saveLocalDocument(`Original\n\n![pixel](${TEST_IMAGE})`);
  const extra = await createDocumentSession("Research");
  await saveLocalDocumentForDocument(extra.id, `Research\n\n![same image](${TEST_IMAGE})`);

  const backup = await exportLocalVault();
  assert.equal(backup.format, "lab-local-vault");
  assert.equal(backup.version, 1);
  assert.equal(backup.counts.sessions, 2);
  assert.equal(backup.counts.assets, 1);
  assert.equal(backup.assets[0]?.dataUrl, TEST_IMAGE);
  assert.match(backup.sessions.find((item) => item.id === "default")?.markdown ?? "", /lab-asset:\/\/asset-1/);
  const serialized = serializeVaultBackup(backup);
  assert.equal(serialized.match(new RegExp(TEST_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length, 1);

  const parsed = parseVaultBackup(serialized);
  assert.deepEqual(parsed, backup);

  local.clear();
  resetLocalVaultStateForTests();
  const restored = await restoreLocalVault(parsed);
  assert.deepEqual(
    {
      imported: restored.imported,
      skipped: restored.skipped,
      renamed: restored.renamed,
    },
    { imported: 2, skipped: 0, renamed: 0 },
  );
  assert.equal(await loadLocalDocument(), `Original\n\n![pixel](${TEST_IMAGE})`);
  setLocalDocumentScope(extra.id);
  assert.equal(await loadLocalDocument(), `Research\n\n![same image](${TEST_IMAGE})`);

  const secondRestore = await restoreLocalVault(parsed);
  assert.deepEqual(
    { imported: secondRestore.imported, skipped: secondRestore.skipped, renamed: secondRestore.renamed },
    { imported: 0, skipped: 2, renamed: 0 },
  );
});

test("malformed or partial backups fail validation before storage changes", async () => {
  await saveLocalDocument("keep this note");
  const source = buildVaultBackup([{ ...session("default", "Untitled"), markdown: "" }], 100);
  source.sessions[0].markdown = "![missing](lab-asset://asset-999)";

  assert.throws(() => parseVaultBackup(source), /missing image asset/);
  await assert.rejects(() => restoreLocalVault(source), /missing image asset/);
  assert.equal(await loadLocalDocument(), "keep this note");

  const serialized = serializeVaultBackup(buildVaultBackup([{
    ...session("default", "Untitled"),
    markdown: "partial payload",
  }], 100));
  assert.throws(() => parseVaultBackup(serialized.slice(0, -12)), /valid JSON/);
  const badCounts = JSON.parse(serialized) as { counts: { sessions: number } };
  badCounts.counts.sessions = 2;
  assert.throws(() => parseVaultBackup(badCounts), /manifest counts/);
  assert.equal(await loadLocalDocument(), "keep this note");
});

test("restoring a tombstoned session allocates a new id without reviving the old one", async () => {
  const doomed = await createDocumentSession("Doomed");
  await saveLocalDocumentForDocument(doomed.id, "private session");
  await purgeDocumentSession(doomed.id);
  assert.equal(isLocalDocumentDeleted(doomed.id), true);

  const backup = buildVaultBackup([{ ...doomed, markdown: "private session" }], 100);
  const restored = await restoreLocalVault(backup);
  assert.equal(restored.imported, 1);
  assert.equal(restored.renamed, 1);
  assert.notEqual(restored.importedSessionIds[0], doomed.id);
  assert.equal(isLocalDocumentDeleted(doomed.id), true);
});
