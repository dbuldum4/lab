export const DEFAULT_DOCUMENT_ID = "default";
const LEGACY_LOCAL_KEY = "lab.document.v1";
const LEGACY_PENDING_KEY = "lab.document.pending.v1";
const LEGACY_PENDING_KEY_PREFIX = "lab.document.pending.v2.";
const DB_NAME = "lab-private-vault";
const STORE_NAME = "documents";
const LEGACY_OPFS_FILE = "lab.md.snapshot";
const DB_VERSION = 2;
const LEGACY_AUTHORITY_KEY = "authority";
const LEGACY_CURRENT_KEY = "current";
const MAX_RECOVERY_DRAFTS = 8;

export type LocalSnapshot = {
  markdown: string;
  updatedAt: number;
  checksum: string;
  /** v1 is retained for reading existing notes; all new snapshots are v2. */
  version: 1 | 2;
};

type CanonicalSnapshot = LocalSnapshot & { version: 2 };

export type StorageHealth = {
  /** Number of readable replicas that agree with the newest valid snapshot. */
  copies: number;
  labels: string[];
  persistent: boolean;
  errors: string[];
  /** Number of distinct, verified cross-tab drafts available for export. */
  conflicts: number;
  /** Present on save results. False means this tab's candidate lost an authority conflict. */
  saved?: boolean;
};

export type LocalRecoveryDraft = {
  markdown: string;
  updatedAt: number;
};

type StorageTarget = {
  label: string;
  read: () => Promise<LocalSnapshot | null>;
  write: (snapshot: CanonicalSnapshot) => Promise<void>;
};

type ReadSnapshot = {
  target: StorageTarget;
  snapshot: CanonicalSnapshot | null;
  valid: boolean;
  migrated?: boolean;
  error?: string;
};

type PendingDocument = {
  markdown: string;
  updatedAt: number;
  /** v1 drafts are readable for backwards compatibility but never outrank durable data. */
  version: 1 | 2;
  /** A synchronous corruption check so page-hide staging does not need Web Crypto. */
  checksum?: string;
  /** Internal only: the localStorage slot this draft was read from. */
  storageKey?: string;
};

type AuthorityRecord = {
  recordVersion: 1;
  revision: number;
  snapshot: CanonicalSnapshot;
};

type AuthorityCommitResult = {
  accepted: boolean;
  changed: boolean;
  revision: number;
  rawSnapshot: LocalSnapshot | null;
  /** True when a durable deletion marker blocked the commit. */
  rejectedBecauseDeleted?: boolean;
};

export type LocalDocumentCompareSaveResult = {
  matched: boolean;
  health?: StorageHealth;
};

type DeletedRecord = {
  recordVersion: 1;
  deletedAt: number;
};

const VAULT_LOCK_PREFIX = "lab-private-vault";
const DELETED_KEY_PREFIX = "lab.document.deleted.v1.";

let vaultQueue: Promise<void> = Promise.resolve();
let lastIssuedTimestamp = 0;
let pendingOwner: string | null = null;
let webLocksUnavailable = false;
let activeDocumentId = DEFAULT_DOCUMENT_ID;
/** Bound for the duration of a queued vault operation so key helpers stay on the enqueued scope. */
let operationDocumentId: string | null = null;
/** Process-local tombstones so stage/save refuse even if localStorage setItem fails after IDB delete. */
const deletedDocuments = new Set<string>();

function normalizedDocumentId(documentId: string) {
  return /^[a-zA-Z0-9_-]{1,96}$/.test(documentId) ? documentId : DEFAULT_DOCUMENT_ID;
}

function currentDocumentId() {
  return operationDocumentId ?? activeDocumentId;
}

/** Select the document namespace for this page realm before loading or saving. */
export function setLocalDocumentScope(documentId: string) {
  const next = normalizedDocumentId(documentId);
  if (next === activeDocumentId) return;
  activeDocumentId = next;
  // Keep vaultQueue so in-flight work for the previous scope can finish under
  // its captured operationDocumentId instead of writing into the new namespace.
  lastIssuedTimestamp = 0;
  pendingOwner = null;
}

function deletedKey(documentId: string) {
  return `${DELETED_KEY_PREFIX}${normalizedDocumentId(documentId)}`;
}

function deletedIdbKey(documentId: string = currentDocumentId()) {
  return `deleted:${normalizedDocumentId(documentId)}`;
}

function isDeletedRecord(value: unknown): value is DeletedRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DeletedRecord>;
  return candidate.recordVersion === 1 && Number.isFinite(candidate.deletedAt);
}

/** True when another tab (or this one) has permanently deleted the document. */
export function isLocalDocumentDeleted(documentId: string = currentDocumentId()) {
  const id = normalizedDocumentId(documentId);
  if (deletedDocuments.has(id)) return true;
  const storage = getLocalStorage();
  if (!storage) return false;
  try {
    return storage.getItem(deletedKey(id)) !== null;
  } catch {
    return false;
  }
}

/** Persist a sync localStorage tombstone. Returns false when the marker could not be written. */
function writeLocalTombstone(documentId: string, deletedAt: number = Date.now()): boolean {
  const id = normalizedDocumentId(documentId);
  deletedDocuments.add(id);
  const storage = getLocalStorage();
  if (!storage) return false;
  try {
    storage.setItem(deletedKey(id), String(deletedAt));
    return true;
  } catch {
    return false;
  }
}

function clearLocalTombstone(documentId: string) {
  const id = normalizedDocumentId(documentId);
  deletedDocuments.delete(id);
  const storage = getLocalStorage();
  if (!storage) return;
  try {
    storage.removeItem(deletedKey(id));
  } catch {
    // Best-effort rollback when a delete aborts before completion.
  }
}

function isDefaultDocument(documentId: string = currentDocumentId()) {
  return normalizedDocumentId(documentId) === DEFAULT_DOCUMENT_ID;
}

function localSnapshotKey() {
  return isDefaultDocument() ? LEGACY_LOCAL_KEY : `lab.document.v2.${currentDocumentId()}`;
}

function legacyPendingKey() {
  return isDefaultDocument() ? LEGACY_PENDING_KEY : `lab.document.pending.v1.${currentDocumentId()}`;
}

function pendingKeyPrefix() {
  return isDefaultDocument() ? LEGACY_PENDING_KEY_PREFIX : `lab.document.pending.scoped.v2.${currentDocumentId()}.`;
}

/** IndexedDB authority key for an explicit document id (no ambient scope). */
function authorityKeyFor(documentId: string) {
  const id = normalizedDocumentId(documentId);
  return isDefaultDocument(id) ? LEGACY_AUTHORITY_KEY : `authority:${id}`;
}

/** IndexedDB current-snapshot key for an explicit document id (no ambient scope). */
function currentKeyFor(documentId: string) {
  const id = normalizedDocumentId(documentId);
  return isDefaultDocument(id) ? LEGACY_CURRENT_KEY : `current:${id}`;
}

function authorityKey() {
  return authorityKeyFor(currentDocumentId());
}

function currentKey() {
  return currentKeyFor(currentDocumentId());
}

function opfsFile() {
  return isDefaultDocument() ? LEGACY_OPFS_FILE : `lab.${currentDocumentId()}.md.snapshot`;
}

