const VERSION_HISTORY_KEY_PREFIX = "lab.version-history.v1.";

export const VERSION_HISTORY_SCHEMA_VERSION = 1 as const;
export const VERSION_HISTORY_MAX_ENTRIES = 50;
export const VERSION_HISTORY_MAX_BYTES = 1024 * 1024;
export const VERSION_HISTORY_MAX_MARKDOWN_BYTES = 512 * 1024;

export type VersionHistoryEntry = {
  id: string;
  createdAt: number;
  markdown: string;
};

type StoredVersionHistory = {
  schemaVersion: typeof VERSION_HISTORY_SCHEMA_VERSION;
  documentId: string;
  entries: VersionHistoryEntry[];
  storageMode?: "manifest";
};

type HistoryReadResult =
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "valid"; history: StoredVersionHistory };

const VERSION_HISTORY_ENTRY_KEY_PREFIX = `${VERSION_HISTORY_KEY_PREFIX}entry.`;
const VERSION_HISTORY_TOMBSTONE_KEY_PREFIX = `${VERSION_HISTORY_KEY_PREFIX}tombstone.`;
const VERSION_HISTORY_CLEAR_KEY_PREFIX = `${VERSION_HISTORY_KEY_PREFIX}clear.`;

type StoredHistoryEntry = {
  documentId: string;
  recordedAt: number;
  entry: VersionHistoryEntry;
};

type HistoryState = {
  entries: VersionHistoryEntry[];
  records: Map<string, StoredHistoryEntry>;
  tombstones: Map<string, number>;
  clearAt: number;
};

function storage(): Storage | null {
  try {
    const local = globalThis.localStorage;
    return local && typeof local.getItem === "function" && typeof local.setItem === "function"
      ? local
      : null;
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidDocumentId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,96}$/.test(value);
}

function isValidVersionId(value: unknown): value is string {
  return typeof value === "string" && /^v[a-z0-9_-]{1,127}$/.test(value);
}

function isValidTimestamp(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0;
}

/**
 * Count UTF-8 bytes without allocating an encoded copy. The early return keeps
 * validation cheap for unexpectedly large or hostile localStorage values.
 */
function utf8ByteLengthOver(value: string, limit: number): boolean {
  if (value.length > limit) return true;

  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
    if (bytes > limit) return true;
  }
  return false;
}

function compareEntriesOldestFirst(left: VersionHistoryEntry, right: VersionHistoryEntry) {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

function cloneEntry(entry: VersionHistoryEntry): VersionHistoryEntry {
  return { id: entry.id, createdAt: entry.createdAt, markdown: entry.markdown };
}

function historyKey(documentId: string) {
  return `${VERSION_HISTORY_KEY_PREFIX}${documentId}`;
}

function parseVersionEntry(value: unknown): VersionHistoryEntry | null {
  if (
    !isPlainObject(value)
    || !isValidVersionId(value.id)
    || !isValidTimestamp(value.createdAt)
    || typeof value.markdown !== "string"
    || utf8ByteLengthOver(value.markdown, VERSION_HISTORY_MAX_MARKDOWN_BYTES)
  ) return null;
  return {
    id: value.id,
    createdAt: value.createdAt,
    markdown: value.markdown,
  };
}

function historyEntryPrefix(documentId: string) {
  return `${VERSION_HISTORY_ENTRY_KEY_PREFIX}${documentId}.`;
}

function historyEntryKey(documentId: string, id: string) {
  return `${historyEntryPrefix(documentId)}${id}`;
}

function historyTombstonePrefix(documentId: string) {
  return `${VERSION_HISTORY_TOMBSTONE_KEY_PREFIX}${documentId}.`;
}

function historyTombstoneKey(documentId: string, id: string) {
  return `${historyTombstonePrefix(documentId)}${id}`;
}

function historyClearKey(documentId: string) {
  return `${VERSION_HISTORY_CLEAR_KEY_PREFIX}${documentId}`;
}

function parseStoredHistoryEntry(
  raw: string | null,
  documentId: string,
): StoredHistoryEntry | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isPlainObject(value) || value.documentId !== documentId || !isValidTimestamp(value.recordedAt)) {
      return null;
    }
    const entry = parseVersionEntry(value.entry);
    return entry ? { documentId, recordedAt: value.recordedAt, entry } : null;
  } catch {
    return null;
  }
}

function readStoredHistoryEntries(local: Storage, documentId: string) {
  const records = new Map<string, StoredHistoryEntry>();
  const prefix = historyEntryPrefix(documentId);
  for (let index = 0; index < local.length; index += 1) {
    const key = local.key(index);
    if (!key?.startsWith(prefix)) continue;
    const id = key.slice(prefix.length);
    if (!isValidVersionId(id)) continue;
    const record = parseStoredHistoryEntry(local.getItem(key), documentId);
    if (record) records.set(id, record);
  }
  return records;
}

