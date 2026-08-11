import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test, { afterEach, beforeEach } from "node:test";
import {
  buildVaultBackup,
  exportLocalVault,
  isValidLocalImageDataUrl,
  parseVaultBackup,
  restoreLocalVault,
  serializeVaultBackup,
} from "./vault-backup.ts";
import {
  DEFAULT_DOCUMENT_ID,
  isLocalDocumentDeleted,
  loadLocalDocument,
  loadLocalDocumentForDocument,
  resetLocalVaultStateForTests,
  saveLocalDocument,
  saveLocalDocumentForDocument,
  setLocalDocumentScope,
} from "./local-vault.ts";
import {
  archiveDocumentSession,
  createDocumentSession,
  getDocumentSession,
  pinDocumentSession,
  purgeDocumentSession,
  type DocumentSession,
} from "./document-sessions.ts";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  throwOnLength = false;
  throwOnGet = false;
  throwOnSet = false;
  throwOnDocumentSet = false;
  throwOnDocumentId: string | null = null;
  throwAfterSessionSet = false;
  onGet: ((key: string) => void) | null = null;
  onSetAttempt: ((key: string, value: string) => void) | null = null;

  get length() {
    if (this.throwOnLength) throw new Error("storage length unavailable");
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    if (this.throwOnGet) throw new Error("storage read unavailable");
    this.onGet?.(key);
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.onSetAttempt?.(key, value);
    if (
      this.throwOnSet
      || (this.throwOnDocumentSet && key.startsWith("lab.document."))
      || (this.throwOnDocumentId && key === `lab.document.v2.${this.throwOnDocumentId}`)
    ) {
      throw new Error("storage quota exceeded");
    }
    this.values.set(key, value);
    if (this.throwAfterSessionSet && key.startsWith("lab.session.v1.")) {
      throw new Error("storage quota exceeded after metadata write");
    }
  }
}

const TEST_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
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
  return {
    id,
    name,
    titleSource: name === "Untitled" ? "automatic" : "manual",
    pinned: false,
    archived: false,
    createdAt: 10,
    updatedAt: 20,
  };
}