function getLocalStorage(): Storage | null {
  // Accessing the global property itself can throw SecurityError in privacy
  // modes. Keep the guard around the property access, not only its methods.
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function pendingStorageKey() {
  // A module-scoped owner is unique to this page realm. sessionStorage cannot
  // provide that guarantee because auxiliary and duplicated tabs can inherit a
  // copy of the opener's values. Reload recovery still works because load scans
  // every namespaced pending record before this page creates its next draft.
  if (!isBrowserContext()) return legacyPendingKey();
  pendingOwner ??= globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `${pendingKeyPrefix()}${pendingOwner}`;
}

function hasIndexedDb() {
  try {
    return typeof indexedDB !== "undefined";
  } catch {
    return false;
  }
}

function hasWebLocks() {
  if (webLocksUnavailable) return false;
  try {
    const browserNavigator = typeof navigator === "undefined" ? undefined : navigator;
    return typeof browserNavigator?.locks?.request === "function";
  } catch {
    return false;
  }
}

function isBrowserContext() {
  return typeof window !== "undefined";
}

async function withVaultLock<T>(documentId: string, operation: () => Promise<T>) {
  const browserNavigator = typeof navigator === "undefined" ? undefined : navigator;
  const locks = browserNavigator?.locks;
  if (!locks || typeof locks.request !== "function") return operation();

  let operationStarted = false;
  try {
    return await locks.request(`${VAULT_LOCK_PREFIX}:${documentId}`, { mode: "exclusive" }, () => {
      operationStarted = true;
      return operation();
    });
  } catch (error) {
    // Reads can continue without a lock, but remember that the exposed API is
    // unusable so saveLocalDocument will not authorize replica-only writes.
    if (!operationStarted) {
      webLocksUnavailable = true;
      return operation();
    }
    throw error;
  }
}

async function runWithDocumentScope<T>(documentId: string, operation: () => Promise<T>): Promise<T> {
  const previous = operationDocumentId;
  operationDocumentId = documentId;
  try {
    return await withVaultLock(documentId, operation);
  } finally {
    operationDocumentId = previous;
  }
}

/**
 * Serialize vault work. Captures the active document id at enqueue time so a
 * concurrent setLocalDocumentScope cannot redirect in-flight key helpers.
 */
function serializeVaultOperation<T>(operation: () => Promise<T>, documentId: string = activeDocumentId): Promise<T> {
  const scope = normalizedDocumentId(documentId);
  const result = vaultQueue.then(
    () => runWithDocumentScope(scope, operation),
    () => runWithDocumentScope(scope, operation),
  );
  // Keep the queue usable if an operation fails, while returning its error to its caller.
  vaultQueue = result.then(() => undefined, () => undefined);
  return result;
}

function subtleCrypto(): SubtleCrypto | null {
  try {
    return globalThis.crypto?.subtle ?? null;
  } catch {
    return null;
  }
}

async function digestText(value: string) {
  const subtle = subtleCrypto();
  if (!subtle) throw new Error("Secure hashing is unavailable in this browser.");
  const bytes = new TextEncoder().encode(value);
  const digest = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Lightweight synchronous corruption detection for page-hide recovery records. */
function recoveryChecksum(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function pendingChecksum(markdown: string, updatedAt: number) {
  return recoveryChecksum(JSON.stringify(["lab.pending.v2", updatedAt, markdown]));
}

async function legacyChecksum(markdown: string) {
  return digestText(markdown);
}

async function snapshotChecksum(markdown: string, updatedAt: number) {
  // Including ordering metadata prevents a valid content hash from being
  // paired with a forged timestamp and promoted over a newer snapshot.
  return digestText(JSON.stringify(["lab.snapshot.v2", updatedAt, markdown]));
}

async function makeSnapshot(markdown: string, updatedAt: number): Promise<CanonicalSnapshot> {
  return {
    markdown,
    updatedAt,
    checksum: await snapshotChecksum(markdown, updatedAt),
    version: 2,
  };
}

function isSnapshotShape(value: unknown): value is LocalSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LocalSnapshot>;
  return (
    (candidate.version === 1 || candidate.version === 2)
    && typeof candidate.markdown === "string"
    && typeof candidate.checksum === "string"
    && Number.isFinite(candidate.updatedAt)
  );
}

function orderingSnapshot(value: unknown): LocalSnapshot | null {
  return isSnapshotShape(value) ? value : null;
}

/** Verify a snapshot and migrate legacy v1 content to the authenticated v2 shape. */
async function normalizeSnapshot(value: unknown): Promise<CanonicalSnapshot | null> {
  if (!isSnapshotShape(value)) return null;
  if (value.version === 1) {
    if (value.checksum !== (await legacyChecksum(value.markdown))) return null;
    // v1 authenticated only the Markdown, not its timestamp. A migrated v1
    // replica must therefore never outrank an authenticated v2 replica.
    return makeSnapshot(value.markdown, 0);
  }
  return value.checksum === (await snapshotChecksum(value.markdown, value.updatedAt))
    ? { ...value, version: 2 }
    : null;
}

async function normalizeSnapshotPair(left: unknown, right: unknown) {
  if (isSnapshotShape(left) && isSnapshotShape(right) && sameSnapshot(left, right)) {
    const normalized = await normalizeSnapshot(left);
    return [normalized, normalized] as const;
  }
  const [normalizedLeft, normalizedRight] = await Promise.all([
    normalizeSnapshot(left),
    normalizeSnapshot(right),
  ]);
  return [normalizedLeft, normalizedRight] as const;
}

export function sameSnapshot(left: LocalSnapshot | null, right: LocalSnapshot | null) {
  return Boolean(
    left
    && right
    && left.version === right.version
    && left.updatedAt === right.updatedAt
    && left.checksum === right.checksum
    && left.markdown === right.markdown,
  );
}

/** Compare ordering metadata; positive means the left snapshot wins. */
export function compareSnapshotOrder(left: LocalSnapshot, right: LocalSnapshot) {
  if (left.updatedAt !== right.updatedAt) return left.updatedAt > right.updatedAt ? 1 : -1;
  return left.checksum.localeCompare(right.checksum);
}

/** The IndexedDB transaction uses this same rule while deciding a commit. */
export function shouldAcceptSnapshot(current: LocalSnapshot | null, candidate: LocalSnapshot) {
  return !current || compareSnapshotOrder(candidate, current) >= 0;
}

/** Pick a deterministic winner when a clock collision produces different snapshots. */
export function selectCurrentSnapshot(candidates: readonly LocalSnapshot[]): LocalSnapshot | null {
  return [...candidates].sort((left, right) => compareSnapshotOrder(right, left))[0] ?? null;
}

function rememberTimestamp(snapshot: LocalSnapshot | null) {
  if (snapshot) lastIssuedTimestamp = Math.max(lastIssuedTimestamp, snapshot.updatedAt);
}

function issueTimestamp() {
  const updatedAt = Math.max(Date.now(), lastIssuedTimestamp + 1);
  lastIssuedTimestamp = updatedAt;
  return updatedAt;
}

function openDatabase() {
  if (!hasIndexedDb()) throw new Error("IndexedDB is unavailable.");
  return new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open IndexedDB."));
    request.onblocked = () => reject(new Error("IndexedDB upgrade is blocked."));
  });
}

type IndexedDbRawState = {
  authority: unknown;
  current: unknown;
  deleted: unknown;
};

async function readIndexedDbRawState(): Promise<IndexedDbRawState> {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      let authority: unknown;
      let current: unknown;
      let deleted: unknown;
      const authorityRequest = store.get(authorityKey());
      authorityRequest.onsuccess = () => {
        authority = authorityRequest.result;
      };
      authorityRequest.onerror = () => reject(authorityRequest.error ?? new Error("Could not read IndexedDB."));
      const currentRequest = store.get(currentKey());
      currentRequest.onsuccess = () => {
        current = currentRequest.result;
      };
      currentRequest.onerror = () => reject(currentRequest.error ?? new Error("Could not read IndexedDB."));
      const deletedRequest = store.get(deletedIdbKey());
      deletedRequest.onsuccess = () => {
        deleted = deletedRequest.result;
      };
      deletedRequest.onerror = () => reject(deletedRequest.error ?? new Error("Could not read IndexedDB deletion marker."));
      transaction.oncomplete = () => resolve({ authority, current, deleted });
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not read IndexedDB."));
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB read was aborted."));
    });
  } finally {
    db.close();
  }
}

/**
 * Refresh process-local + localStorage tombstones from the durable IndexedDB marker.
 * Must run under the target document's vault scope (operationDocumentId / active scope).
 */
async function refreshDeletedFromIndexedDb(): Promise<boolean> {
  const id = currentDocumentId();
  if (isLocalDocumentDeleted(id)) return true;
  if (!hasIndexedDb()) return false;
  try {
    const raw = await readIndexedDbRawState();
    if (!isDeletedRecord(raw.deleted)) return false;
    writeLocalTombstone(id, raw.deleted.deletedAt);
    return true;
  } catch {
    return isLocalDocumentDeleted(id);
  }
}

/**
 * Throw when the document has a local or durable deletion marker.
 * Uses the vault queue so IndexedDB tombstones are visible across tabs.
 */