function readHistoryTombstones(local: Storage, documentId: string) {
  const tombstones = new Map<string, number>();
  const prefix = historyTombstonePrefix(documentId);
  for (let index = 0; index < local.length; index += 1) {
    const key = local.key(index);
    if (!key?.startsWith(prefix)) continue;
    const id = key.slice(prefix.length);
    if (!isValidVersionId(id)) continue;
    const raw = local.getItem(key);
    if (raw === null) continue;
    try {
      const value: unknown = JSON.parse(raw);
      if (isValidTimestamp(value)) tombstones.set(id, value);
    } catch {
      // Ignore malformed tombstones. The aggregate and entry records remain
      // readable, as they did before append-only storage was introduced.
    }
  }
  return tombstones;
}

function readHistoryClearAt(local: Storage, documentId: string) {
  const raw = local.getItem(historyClearKey(documentId));
  if (raw === null) return 0;
  try {
    const value: unknown = JSON.parse(raw);
    return isValidTimestamp(value) ? value : 0;
  } catch {
    return 0;
  }
}

function parseHistory(raw: string, documentId: string): StoredVersionHistory | null {
  if (utf8ByteLengthOver(raw, VERSION_HISTORY_MAX_BYTES)) return null;

  try {
    const value: unknown = JSON.parse(raw);
    if (
      !isPlainObject(value)
      || value.schemaVersion !== VERSION_HISTORY_SCHEMA_VERSION
      || value.documentId !== documentId
      || !Array.isArray(value.entries)
      || value.entries.length > VERSION_HISTORY_MAX_ENTRIES
      || (value.storageMode !== undefined && value.storageMode !== "manifest")
    ) return null;

    const ids = new Set<string>();
    const markdownValues = new Set<string>();
    const entries: VersionHistoryEntry[] = [];
    for (const candidate of value.entries) {
      if (
        !isPlainObject(candidate)
        || !isValidVersionId(candidate.id)
        || !isValidTimestamp(candidate.createdAt)
        || typeof candidate.markdown !== "string"
        || utf8ByteLengthOver(candidate.markdown, VERSION_HISTORY_MAX_MARKDOWN_BYTES)
        || ids.has(candidate.id)
        || markdownValues.has(candidate.markdown)
      ) return null;

      ids.add(candidate.id);
      markdownValues.add(candidate.markdown);
      entries.push({
        id: candidate.id,
        createdAt: candidate.createdAt,
        markdown: candidate.markdown,
      });
    }

    entries.sort(compareEntriesOldestFirst);
    return {
      schemaVersion: VERSION_HISTORY_SCHEMA_VERSION,
      documentId,
      entries,
    };
  } catch {
    return null;
  }
}

function readHistory(local: Storage, documentId: string): HistoryReadResult {
  try {
    const raw = local.getItem(historyKey(documentId));
    if (raw === null) return { status: "missing" };
    const history = parseHistory(raw, documentId);
    return history ? { status: "valid", history } : { status: "invalid" };
  } catch {
    return { status: "invalid" };
  }
}

function serializeManifest(documentId: string) {
  return JSON.stringify({
    schemaVersion: VERSION_HISTORY_SCHEMA_VERSION,
    documentId,
    storageMode: "manifest",
    entries: [],
  } satisfies StoredVersionHistory);
}