test("portable backup deduplicates embedded images and round-trips the vault", async () => {
  await saveLocalDocument(`Original\n\n![pixel](${TEST_IMAGE})`);
  const extra = await createDocumentSession("Research");
  await saveLocalDocumentForDocument(extra.id, `Research\n\n![same image](${TEST_IMAGE})`);
  await pinDocumentSession(extra.id);
  await archiveDocumentSession(extra.id);

  const backup = await exportLocalVault();
  assert.equal(backup.format, "lab-local-vault");
  assert.equal(backup.version, 1);
  assert.equal(backup.counts.sessions, 2);
  assert.equal(backup.counts.assets, 1);
  assert.deepEqual(
    backup.sessions.find((item) => item.id === extra.id),
    {
      ...(await getDocumentSession(extra.id)),
      markdown: "Research\n\n![same image](lab-asset://asset-1)",
    },
  );
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
  assert.equal((await getDocumentSession(extra.id))?.pinned, true);
  assert.equal((await getDocumentSession(extra.id))?.archived, true);

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

test("legacy backups receive metadata defaults and invalid new metadata is rejected", () => {
  const legacy = JSON.parse(JSON.stringify(buildVaultBackup([{
    id: "legacy",
    name: "Existing title",
    createdAt: 10,
    updatedAt: 20,
    markdown: "legacy note",
  }]))) as { sessions: Array<Record<string, unknown>> };
  delete legacy.sessions[0]?.titleSource;
  delete legacy.sessions[0]?.pinned;
  delete legacy.sessions[0]?.archived;

  assert.deepEqual(parseVaultBackup(legacy).sessions[0], {
    id: "legacy",
    name: "Existing title",
    titleSource: "manual",
    pinned: false,
    archived: false,
    createdAt: 10,
    updatedAt: 20,
    markdown: "legacy note",
  });

  legacy.sessions[0]!.pinned = "yes";
  assert.throws(() => parseVaultBackup(legacy), /invalid pinned state/i);
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

test("export fails closed when session metadata enumeration is incomplete", async () => {
  await saveLocalDocument("do not export a partial vault");
  local.throwOnLength = true;

  await assert.rejects(
    () => exportLocalVault(),
    /session catalog could not be read completely/i,
  );
});

test("export fails closed instead of turning an unreadable snapshot into blank Markdown", async () => {
  local.setItem("lab.document.v1", "not-json");

  await assert.rejects(
    () => exportLocalVault(),
    /could not be verified|unavailable|invalid snapshot/i,
  );
});

test("image validation is shared, case-tolerant, and rejects forged PNG bytes", () => {
  const uppercase = TEST_IMAGE.replace("data:image/png", "DATA:IMAGE/PNG");
  assert.equal(isValidLocalImageDataUrl(uppercase), true);
  const svg = `data:image/svg+xml;base64,${Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>").toString("base64")}`;
  assert.equal(isValidLocalImageDataUrl(svg), true);
  assert.equal(isValidLocalImageDataUrl("data:image/png;base64,AAAA"), false);

  const backup = buildVaultBackup([{
    ...session("default", "Untitled"),
    markdown: `![pixel](${uppercase})`,
  }]);
  assert.equal(backup.assets[0]?.dataUrl, TEST_IMAGE);
  assert.throws(() => parseVaultBackup({
    ...backup,
    assets: [{ id: "asset-1", dataUrl: "data:image/png;base64,AAAA", mimeType: "image/png" }],
  }), /valid local image/i);
});

test("asset replacement ignores fenced and inline code while deduplicating real images", async () => {
  const markdown = [
    "```markdown",
    `![literal](${TEST_IMAGE})`,
    "```",
    "",
    `\`![inline](${TEST_IMAGE})\``,
    "",
    "`literal code span",
    "![multiline literal](lab-asset://asset-1)",
    "`",
    "",
    `![real](${TEST_IMAGE})`,
  ].join("\n");
  const backup = buildVaultBackup([{ ...session("default", "Untitled"), markdown }]);

  assert.equal(backup.counts.assets, 1);
  assert.match(backup.sessions[0]?.markdown ?? "", /```markdown\n!\[literal\]\(data:image\/png/);
  assert.match(backup.sessions[0]?.markdown ?? "", /`!\[inline\]\(data:image\/png/);
  assert.match(backup.sessions[0]?.markdown ?? "", /`literal code span\n!\[multiline literal\]\(lab-asset:\/\/asset-1\)\n`/);
  assert.match(backup.sessions[0]?.markdown ?? "", /!\[real\]\(lab-asset:\/\/asset-1\)/);
  const restored = await restoreLocalVault(backup);
  assert.equal(restored.imported, 1);
  assert.equal(await loadLocalDocument(), markdown);
});

test("restore rejects repeated asset expansion before allocating an oversized string", () => {
  const backup = buildVaultBackup([{ ...session("default", "Untitled"), markdown: `![pixel](${TEST_IMAGE})` }]);
  const repeated = Array.from({ length: 150_000 }, () => "![pixel](lab-asset://asset-1)").join("\n");
  backup.sessions[0]!.markdown = repeated;

  assert.throws(
    () => parseVaultBackup(backup),
    /restored Markdown is oversized|restored Markdown payload is oversized/i,
  );
});

test("default restore preserves backup metadata while filling the empty editor session", async () => {
  local.setItem("lab.session.v1.default", JSON.stringify({
    id: "default",
    name: "Untitled",
    createdAt: 1,
    updatedAt: 2,
  }));
  const source = {
    ...session("default", "Restored home"),
    createdAt: 111,
    updatedAt: 222,
    markdown: "restored default",
  };

  const result = await restoreLocalVault(buildVaultBackup([source]));
  assert.equal(result.activeDocumentUpdated, true);
  assert.deepEqual(await getDocumentSession("default"), {
    id: source.id,
    name: source.name,
    titleSource: source.titleSource,
    pinned: source.pinned,
    archived: source.archived,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  });
  assert.equal(await loadLocalDocument(), source.markdown);
});

test("default fill CAS preserves a peer save and imports the backup under a fresh id", async () => {
  await saveLocalDocument("peer edit");
  const peerSnapshot = local.getItem("lab.document.v1");
  assert.ok(peerSnapshot);
  local.removeItem("lab.document.v1");
  local.setItem("lab.session.v1.default", JSON.stringify({
    id: "default",
    name: "Untitled",
    createdAt: 1,
    updatedAt: 2,
  }));
  let metadataReads = 0;
  local.onGet = (key) => {
    if (key !== "lab.session.v1.default" || ++metadataReads !== 2) return;
    local.setItem("lab.document.v1", peerSnapshot);
  };

  const result = await restoreLocalVault(buildVaultBackup([{
    ...session("default", "Backup home"),
    markdown: "backup content",
  }]));

  assert.equal(await loadLocalDocument(), "peer edit");
  assert.equal(result.imported, 1);
  assert.notEqual(result.importedSessionIds[0], DEFAULT_DOCUMENT_ID);
  assert.equal(await loadLocalDocumentForDocument(result.importedSessionIds[0]!), "backup content");
});

test("a later restore failure rolls back an earlier default fill", async () => {
  const originalMetadata = {
    id: "default",
    name: "Untitled",
    titleSource: "automatic" as const,
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 2,
  };
  local.setItem("lab.session.v1.default", JSON.stringify(originalMetadata));
  local.throwOnDocumentId = "rollback-child";

  await assert.rejects(
    () => restoreLocalVault(buildVaultBackup([
      { ...session("default", "Restored default"), markdown: "new default" },
      { ...session("rollback-child", "Child"), markdown: "child" },
    ])),
    /All changes from this restore were rolled back/i,
  );
  assert.equal(await loadLocalDocument(), "");
  assert.deepEqual(await getDocumentSession("default"), originalMetadata);
  assert.equal(local.getItem("lab.session.v1.rollback-child"), null);
});

test("rollback preserves a concurrently renamed imported session and reports incomplete cleanup", async () => {
  local.throwOnDocumentId = "z-failure";
  let changed = false;
  local.onSetAttempt = (key) => {
    if (changed || key !== "lab.document.v2.z-failure") return;
    changed = true;
    local.setItem("lab.session.v1.a-imported", JSON.stringify({
      id: "a-imported",
      name: "Peer rename",
      createdAt: 10,
      updatedAt: 21,
    }));
  };

  await assert.rejects(
    () => restoreLocalVault(buildVaultBackup([
      { ...session("a-imported", "Imported"), markdown: "restored content" },
      { ...session("z-failure", "Failure"), markdown: "cannot save" },
    ])),
    /Cleanup was incomplete.*a-imported content or metadata changed/i,
  );
  assert.deepEqual(await getDocumentSession("a-imported"), {
    id: "a-imported",
    name: "Peer rename",
    titleSource: "manual",
    pinned: false,
    archived: false,
    createdAt: 10,
    updatedAt: 21,
  });
  assert.equal(await loadLocalDocumentForDocument("a-imported"), "restored content");
});

test("rollback compare-and-delete preserves concurrently edited imported content", async () => {
  await saveLocalDocumentForDocument("a-imported", "peer content");
  const peerSnapshot = local.getItem("lab.document.v2.a-imported");
  assert.ok(peerSnapshot);
  local.removeItem("lab.document.v2.a-imported");
  local.throwOnDocumentId = "z-failure";
  let changed = false;
  local.onSetAttempt = (key) => {
    if (changed || key !== "lab.document.v2.z-failure") return;
    changed = true;
    local.setItem("lab.document.v2.a-imported", peerSnapshot);
  };

  await assert.rejects(
    () => restoreLocalVault(buildVaultBackup([
      { ...session("a-imported", "Imported"), markdown: "restored content" },
      { ...session("z-failure", "Failure"), markdown: "cannot save" },
    ])),
    /Cleanup was incomplete.*a-imported content or metadata changed/i,
  );
  assert.deepEqual(await getDocumentSession("a-imported"), session("a-imported", "Imported"));
  assert.equal(await loadLocalDocumentForDocument("a-imported"), "peer content");
});

test("restore marks an active metadata-less named URL for refresh", async () => {
  const active = session("active-session", "Active restored note");
  const result = await restoreLocalVault(
    buildVaultBackup([{ ...active, markdown: "active content" }]),
    { activeDocumentId: active.id },
  );

  assert.equal(result.activeDocumentUpdated, true);
  assert.equal(result.importedSessionIds[0], active.id);
  assert.equal(await loadLocalDocumentForDocument(active.id), "active content");
});

test("restore reports replica failure and removes newly-created metadata", async () => {
  const imported = session("quota-session", "Quota session");
  local.throwOnDocumentSet = true;

  await assert.rejects(
    () => restoreLocalVault(buildVaultBackup([{ ...imported, markdown: "must not orphan" }])),
    /incomplete redundant storage|not durably saved/i,
  );
  assert.equal(local.getItem(`lab.session.v1.${imported.id}`), null);
});

test("metadata write failures after commit do not leave a restore orphan", async () => {
  const imported = session("metadata-partial", "Metadata partial");
  local.throwAfterSessionSet = true;

  await assert.rejects(
    () => restoreLocalVault(buildVaultBackup([{ ...imported, markdown: "content" }])),
    /could not allocate|quota|restore session/i,
  );
  assert.equal(local.getItem(`lab.session.v1.${imported.id}`), null);
});

test("export rejects a session catalog mutation from another tab", async () => {
  await saveLocalDocument("initial");
  let injected = false;
  local.onGet = (key) => {
    if (injected || key !== "lab.document.v1") return;
    injected = true;
    local.setItem("lab.session.v1.raced", JSON.stringify({
      id: "raced",
      name: "Raced session",
      createdAt: 3,
      updatedAt: 4,
    }));
  };

  await assert.rejects(
    () => exportLocalVault(),
    /session catalog changed/i,
  );
});