export async function ensureDocumentNotDeleted(documentId: string) {
  const id = normalizedDocumentId(documentId);
  if (id === DEFAULT_DOCUMENT_ID) return;
  if (isLocalDocumentDeleted(id)) {
    throw new Error("This session was deleted.");
  }
  await serializeVaultOperation(async () => {
    if (await refreshDeletedFromIndexedDb()) {
      throw new Error("This session was deleted.");
    }
  }, id);
}

function authorityRecord(value: unknown): AuthorityRecord | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<AuthorityRecord>;
  const revision = candidate.revision;
  if (
    candidate.recordVersion !== 1
    || !Number.isInteger(revision)
    || revision === undefined
    || revision < 0
    || !isSnapshotShape(candidate.snapshot)
  ) return null;
  return candidate as AuthorityRecord;
}

async function readIndexedDb(): Promise<LocalSnapshot | null> {
  const raw = await readIndexedDbRawState();
  const authority = authorityRecord(raw.authority);
  // The authority record is a convenience for atomic commits, not a reason to
  // hide a healthy `current` replica when the authority payload is corrupt.
  const [verifiedAuthority, verifiedCurrent] = await normalizeSnapshotPair(
    authority?.snapshot,
    raw.current,
  );
  return selectCurrentSnapshot(
    [verifiedAuthority, verifiedCurrent].filter((snapshot): snapshot is CanonicalSnapshot => Boolean(snapshot)),
  ) as CanonicalSnapshot | null;
}

/**
 * An authority record is only useful while its snapshot verifies. Repair a
 * corrupt record with a known-good replica using a compare-and-put so a newer
 * tab cannot be overwritten between the read and repair.
 */
async function repairCorruptIndexedDbAuthority(fallback: CanonicalSnapshot) {
  const raw = await readIndexedDbRawState();
  if (isDeletedRecord(raw.deleted)) {
    writeLocalTombstone(currentDocumentId(), raw.deleted.deletedAt);
    return;
  }
  const authority = authorityRecord(raw.authority);
  if (!authority || await normalizeSnapshot(authority.snapshot)) return;
  const current = await normalizeSnapshot(raw.current);
  const replacement = current ?? fallback;
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(authorityKey());
      request.onsuccess = () => {
        const latest = authorityRecord(request.result);
        if (latest
          && latest.revision === authority.revision
          && sameSnapshot(latest.snapshot, authority.snapshot)) {
          store.put({ recordVersion: 1, revision: latest.revision + 1, snapshot: replacement } satisfies AuthorityRecord, authorityKey());
          store.put(replacement, currentKey());
        }
      };
      request.onerror = () => reject(request.error ?? new Error("Could not read IndexedDB authority."));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not repair IndexedDB authority."));
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB authority repair was aborted."));
    });
  } finally {
    db.close();
  }
}

/**
 * Commit the candidate through an IndexedDB read/write transaction. IndexedDB
 * serializes transactions from different tabs, so this compare-and-put is the
 * cross-tab authority when navigator.locks is not available.
 */
function sameRawValue(left: unknown, right: unknown) {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

async function commitIndexedDbOnce(
  candidate: CanonicalSnapshot,
  observed: IndexedDbRawState,
  existing: CanonicalSnapshot | null,
  revision: number,
  isLegacyMigration: boolean,
): Promise<AuthorityCommitResult | null> {
  const db = await openDatabase();
  try {
    return await new Promise<AuthorityCommitResult | null>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      let authorityRaw: unknown;
      let currentRaw: unknown;
      let deletedRaw: unknown;
      let authorityDone = false;
      let currentDone = false;
      let deletedDone = false;
      let decisionMade = false;
      let result: AuthorityCommitResult | null = null;
      const finish = () => {
        if (!authorityDone || !currentDone || !deletedDone || decisionMade) return;
        decisionMade = true;
        // SHA-256 verification is asynchronous, so it happens before this
        // transaction. If either record changed since that verification, retry
        // from a fresh observation rather than trusting an unverified value.
        if (!sameRawValue(authorityRaw, observed.authority)
          || !sameRawValue(currentRaw, observed.current)
          || !sameRawValue(deletedRaw, observed.deleted)) return;
        if (isDeletedRecord(deletedRaw)) {
          result = {
            accepted: false,
            changed: false,
            revision,
            rawSnapshot: null,
            rejectedBecauseDeleted: true,
          };
          return;
        }
        if (!isLegacyMigration && !shouldAcceptSnapshot(existing, candidate)) {
          result = { accepted: false, changed: false, revision, rawSnapshot: existing };
          return;
        }
        if (existing && !isLegacyMigration && compareSnapshotOrder(candidate, existing) === 0) {
          result = { accepted: true, changed: false, revision, rawSnapshot: existing };
          return;
        }
        const nextRevision = revision + 1;
        store.put({ recordVersion: 1, revision: nextRevision, snapshot: candidate } satisfies AuthorityRecord, authorityKey());
        store.put(candidate, currentKey());
        result = { accepted: true, changed: true, revision: nextRevision, rawSnapshot: candidate };
      };
      const authorityRequest = store.get(authorityKey());
      authorityRequest.onsuccess = () => {
        authorityRaw = authorityRequest.result;
        authorityDone = true;
        finish();
      };
      authorityRequest.onerror = () => reject(authorityRequest.error ?? new Error("Could not read IndexedDB authority."));
      const currentRequest = store.get(currentKey());
      currentRequest.onsuccess = () => {
        currentRaw = currentRequest.result;
        currentDone = true;
        finish();
      };
      currentRequest.onerror = () => reject(currentRequest.error ?? new Error("Could not read IndexedDB current snapshot."));
      const deletedRequest = store.get(deletedIdbKey());
      deletedRequest.onsuccess = () => {
        deletedRaw = deletedRequest.result;
        deletedDone = true;
        finish();
      };
      deletedRequest.onerror = () => reject(deletedRequest.error ?? new Error("Could not read IndexedDB deletion marker."));
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not commit IndexedDB authority."));
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB authority commit was aborted."));
    });
  } finally {
    db.close();
  }
}

async function commitIndexedDb(candidate: CanonicalSnapshot): Promise<AuthorityCommitResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const observed = await readIndexedDbRawState();
    if (isDeletedRecord(observed.deleted)) {
      writeLocalTombstone(currentDocumentId(), observed.deleted.deletedAt);
      return {
        accepted: false,
        changed: false,
        revision: 0,
        rawSnapshot: null,
        rejectedBecauseDeleted: true,
      };
    }
    const authority = authorityRecord(observed.authority);
    const [verifiedAuthority, verifiedCurrent] = await normalizeSnapshotPair(
      authority?.snapshot,
      observed.current,
    );
    const existing = selectCurrentSnapshot(
      [verifiedAuthority, verifiedCurrent].filter((snapshot): snapshot is CanonicalSnapshot => Boolean(snapshot)),
    ) as CanonicalSnapshot | null;
    const revision = authority?.revision ?? (existing ? 1 : 0);
    const rawExisting = verifiedAuthority && sameSnapshot(verifiedAuthority, existing)
      ? authority?.snapshot
      : verifiedCurrent && sameSnapshot(verifiedCurrent, existing)
        ? orderingSnapshot(observed.current)
        : null;
    const isLegacyMigration = Boolean(
      rawExisting
      && rawExisting.version === 1
      && existing
      && existing.markdown === candidate.markdown,
    );
    const result = await commitIndexedDbOnce(
      candidate,
      observed,
      existing,
      revision,
      isLegacyMigration,
    );
    if (result) return result;
  }
  throw new Error("IndexedDB authority changed during commit.");
}