function utf8ByteLength(value: string) {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

function uniqueEntries(entries: VersionHistoryEntry[]) {
  const byId = new Map<string, VersionHistoryEntry>();
  for (const entry of entries) byId.set(entry.id, entry);

  // Concurrent tabs can append the same Markdown under different ids. Keep a
  // single deterministic copy so the public history keeps its old invariant.
  const byMarkdown = new Map<string, VersionHistoryEntry>();
  for (const entry of [...byId.values()].sort(compareEntriesOldestFirst)) {
    byMarkdown.set(entry.markdown, entry);
  }
  return [...byMarkdown.values()].sort(compareEntriesOldestFirst);
}

function historyEntryValue(record: StoredHistoryEntry) {
  return JSON.stringify(record);
}

function historyStorageBytes(
  documentId: string,
  entries: VersionHistoryEntry[],
  tombstones: Map<string, number>,
  clearAt: number,
) {
  let bytes = utf8ByteLength(historyKey(documentId)) + utf8ByteLength(serializeManifest(documentId));
  for (const entry of entries) {
    // Use the largest valid timestamp for a conservative physical-size check.
    const record: StoredHistoryEntry = { documentId, recordedAt: Number.MAX_SAFE_INTEGER, entry };
    bytes += utf8ByteLength(historyEntryKey(documentId, entry.id)) + utf8ByteLength(historyEntryValue(record));
  }
  for (const [id, removedAt] of tombstones) {
    bytes += utf8ByteLength(historyTombstoneKey(documentId, id)) + utf8ByteLength(JSON.stringify(removedAt));
  }
  if (clearAt > 0) {
    bytes += utf8ByteLength(historyClearKey(documentId)) + utf8ByteLength(JSON.stringify(clearAt));
  }
  return bytes;
}

function boundedHistory(
  documentId: string,
  source: VersionHistoryEntry[],
  tombstones: Map<string, number> = new Map(),
  clearAt = 0,
) {
  const entries = uniqueEntries(source);
  while (
    (entries.length > VERSION_HISTORY_MAX_ENTRIES
      || historyStorageBytes(documentId, entries, tombstones, clearAt) > VERSION_HISTORY_MAX_BYTES)
    && entries.length > 0
  ) {
    entries.shift();
  }
  return {
    entries,
    serialized: serializeManifest(documentId),
  };
}

function readHistoryState(local: Storage, documentId: string): HistoryState | null {
  const read = readHistory(local, documentId);
  if (read.status === "invalid") return null;
  try {
    const records = readStoredHistoryEntries(local, documentId);
    const tombstones = readHistoryTombstones(local, documentId);
    const clearAt = readHistoryClearAt(local, documentId);
    const candidates = new Map<string, StoredHistoryEntry>();
    if (read.status === "valid") {
      for (const entry of read.history.entries) {
        candidates.set(entry.id, { documentId, recordedAt: 0, entry: cloneEntry(entry) });
      }
    }
    for (const [id, record] of records) {
      const previous = candidates.get(id);
      if (!previous || record.recordedAt >= previous.recordedAt) candidates.set(id, record);
    }
    const active = [...candidates.values()]
      .filter((record) => (
        (record.recordedAt > clearAt || (record.recordedAt === 0 && clearAt === 0))
        && record.recordedAt > (tombstones.get(record.entry.id) ?? -1)
      ))
      .map((record) => record.entry);
    const bounded = boundedHistory(documentId, active, tombstones, clearAt);
    return { entries: bounded.entries, records, tombstones, clearAt };
  } catch {
    return null;
  }
}

function readCurrentEntries(local: Storage, documentId: string) {
  return readHistoryState(local, documentId)?.entries ?? null;
}

function historyEntryKeys(local: Storage, documentId: string) {
  const prefix = historyEntryPrefix(documentId);
  const keys: string[] = [];
  for (let index = 0; index < local.length; index += 1) {
    const key = local.key(index);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  return keys;
}

function writeManifest(local: Storage, documentId: string) {
  local.setItem(historyKey(documentId), serializeManifest(documentId));
}

function persistEntries(
  local: Storage,
  documentId: string,
  state: HistoryState,
  entries: VersionHistoryEntry[],
  newRecord: StoredHistoryEntry | null = null,
) {
  const retainedIds = new Set(entries.map((entry) => entry.id));
  for (const entry of entries) {
    const record = entry.id === newRecord?.entry.id
      ? newRecord
      : state.records.get(entry.id) ?? { documentId, recordedAt: 0, entry };
    local.setItem(historyEntryKey(documentId, entry.id), historyEntryValue(record));
  }
  writeManifest(local, documentId);
  // Delete only records included in this operation's read snapshot. A peer can
  // append a new entry after that read and before this cleanup; scanning live
  // keys here would mistake that unseen record for an old pruned entry.
  for (const [id, observed] of state.records) {
    if (retainedIds.has(id)) continue;
    const key = historyEntryKey(documentId, id);
    const current = parseStoredHistoryEntry(local.getItem(key), documentId);
    if (current?.recordedAt === observed.recordedAt) local.removeItem(key);
  }
}

/** A small deterministic, non-cryptographic hash used only for storage-safe IDs. */
function hashMarkdown(markdown: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < markdown.length; index += 1) {
    hash ^= markdown.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

function versionId(
  entries: VersionHistoryEntry[],
  markdown: string,
  createdAt: number,
) {
  const base = `v${createdAt.toString(36)}-${hashMarkdown(markdown)}`;
  const existingIds = new Set(entries.map((entry) => entry.id));
  if (!existingIds.has(base)) return base;

  let suffix = 1;
  while (existingIds.has(`${base}-${suffix.toString(36)}`)) suffix += 1;
  return `${base}-${suffix.toString(36)}`;
}

/**
 * Record a durable local document state. Returns the new entry, or null when
 * storage is unavailable/corrupt, the state is a duplicate, or it exceeds a
 * safety limit. Identical Markdown is stored at most once per document.
 */
export function recordVersion(
  documentId: string,
  markdown: string,
  timestamp: number = Date.now(),
): VersionHistoryEntry | null {
  if (
    !isValidDocumentId(documentId)
    || typeof markdown !== "string"
    || !isValidTimestamp(timestamp)
    || utf8ByteLengthOver(markdown, VERSION_HISTORY_MAX_MARKDOWN_BYTES)
  ) return null;

  const local = storage();
  if (!local) return null;
  const state = readHistoryState(local, documentId);
  if (!state || state.entries.some((entry) => entry.markdown === markdown)) return null;

  const entry: VersionHistoryEntry = {
    id: versionId(state.entries, markdown, timestamp),
    createdAt: timestamp,
    markdown,
  };
  const recordedAt = Math.max(Date.now(), state.clearAt + 1);
  const newRecord: StoredHistoryEntry = { documentId, recordedAt, entry };
  const bounded = boundedHistory(documentId, [...state.entries, entry], state.tombstones, state.clearAt);
  if (!bounded.entries.some((candidate) => candidate.id === entry.id)) return null;

  try {
    // Each retained Markdown has one deterministic key. Aggregate writes are
    // only a small manifest, so a peer cannot erase another tab's payload.
    persistEntries(local, documentId, state, bounded.entries, newRecord);
    const final = readCurrentEntries(local, documentId);
    return final?.some((candidate) => candidate.id === entry.id)
      ? cloneEntry(entry)
      : null;
  } catch {
    return null;
  }
}

/** Return valid snapshots newest first. Invalid or unavailable storage is empty. */
export function listVersions(documentId: string): VersionHistoryEntry[] {
  if (!isValidDocumentId(documentId)) return [];
  const local = storage();
  if (!local) return [];
  const entries = readCurrentEntries(local, documentId);
  if (!entries) return [];
  return entries.toReversed().map(cloneEntry);
}

export function getVersion(documentId: string, id: string): VersionHistoryEntry | null {
  if (!isValidDocumentId(documentId) || !isValidVersionId(id)) return null;
  return listVersions(documentId).find((entry) => entry.id === id) ?? null;
}

/** Remove one version. Corrupt histories are left untouched. */
export function removeVersion(documentId: string, id: string): boolean {
  if (!isValidDocumentId(documentId) || !isValidVersionId(id)) return false;
  const local = storage();
  if (!local) return false;
  const state = readHistoryState(local, documentId);
  if (!state || !state.entries.some((entry) => entry.id === id)) return false;
  const removedAt = Math.max(Date.now(), state.clearAt + 1);

  try {
    // Remove the payload before publishing the tombstone. A later add writes
    // a newer recordedAt and remains visible after this operation.
    local.removeItem(historyEntryKey(documentId, id));
    local.setItem(historyTombstoneKey(documentId, id), JSON.stringify(removedAt));
    persistEntries(
      local,
      documentId,
      state,
      state.entries.filter((entry) => entry.id !== id),
    );
    const final = readCurrentEntries(local, documentId);
    return final !== null && !final.some((entry) => entry.id === id);
  } catch {
    return false;
  }
}

/**
 * Clear a document's history, including a corrupt value. This is intentionally
 * explicit so ordinary reads and records never overwrite data they cannot trust.
 */
export function clearVersions(documentId: string): boolean {
  if (!isValidDocumentId(documentId)) return false;
  const local = storage();
  if (!local) return false;
  try {
    const clearAt = Date.now();
    local.setItem(historyClearKey(documentId), JSON.stringify(clearAt));
    // Delete only records observed before the clear. A concurrent record uses
    // clearAt + 1 when clocks tie and remains durable.
    for (const key of historyEntryKeys(local, documentId)) {
      const record = parseStoredHistoryEntry(local.getItem(key), documentId);
      if (record && record.recordedAt <= clearAt) local.removeItem(key);
    }
    const tombstonePrefix = historyTombstonePrefix(documentId);
    const tombstoneKeys: string[] = [];
    for (let index = 0; index < local.length; index += 1) {
      const key = local.key(index);
      if (key?.startsWith(tombstonePrefix)) tombstoneKeys.push(key);
    }
    for (const key of tombstoneKeys) local.removeItem(key);
    local.removeItem(historyKey(documentId));
    return true;
  } catch {
    return false;
  }
}