/** Commit only if the exact authenticated authority snapshot is still current. */
async function commitIndexedDbIfSnapshot(
  expected: CanonicalSnapshot | null,
  candidate: CanonicalSnapshot,
): Promise<AuthorityCommitResult | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const observed = await readIndexedDbRawState();
    if (isDeletedRecord(observed.deleted)) return null;
    const authority = authorityRecord(observed.authority);
    const [verifiedAuthority, verifiedCurrent] = await normalizeSnapshotPair(
      authority?.snapshot,
      observed.current,
    );
    const existing = selectCurrentSnapshot(
      [verifiedAuthority, verifiedCurrent].filter((snapshot): snapshot is CanonicalSnapshot => Boolean(snapshot)),
    ) as CanonicalSnapshot | null;
    if ((expected || existing) && !sameSnapshot(expected, existing)) return null;
    const revision = authority?.revision ?? (existing ? 1 : 0);
    const result = await commitIndexedDbOnce(candidate, observed, existing, revision, false);
    if (result) return result;
  }
  throw new Error("IndexedDB authority changed repeatedly during compare-and-save.");
}

/** Delete authority/current only if the exact authenticated snapshot remains current. */
async function commitIndexedDbDeletionIfSnapshot(
  documentId: string,
  expected: CanonicalSnapshot,
  deletedAt: number,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const observed = await readIndexedDbRawState();
    if (isDeletedRecord(observed.deleted)) return false;
    const authority = authorityRecord(observed.authority);
    const [verifiedAuthority, verifiedCurrent] = await normalizeSnapshotPair(
      authority?.snapshot,
      observed.current,
    );
    const existing = selectCurrentSnapshot(
      [verifiedAuthority, verifiedCurrent].filter((snapshot): snapshot is CanonicalSnapshot => Boolean(snapshot)),
    ) as CanonicalSnapshot | null;
    if (!sameSnapshot(existing, expected)) return false;

    const db = await openDatabase();
    try {
      const result = await new Promise<boolean | null>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        let authorityRaw: unknown;
        let currentRaw: unknown;
        let deletedRaw: unknown;
        let completed = 0;
        let decision: boolean | null = null;
        const decide = () => {
          completed += 1;
          if (completed !== 3) return;
          if (!sameRawValue(authorityRaw, observed.authority)
            || !sameRawValue(currentRaw, observed.current)
            || !sameRawValue(deletedRaw, observed.deleted)) return;
          store.put({ recordVersion: 1, deletedAt } satisfies DeletedRecord, deletedIdbKey(documentId));
          store.delete(authorityKeyFor(documentId));
          store.delete(currentKeyFor(documentId));
          decision = true;
        };
        for (const [key, assign] of [
          [authorityKeyFor(documentId), (value: unknown) => { authorityRaw = value; }],
          [currentKeyFor(documentId), (value: unknown) => { currentRaw = value; }],
          [deletedIdbKey(documentId), (value: unknown) => { deletedRaw = value; }],
        ] as const) {
          const request = store.get(key);
          request.onsuccess = () => { assign(request.result); decide(); };
          request.onerror = () => reject(request.error ?? new Error("Could not compare IndexedDB authority."));
        }
        transaction.oncomplete = () => resolve(decision);
        transaction.onerror = () => reject(transaction.error ?? new Error("Could not delete IndexedDB authority."));
        transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB compare-and-delete was aborted."));
      });
      if (result !== null) return result;
    } finally {
      db.close();
    }
  }
  throw new Error("IndexedDB authority changed repeatedly during compare-and-delete.");
}

/**
 * Atomically record deletion and drop authority/current rows for this document.
 * IndexedDB transaction order is the cross-tab barrier when Web Locks are missing.
 */
async function commitIndexedDbDeletion(documentId: string, deletedAt: number) {
  const id = normalizedDocumentId(documentId);
  // All keys are derived from `id` so this never depends on ambient vault scope.
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      store.put({ recordVersion: 1, deletedAt } satisfies DeletedRecord, deletedIdbKey(id));
      store.delete(authorityKeyFor(id));
      store.delete(currentKeyFor(id));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not record IndexedDB deletion."));
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB deletion was aborted."));
    });
  } finally {
    db.close();
  }
}

function purgeLocalReplicas() {
  const local = getLocalStorage();
  if (!local) return;
  local.removeItem(localSnapshotKey());
  local.removeItem(legacyPendingKey());
  const keys: string[] = [];
  for (let index = 0; index < local.length; index += 1) {
    const key = local.key(index);
    if (key?.startsWith(pendingKeyPrefix())) keys.push(key);
  }
  for (const key of keys) local.removeItem(key);
}

async function purgeOpfsReplica() {
  const root = await opfsRoot();
  if (!root) return;
  try {
    await root.removeEntry(opfsFile());
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

type StorageManagerWithDirectory = StorageManager & {
  getDirectory?: () => Promise<FileSystemDirectoryHandle>;
};

async function opfsRoot() {
  const storage = typeof navigator === "undefined"
    ? undefined
    : (navigator.storage as StorageManagerWithDirectory | undefined);
  return storage?.getDirectory?.();
}

function isNotFound(error: unknown) {
  return typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "NotFoundError";
}

async function readOpfs(): Promise<LocalSnapshot | null> {
  const root = await opfsRoot();
  if (!root) return null;
  try {
    const handle = await root.getFileHandle(opfsFile());
    const file = await handle.getFile();
    return JSON.parse(await file.text()) as LocalSnapshot;
  } catch (error) {
    if (isNotFound(error)) return null;
    if (error instanceof SyntaxError) throw new Error("The browser file system contains an invalid snapshot.");
    throw error;
  }
}

async function writeOpfs(snapshot: CanonicalSnapshot) {
  const root = await opfsRoot();
  // OPFS is an optional replica. An environment without the API (for example
  // a privacy-restricted browser or the Node test runtime) is not a quota or
  // write failure; IndexedDB/localStorage remain the durable path.
  if (!root) return;
  const handle = await root.getFileHandle(opfsFile(), { create: true });
  const writer = await handle.createWritable();
  try {
    await writer.write(JSON.stringify(snapshot));
  } finally {
    await writer.close();
  }
}

function readLocalStorage(): LocalSnapshot | null {
  const storage = getLocalStorage();
  if (!storage) throw new Error("localStorage is unavailable.");
  let value: string | null;
  try {
    value = storage.getItem(localSnapshotKey());
  } catch {
    throw new Error("localStorage is unavailable.");
  }
  if (!value) return null;
  try {
    return JSON.parse(value) as LocalSnapshot;
  } catch {
    // Surface corruption to strict backup callers. Normal load/reconciliation
    // still repairs this copy when another verified replica is available.
    throw new Error("localStorage contains an invalid snapshot.");
  }
}

async function writeLocalStorage(snapshot: CanonicalSnapshot) {
  const storage = getLocalStorage();
  if (!storage) throw new Error("localStorage is unavailable.");
  try {
    storage.setItem(localSnapshotKey(), JSON.stringify(snapshot));
  } catch {
    throw new Error("Could not write localStorage.");
  }
}

function pendingDocumentsFromStorage(storage: Storage, currentKey: string) {
  const keys = new Set<string>([currentKey, legacyPendingKey()]);
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key === legacyPendingKey() || key?.startsWith(pendingKeyPrefix())) keys.add(key);
    }
  } catch {
    // A storage implementation may expose neither enumeration nor all keys.
  }
  return [...keys];
}

function parsePendingDocument(value: string | null, storageKey: string): PendingDocument | null {
  if (!value) return null;
  try {
    const pending = JSON.parse(value) as PendingDocument;
    if ((pending.version !== 1 && pending.version !== 2)
      || typeof pending.markdown !== "string"
      || !Number.isFinite(pending.updatedAt)
      || (pending.version === 2 && typeof pending.checksum !== "string")) return null;
    return { ...pending, storageKey };
  } catch {
    return null;
  }
}

/** Read the current tab's record plus discoverable namespaced recovery records. */
function readPendingDocuments(): PendingDocument[] {
  const storage = getLocalStorage();
  if (!storage) return [];
  const currentKey = pendingStorageKey();
  const documents: PendingDocument[] = [];
  for (const key of pendingDocumentsFromStorage(storage, currentKey)) {
    try {
      const pending = parsePendingDocument(storage.getItem(key), key);
      if (pending) documents.push(pending);
    } catch {
      // Continue past an inaccessible or malformed recovery slot.
    }
  }
  return documents;
}

function currentPendingDocument(documents: readonly PendingDocument[]) {
  const currentKey = pendingStorageKey();
  return documents.find((document) => document.storageKey === currentKey)
    ?? documents.find((document) => document.storageKey === legacyPendingKey())
    ?? null;
}

function readPendingDocument(): PendingDocument | null {
  return currentPendingDocument(readPendingDocuments());
}

function samePendingDocument(left: PendingDocument | null, right: PendingDocument | null) {
  if (!left || !right) return left === right;
  return left.version === right.version
    && left.updatedAt === right.updatedAt
    && left.checksum === right.checksum
    && left.storageKey === right.storageKey
    && left.markdown === right.markdown;
}

function clearPendingDocument(expected: PendingDocument | null = null) {
  const storage = getLocalStorage();
  if (!storage) return;
  const current = expected
    ? readPendingDocuments().find((document) => document.storageKey === expected.storageKey) ?? null
    : null;
  if (!samePendingDocument(current, expected)) return;
  try {
    storage.removeItem(expected?.storageKey ?? pendingStorageKey());
  } catch {
    // The pending draft is best-effort; the durable replicas remain authoritative.
  }
}

/**
 * Stage the newest editor value synchronously before the debounced replica write.
 * This gives pagehide/unload a local recovery point even if async storage writes are cut short.
 * Synchronous by design: IndexedDB tombstones are promoted to localStorage/memory
 * asynchronously via refreshDeletedFromIndexedDb() in load/save paths. A peer
 * delete that exists only in IndexedDB may still stage once before the next
 * async vault operation; the subsequent save will then fail with saved:false
 * and surface the deleted-session notice.
 */
export function stageLocalDocument(markdown: string) {
  if (isLocalDocumentDeleted()) return false;
  const storage = getLocalStorage();
  if (!storage) return false;
  const updatedAt = issueTimestamp();
  const pending: PendingDocument = {
    markdown,
    updatedAt,
    checksum: pendingChecksum(markdown, updatedAt),
    version: 2,
  };
  try {
    storage.setItem(pendingStorageKey(), JSON.stringify(pending));
    return true;
  } catch {
    return false;
  }
}

type PendingSnapshotRead = {
  snapshot: CanonicalSnapshot | null;
  verificationUnavailable: boolean;
  legacy: boolean;
};

async function readPendingSnapshot(pending: PendingDocument | null): Promise<PendingSnapshotRead> {
  if (!pending) return { snapshot: null, verificationUnavailable: false, legacy: false };
  // Old staging records had no checksum. Keep them for manual recovery, but do
  // not let an unverified timestamp promote them over a durable replica.
  if (pending.version === 1) return { snapshot: null, verificationUnavailable: false, legacy: true };
  if (pending.checksum !== pendingChecksum(pending.markdown, pending.updatedAt)) {
    return { snapshot: null, verificationUnavailable: false, legacy: false };
  }
  try {
    return {
      snapshot: await makeSnapshot(pending.markdown, pending.updatedAt),
      verificationUnavailable: false,
      legacy: false,
    };
  } catch {
    // A staged draft is a recovery artifact. Keep it when hashing is unavailable;
    // verification failure must never make recovery data disappear.
    return { snapshot: null, verificationUnavailable: true, legacy: false };
  }
}

type PendingCandidate = {
  document: PendingDocument;
  read: PendingSnapshotRead;
  snapshot: CanonicalSnapshot;
};

function comparePendingCandidates(left: PendingCandidate, right: PendingCandidate) {
  return compareSnapshotOrder(right.snapshot, left.snapshot);
}

function selectPendingCandidate(candidates: readonly PendingCandidate[]) {
  return candidates.reduce<PendingCandidate | null>((winner, candidate) => (
    !winner || shouldAcceptSnapshot(winner.snapshot, candidate.snapshot) ? candidate : winner
  ), null);
}

function selectPendingFallback(
  documents: readonly PendingDocument[],
  reads: readonly PendingSnapshotRead[],
) {
  return documents.reduce<PendingDocument | null>((winner, document, index) => {
    const read = reads[index];
    if (!read.verificationUnavailable) return winner;
    if (!winner) return document;
    if (document.updatedAt !== winner.updatedAt) {
      return document.updatedAt > winner.updatedAt ? document : winner;
    }
    return (document.checksum ?? "").localeCompare(winner.checksum ?? "") >= 0 ? document : winner;
  }, null);
}

function recoveryCandidates(
  candidates: readonly PendingCandidate[],
  durableWinner: CanonicalSnapshot | null,
  currentPending: PendingDocument | null,
) {
  if (!durableWinner) return [];
  const markdownSeen = new Set<string>();
  return [...candidates]
    .sort(comparePendingCandidates)
    .filter((candidate) => candidate.document.storageKey !== currentPending?.storageKey)
    .filter((candidate) => candidate.snapshot.markdown !== durableWinner.markdown)
    .filter((candidate) => {
      if (markdownSeen.has(candidate.snapshot.markdown)) return false;
      markdownSeen.add(candidate.snapshot.markdown);
      return true;
    });
}

function prunePendingDocuments(
  candidates: readonly PendingCandidate[],
  durableWinner: CanonicalSnapshot,
  currentPending: PendingDocument | null,
) {
  const retainedMarkdown = new Set<string>();
  let retained = 0;
  for (const candidate of [...candidates].sort(comparePendingCandidates)) {
    if (candidate.snapshot.markdown === durableWinner.markdown) {
      clearPendingDocument(candidate.document);
      continue;
    }
    if (candidate.document.storageKey === currentPending?.storageKey) continue;
    if (retainedMarkdown.has(candidate.snapshot.markdown) || retained >= MAX_RECOVERY_DRAFTS) {
      clearPendingDocument(candidate.document);
      continue;
    }
    retainedMarkdown.add(candidate.snapshot.markdown);
    retained += 1;
  }
}

/**
 * Keep recovery storage bounded even when no durable replica exists yet. Only
 * v2 records whose synchronous checksum verified are eligible; legacy or
 * otherwise unverifiable records remain available for manual recovery.
 */
function prunePendingDocumentsWithoutDurable(
  documents: readonly PendingDocument[],
  reads: readonly PendingSnapshotRead[],
  currentPending: PendingDocument | null,
) {
  const currentKey = currentPending?.storageKey;
  const retainedKeys = new Set<string>();
  const retainedMarkdown = new Set<string>();
  const currentIndex = currentPending
    ? documents.findIndex((document) => document.storageKey === currentKey)
    : -1;
  const currentRead = currentIndex >= 0 ? reads[currentIndex] : undefined;
  if (currentPending && (currentRead?.snapshot || currentRead?.verificationUnavailable)) {
    retainedKeys.add(currentPending.storageKey ?? "");
    retainedMarkdown.add(currentPending.markdown);
  }

  const eligible = documents.flatMap((document, index) => {
    const read = reads[index];
    return read?.snapshot || read?.verificationUnavailable ? [{ document, read }] : [];
  }).sort((left, right) => {
    if (left.document.updatedAt !== right.document.updatedAt) {
      return right.document.updatedAt - left.document.updatedAt;
    }
    return (right.document.checksum ?? "").localeCompare(left.document.checksum ?? "");
  });
  let remaining = Math.max(0, MAX_RECOVERY_DRAFTS - retainedKeys.size);

  for (const candidate of eligible) {
    if (candidate.document.storageKey === currentKey) continue;
    if (
      retainedMarkdown.has(candidate.document.markdown)
      || remaining === 0
    ) {
      clearPendingDocument(candidate.document);
      continue;
    }
    retainedKeys.add(candidate.document.storageKey ?? "");
    retainedMarkdown.add(candidate.document.markdown);
    remaining -= 1;
  }
}

const LOCAL_STORAGE_TARGET: StorageTarget = {
  label: "localStorage",
  read: () => Promise.resolve().then(readLocalStorage),
  write: writeLocalStorage,
};

const INDEXED_DB_TARGET: StorageTarget = {
  label: "IndexedDB",
  read: readIndexedDb,
  // This is only used by the explicit single-context fallback. Normal saves
  // call commitIndexedDb directly so the authority decision stays atomic.
  write: async (snapshot) => {
    const result = await commitIndexedDb(snapshot);
    if (!result.accepted) throw new Error("A newer IndexedDB snapshot already exists.");
  },
};

const OPFS_TARGET: StorageTarget = {
  label: "browser file system",
  read: readOpfs,
  write: writeOpfs,
};

const TARGETS: StorageTarget[] = [LOCAL_STORAGE_TARGET, INDEXED_DB_TARGET, OPFS_TARGET];
const REPLICA_TARGETS: StorageTarget[] = [LOCAL_STORAGE_TARGET, OPFS_TARGET];

function describeError(label: string) {
  return `${label} is unavailable`;
}

async function readSnapshots(): Promise<ReadSnapshot[]> {
  const results = await Promise.allSettled(TARGETS.map((target) => target.read()));
  return Promise.all(results.map(async (result, index) => {
    const target = TARGETS[index];
    if (result.status === "rejected") {
      return { target, snapshot: null, valid: false, error: describeError(target.label) };
    }
    try {
      const snapshot = await normalizeSnapshot(result.value);
      return {
        target,
        snapshot,
        valid: Boolean(snapshot),
        migrated: Boolean(snapshot && result.value?.version === 1),
        error: result.value && !snapshot ? `${target.label} contains an invalid snapshot` : undefined,
      };
    } catch {
      return { target, snapshot: null, valid: false, error: `${target.label} could not be verified` };
    }
  }));
}

async function persistentStorageGranted() {
  try {
    const storage = typeof navigator === "undefined" ? undefined : navigator.storage;
    return (await storage?.persisted?.()) ?? false;
  } catch {
    return false;
  }
}

/**
 * Replica writes happen after the authority commit. The authority check here
 * is only a freshness optimization for replicas; it is not used as a lock or
 * represented as an atomic localStorage/OPFS compare-and-set.
 *
 * Without Web Locks, a peer can finish deleteLocalDocument after our authority
 * commit and before replicas complete. Always re-check the durable deletion
 * marker so we never repopulate localStorage/OPFS for a deleted document.
 */
async function writeReplicaIfCurrent(target: StorageTarget, snapshot: CanonicalSnapshot) {
  if (hasIndexedDb()) {
    const raw = await readIndexedDbRawState();
    if (isDeletedRecord(raw.deleted)) {
      writeLocalTombstone(currentDocumentId(), raw.deleted.deletedAt);
      return false;
    }
    const authority = authorityRecord(raw.authority);
    const [verifiedAuthority, verifiedCurrent] = await normalizeSnapshotPair(
      authority?.snapshot,
      raw.current,
    );
    const current = selectCurrentSnapshot(
      [verifiedAuthority, verifiedCurrent].filter((candidate): candidate is CanonicalSnapshot => Boolean(candidate)),
    );
    if (current && !sameSnapshot(current, snapshot) && !shouldAcceptSnapshot(current, snapshot)) return false;
  }
  // Peer delete can land during the async authority read above.
  if (await refreshDeletedFromIndexedDb()) return false;
  return writeSnapshotIfNewer(target, snapshot);
}

/** Best-effort only; used under Web Locks or in the Node single-context fallback. */
async function writeSnapshotIfNewer(target: StorageTarget, snapshot: CanonicalSnapshot) {
  let current: LocalSnapshot | null;
  try {
    current = await target.read();
  } catch {
    await target.write(snapshot);
    return true;
  }

  try {
    const normalized = await normalizeSnapshot(current);
    if (normalized && !shouldAcceptSnapshot(normalized, snapshot)) return false;
  } catch {
    // The authority path has already authenticated the candidate. If this
    // replica cannot be verified, replacing its corrupt copy is recovery work.
  }

  await target.write(snapshot);
  return true;
}

type ReconciliationResult = {
  winner: CanonicalSnapshot;
  promoted: boolean;
};

async function reconcileSnapshots(winner: CanonicalSnapshot, reads: ReadSnapshot[]): Promise<ReconciliationResult> {
  let authoritativeWinner = winner;
  let replicaRepairAllowed = !isBrowserContext() || hasWebLocks();
  if (hasIndexedDb()) {
    try {
      await repairCorruptIndexedDbAuthority(winner);
      const result = await commitIndexedDb(winner);
      const normalized = await normalizeSnapshot(result.rawSnapshot);
      if (normalized) authoritativeWinner = normalized;
      replicaRepairAllowed = true;
    } catch {
      // A replica can still be read while IndexedDB is temporarily unavailable.
      // Do not make recovery depend on repairing every copy in that case, and
      // do not fall back to an unsafe cross-tab replica write.
      return { winner: authoritativeWinner, promoted: false };
    }
  }

  if (!replicaRepairAllowed) return { winner: authoritativeWinner, promoted: false };

  const staleReplicas = reads.filter((read) => (
    read.target.label !== INDEXED_DB_TARGET.label
    && (!read.valid || read.migrated || !sameSnapshot(read.snapshot, authoritativeWinner))
  ));
  const writes = await Promise.allSettled(
    staleReplicas.map((read) => writeReplicaIfCurrent(read.target, authoritativeWinner)),
  );
  return {
    winner: authoritativeWinner,
    promoted: writes.some((write) => write.status === "fulfilled" && write.value),
  };
}

async function inspectLocalStorageNow(extraErrors: string[] = []): Promise<StorageHealth> {
  const reads = await readSnapshots();
  const indexedDbAvailable = hasIndexedDb();
  let opfsAvailable = false;
  try {
    opfsAvailable = Boolean(await opfsRoot());
  } catch {
    // An OPFS API can exist but reject access in a privacy-restricted context;
    // classify that as an unavailable optional replica so health inspection
    // still reports the usable authority/replicas accurately.
    opfsAvailable = false;
  }
  const isOptionalReplicaUnavailable = (label: string) => (
    (label === INDEXED_DB_TARGET.label && !indexedDbAvailable)
    || (label === OPFS_TARGET.label && !opfsAvailable)
  );
  const winner = selectCurrentSnapshot(
    reads.filter((read) => read.valid && read.snapshot).map((read) => read.snapshot as CanonicalSnapshot),
  );
  rememberTimestamp(winner);
  const labels = winner
    ? reads.filter((read) => read.valid && sameSnapshot(read.snapshot, winner)).map((read) => read.target.label)
    : [];
  const staleErrors = winner
    ? reads
      .filter((read) => !isOptionalReplicaUnavailable(read.target.label))
      .filter((read) => !read.error && (!read.valid || !sameSnapshot(read.snapshot, winner)))
      .map((read) => `${read.target.label} is out of sync`)
    : [];
  const authorityErrors = isBrowserContext() && !indexedDbAvailable && !hasWebLocks()
    ? ["Cross-tab persistence requires IndexedDB or Web Locks."]
    : [];
  const pendingDocuments = readPendingDocuments();
  const currentPending = currentPendingDocument(pendingDocuments);
  const pendingReads = await Promise.all(pendingDocuments.map(readPendingSnapshot));
  const pendingCandidates = pendingDocuments.flatMap((document, index) => {
    const read = pendingReads[index];
    return read.snapshot ? [{ document, read, snapshot: read.snapshot }] : [];
  });
  return {
    copies: labels.length,
    labels,
    persistent: await persistentStorageGranted(),
    conflicts: recoveryCandidates(pendingCandidates, winner as CanonicalSnapshot | null, currentPending).length,
    errors: [...new Set([
      ...extraErrors,
      ...authorityErrors,
      ...staleErrors,
      ...reads.flatMap((read) => (
        read.error && !isOptionalReplicaUnavailable(read.target.label) ? [read.error] : []
      )),
    ])],
  };
}

async function loadLocalDocumentInScope() {
    if (await refreshDeletedFromIndexedDb()) return "";

    const reads = await readSnapshots();
    const pendingDocuments = readPendingDocuments();
    const pendingDocument = currentPendingDocument(pendingDocuments);
    const pendingReads = await Promise.all(pendingDocuments.map(readPendingSnapshot));
    const pendingCandidates = pendingDocuments.flatMap((document, index) => {
      const read = pendingReads[index];
      return read.snapshot ? [{ document, read, snapshot: read.snapshot }] : [];
    });
    const pendingWinner = selectPendingCandidate(pendingCandidates);
    const durableCandidates = reads
      .filter((read) => read.valid && read.snapshot)
      .map((read) => read.snapshot as CanonicalSnapshot);
    let winner = selectCurrentSnapshot(durableCandidates);

    if (pendingWinner && (!winner || shouldAcceptSnapshot(winner, pendingWinner.snapshot))) {
      winner = pendingWinner.snapshot;
    }

    if (!winner) {
      // Hashing may be unavailable while a staged draft is still perfectly
      // readable. Return it and leave the recovery key untouched.
      prunePendingDocumentsWithoutDurable(pendingDocuments, pendingReads, pendingDocument);
      const pendingFallback = selectPendingFallback(pendingDocuments, pendingReads);
      if (pendingFallback) return pendingFallback.markdown;
      if (pendingDocument) {
        const pendingRead = pendingReads[pendingDocuments.indexOf(pendingDocument)];
        if (pendingRead?.legacy) return pendingDocument.markdown;
      }
      return "";
    }

    rememberTimestamp(winner);
    const reconciliation = await reconcileSnapshots(winner as CanonicalSnapshot, reads);
    const actualWinner = reconciliation.winner;

    const winnerIsDurable = reconciliation.promoted
      || reads.some((read) => read.valid && sameSnapshot(read.snapshot, actualWinner));
    if (winnerIsDurable) {
      prunePendingDocuments(pendingCandidates, actualWinner, pendingDocument);
    } else {
      prunePendingDocumentsWithoutDurable(pendingDocuments, pendingReads, pendingDocument);
    }
    // If verification was unavailable, deliberately do not clear its pending record.
    return actualWinner.markdown;
}

/**
 * Read a durable document for cross-session consumers without touching
 * recovery drafts, timestamps, tombstones, or any replica. A null result is a
 * verified deletion marker; an empty string is a live document with no data.
 */
async function readVerifiedLocalDocumentNow(): Promise<string | null> {
  const id = currentDocumentId();
  if (isLocalDocumentDeleted(id)) return null;

  if (hasIndexedDb()) {
    try {
      const raw = await readIndexedDbRawState();
      if (isDeletedRecord(raw.deleted)) return null;
    } catch {
      if (isLocalDocumentDeleted(id)) return null;
    }
  }

  const reads = await readSnapshots();

  // Deletion can be published by a peer while the replicas are being read.
  // Recheck without promoting the marker into localStorage: this path must be
  // safe to call while indexing an inactive session.
  if (isLocalDocumentDeleted(id)) return null;
  if (hasIndexedDb()) {
    try {
      const raw = await readIndexedDbRawState();
      if (isDeletedRecord(raw.deleted)) return null;
    } catch {
      if (isLocalDocumentDeleted(id)) return null;
    }
  }

  const winner = selectCurrentSnapshot(
    reads.filter((read) => read.valid && read.snapshot).map((read) => read.snapshot as CanonicalSnapshot),
  );
  return winner?.markdown ?? "";
}

/** Read only durable replicas for an explicit session namespace. */
export function readVerifiedLocalDocument(documentId: string = activeDocumentId) {
  return serializeVaultOperation(readVerifiedLocalDocumentNow, documentId);
}

/** Load a verified local document, optionally from an explicit session namespace. */
export function loadLocalDocument(documentId: string = activeDocumentId) {
  return serializeVaultOperation(loadLocalDocumentInScope, normalizedDocumentId(documentId));
}

/** Explicit alias used by whole-vault operations for clarity at call sites. */
export function loadLocalDocumentForDocument(documentId: string) {
  return loadLocalDocument(documentId);
}

/** Inspect a document without changing this page's active scope. */
export function inspectLocalStorageForDocument(documentId: string): Promise<StorageHealth> {
  return serializeVaultOperation(inspectLocalStorageNow, normalizedDocumentId(documentId));
}

export function listLocalRecoveryDrafts(): Promise<LocalRecoveryDraft[]> {
  return serializeVaultOperation(async () => {
    const reads = await readSnapshots();
    const durableWinner = selectCurrentSnapshot(
      reads.filter((read) => read.valid && read.snapshot).map((read) => read.snapshot as CanonicalSnapshot),
    ) as CanonicalSnapshot | null;
    const pendingDocuments = readPendingDocuments();
    const currentPending = currentPendingDocument(pendingDocuments);
    const pendingReads = await Promise.all(pendingDocuments.map(readPendingSnapshot));
    const candidates = pendingDocuments.flatMap((document, index) => {
      const read = pendingReads[index];
      return read.snapshot ? [{ document, read, snapshot: read.snapshot }] : [];
    });
    const recoveries = recoveryCandidates(candidates, durableWinner, currentPending);
    if (durableWinner) {
      prunePendingDocuments(candidates, durableWinner, currentPending);
    } else {
      prunePendingDocumentsWithoutDurable(pendingDocuments, pendingReads, currentPending);
    }
    return recoveries.slice(0, MAX_RECOVERY_DRAFTS).map(({ snapshot }) => ({
      markdown: snapshot.markdown,
      updatedAt: snapshot.updatedAt,
    }));
  });
}

async function saveLocalDocumentInScope(markdown: string): Promise<StorageHealth> {
    const pending = readPendingDocument();
    const pendingRead = await readPendingSnapshot(pending);
    const trustedPending = pendingRead.snapshot ? pending : null;
    if (trustedPending && trustedPending.markdown !== markdown) {
      const health = await inspectLocalStorageNow(["A newer staged edit is waiting to be saved."]);
      return { ...health, saved: false };
    }

    const updatedAt = trustedPending?.version === 2 ? trustedPending.updatedAt : issueTimestamp();
    const snapshot = pendingRead.snapshot && pendingRead.snapshot.markdown === markdown
      ? pendingRead.snapshot
      : await makeSnapshot(markdown, updatedAt);
    rememberTimestamp(snapshot);
    const latestPending = readPendingDocument();
    if (!samePendingDocument(latestPending, pending)) {
      const health = await inspectLocalStorageNow(["A newer staged edit is waiting to be saved."]);
      return { ...health, saved: false };
    }

    let authoritativeWinner = snapshot;
    let candidateSaved = false;
    let authorityFailed = false;
    const extraErrors: string[] = [];

    if (hasIndexedDb()) {
      try {
        await repairCorruptIndexedDbAuthority(snapshot);
        const result = await commitIndexedDb(snapshot);
        if (result.rejectedBecauseDeleted) {
          const health = await inspectLocalStorageNow(["This session was deleted in another tab."]);
          return { ...health, saved: false };
        }
        const normalized = await normalizeSnapshot(result.rawSnapshot);
        if (result.accepted && normalized && sameSnapshot(normalized, snapshot)) {
          candidateSaved = true;
          authoritativeWinner = normalized;
        } else if (normalized) {
          authoritativeWinner = normalized;
          extraErrors.push("A newer local revision is already stored in another tab.");
        } else {
          authorityFailed = true;
          extraErrors.push("IndexedDB authority could not be verified.");
        }
      } catch {
        authorityFailed = true;
        extraErrors.push("IndexedDB authority is unavailable; the candidate was not written.");
      }
    } else if (hasWebLocks() || !isBrowserContext()) {
      // Web Locks serializes this fallback in browsers that provide it. The
      // Node branch is intentionally only for the test/single-context runtime.
      // Re-check durable/local tombstones before replica writes (no IDB CAS barrier).
      if (await refreshDeletedFromIndexedDb()) {
        const health = await inspectLocalStorageNow(["This session was deleted in another tab."]);
        return { ...health, saved: false };
      }
      candidateSaved = true;
    } else {
      authorityFailed = true;
      extraErrors.push("Cross-tab persistence requires IndexedDB or Web Locks; the candidate was not written.");
    }

    const writes = authorityFailed
      ? []
      : await Promise.allSettled(
        REPLICA_TARGETS.map((target) => writeReplicaIfCurrent(target, authoritativeWinner)),
      );
    const writeErrors = writes.flatMap((write, index) => write.status === "rejected"
      ? [`${REPLICA_TARGETS[index].label} could not be updated`]
      : []);

    if (!hasIndexedDb() && candidateSaved) {
      candidateSaved = writes.some((write) => write.status === "fulfilled" && write.value);
    }
    // A peer delete that lands during replica I/O must still force saved: false
    // even if the authority commit had accepted this candidate earlier.
    if (await refreshDeletedFromIndexedDb()) {
      const health = await inspectLocalStorageNow([
        ...extraErrors,
        ...writeErrors,
        "This session was deleted in another tab.",
      ]);
      return { ...health, saved: false };
    }
    // Save acceptance is not the same as final authority ownership: another
    // tab may commit a deterministic tie winner immediately afterward. Keep
    // the exact pending record until load/reconciliation proves it was consumed.
    const health = await inspectLocalStorageNow([...extraErrors, ...writeErrors]);
    return { ...health, saved: candidateSaved };
}

export function saveLocalDocument(markdown: string): Promise<StorageHealth> {
  return serializeVaultOperation(() => saveLocalDocumentInScope(markdown));
}

/** Save a document without changing this page's active scope. */
export function saveLocalDocumentForDocument(documentId: string, markdown: string): Promise<StorageHealth> {
  return serializeVaultOperation(() => saveLocalDocumentInScope(markdown), normalizedDocumentId(documentId));
}

/**
 * Replace a document only while its exact authenticated authority snapshot is
 * still the expected Markdown. The IndexedDB compare and commit share one
 * observed revision; Web Locks provide the equivalent fallback barrier.
 */
export function saveLocalDocumentForDocumentIfMatches(
  documentId: string,
  expectedMarkdown: string,
  markdown: string,
): Promise<LocalDocumentCompareSaveResult> {
  const normalized = normalizedDocumentId(documentId);
  return serializeVaultOperation(async () => {
    if (await refreshDeletedFromIndexedDb()) return { matched: false };
    const reads = await readSnapshots();
    const expected = selectCurrentSnapshot(
      reads.filter((read) => read.valid && read.snapshot).map((read) => read.snapshot as CanonicalSnapshot),
    ) as CanonicalSnapshot | null;
    if ((expected?.markdown ?? "") !== expectedMarkdown) return { matched: false };

    const candidate = await makeSnapshot(markdown, issueTimestamp());
    let authoritativeWinner = candidate;
    if (hasIndexedDb()) {
      const committed = await commitIndexedDbIfSnapshot(expected, candidate);
      if (!committed?.accepted) return { matched: false };
      const verified = await normalizeSnapshot(committed.rawSnapshot);
      if (!verified || !sameSnapshot(verified, candidate)) return { matched: false };
      authoritativeWinner = verified;
    } else if (!hasWebLocks() && isBrowserContext()) {
      throw new Error("Cross-tab persistence requires IndexedDB or Web Locks.");
    }

    const writes = await Promise.allSettled(
      REPLICA_TARGETS.map((target) => writeReplicaIfCurrent(target, authoritativeWinner)),
    );
    const writeErrors = writes.flatMap((write, index) => write.status === "rejected"
      ? [`${REPLICA_TARGETS[index].label} could not be updated`]
      : []);
    if (hasIndexedDb()) {
      const finalAuthority = await normalizeSnapshot(await readIndexedDb());
      if (!sameSnapshot(finalAuthority, authoritativeWinner)) return { matched: false };
    }
    const health = await inspectLocalStorageNow(writeErrors);
    const saved = hasIndexedDb()
      ? true
      : writes.some((write) => write.status === "fulfilled" && write.value);
    return { matched: true, health: { ...health, saved } };
  }, normalized);
}

export async function requestPersistentStorage() {
  try {
    const storage = typeof navigator === "undefined" ? undefined : navigator.storage;
    return (await storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

export function inspectLocalStorage(): Promise<StorageHealth> {
  return serializeVaultOperation(inspectLocalStorageNow);
}

/**
 * Permanently remove durable and staged storage for a non-default document.
 *
 * Under the per-document vault lock:
 * 1. Purge local staged/durable copies (best-effort first pass).
 * 2. Atomically write an IndexedDB deletion marker and drop authority/current.
 * 3. Purge OPFS (best-effort).
 * 4. Publish localStorage + memory tombstones only after the durable marker exists
 *    (or after local purge when IndexedDB is unavailable).
 *
 * If the durable marker cannot be written, no tombstone is left behind so the
 * session remains loadable and the user can retry. Peer saves that race without
 * Web Locks still lose to the IndexedDB deletion marker inside commitIndexedDb.
 *
 * Operates on the target id without mutating the caller's active document scope.
 */
export async function deleteLocalDocument(documentId: string) {
  const normalized = normalizedDocumentId(documentId);
  if (normalized === DEFAULT_DOCUMENT_ID) {
    throw new Error("The original session cannot be deleted.");
  }

  await serializeVaultOperation(async () => {
    const deletedAt = Date.now();
    let durableMarkerWritten = false;

    try {
      try {
        purgeLocalReplicas();
      } catch {
        throw new Error("Could not delete localStorage copies for this session.");
      }

      if (hasIndexedDb()) {
        await commitIndexedDbDeletion(normalized, deletedAt);
        durableMarkerWritten = true;
        // Memory + LS fast-path for stage() and other same-tab checks.
        writeLocalTombstone(normalized, deletedAt);
      }

      try {
        await purgeOpfsReplica();
      } catch {
        // OPFS residue is unreachable once the durable marker exists; keep deleting.
        if (!durableMarkerWritten) {
          throw new Error("Could not delete the browser file system copy for this session.");
        }
      }

      // Environments without IndexedDB (or tests) rely on the localStorage marker.
      if (!durableMarkerWritten) {
        try {
          purgeLocalReplicas();
        } catch {
          throw new Error("Could not delete localStorage copies for this session.");
        }
        if (!writeLocalTombstone(normalized, deletedAt)) {
          clearLocalTombstone(normalized);
          throw new Error("Could not record a local deletion marker for this session.");
        }
        durableMarkerWritten = true;
      } else {
        // Second pass clears anything a concurrent unlocked writer may have staged.
        try {
          purgeLocalReplicas();
        } catch {
          // Content remains blocked by the durable tombstone.
        }
        writeLocalTombstone(normalized, deletedAt);
      }
    } catch (error) {
      if (!durableMarkerWritten) clearLocalTombstone(normalized);
      throw error;
    }
  }, normalized);
}

/**
 * Remove a non-default document only if its exact authenticated content is
 * unchanged. Callers coordinate metadata by holding its compare lock around
 * this operation; a peer content save makes this return false without purging.
 */
export async function deleteLocalDocumentIfMatches(documentId: string, expectedMarkdown: string) {
  const normalized = normalizedDocumentId(documentId);
  if (normalized === DEFAULT_DOCUMENT_ID) throw new Error("The original session cannot be deleted.");

  return serializeVaultOperation(async () => {
    if (await refreshDeletedFromIndexedDb()) return false;
    const reads = await readSnapshots();
    const expected = selectCurrentSnapshot(
      reads.filter((read) => read.valid && read.snapshot).map((read) => read.snapshot as CanonicalSnapshot),
    ) as CanonicalSnapshot | null;
    if (!expected || expected.markdown !== expectedMarkdown) return false;
    const deletedAt = Date.now();

    if (hasIndexedDb()) {
      if (!await commitIndexedDbDeletionIfSnapshot(normalized, expected, deletedAt)) return false;
      writeLocalTombstone(normalized, deletedAt);
    } else {
      if (!hasWebLocks() && isBrowserContext()) {
        throw new Error("Cross-tab persistence requires IndexedDB or Web Locks.");
      }
      if (!writeLocalTombstone(normalized, deletedAt)) {
        clearLocalTombstone(normalized);
        throw new Error("Could not record a local deletion marker for this session.");
      }
    }

    try {
      purgeLocalReplicas();
      await purgeOpfsReplica();
    } catch (error) {
      // Once the authority tombstone is committed, residue is unreachable and
      // must not be mistaken for permission to remove changed metadata.
      throw new Error(`Could not purge matched local replicas: ${String(error)}`);
    }
    return true;
  }, normalized);
}

/** Reset process-local sequencing state between isolated storage contract tests. */
export function resetLocalVaultStateForTests() {
  vaultQueue = Promise.resolve();
  lastIssuedTimestamp = 0;
  pendingOwner = null;
  webLocksUnavailable = false;
  activeDocumentId = DEFAULT_DOCUMENT_ID;
  operationDocumentId = null;
  deletedDocuments.clear();
}
