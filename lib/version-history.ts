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
};

type HistoryReadResult =
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "valid"; history: StoredVersionHistory };

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

function serializeHistory(documentId: string, entries: VersionHistoryEntry[]) {
  return JSON.stringify({
    schemaVersion: VERSION_HISTORY_SCHEMA_VERSION,
    documentId,
    entries,
  } satisfies StoredVersionHistory);
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
  const read = readHistory(local, documentId);
  if (read.status === "invalid") return null;

  const entries = read.status === "valid"
    ? read.history.entries.map(cloneEntry)
    : [];
  if (entries.some((entry) => entry.markdown === markdown)) return null;

  const entry: VersionHistoryEntry = {
    id: versionId(entries, markdown, timestamp),
    createdAt: timestamp,
    markdown,
  };
  entries.push(entry);
  entries.sort(compareEntriesOldestFirst);

  while (entries.length > VERSION_HISTORY_MAX_ENTRIES) entries.shift();

  let serialized = serializeHistory(documentId, entries);
  while (utf8ByteLengthOver(serialized, VERSION_HISTORY_MAX_BYTES) && entries.length > 0) {
    entries.shift();
    serialized = serializeHistory(documentId, entries);
  }

  // An out-of-order or exceptionally escape-heavy entry can be pruned before
  // write. Preserve the existing valid history instead of changing it silently.
  if (!entries.some((candidate) => candidate.id === entry.id)) return null;

  try {
    local.setItem(historyKey(documentId), serialized);
    return cloneEntry(entry);
  } catch {
    return null;
  }
}

/** Return valid snapshots newest first. Invalid or unavailable storage is empty. */
export function listVersions(documentId: string): VersionHistoryEntry[] {
  if (!isValidDocumentId(documentId)) return [];
  const local = storage();
  if (!local) return [];
  const read = readHistory(local, documentId);
  if (read.status !== "valid") return [];
  return read.history.entries.toReversed().map(cloneEntry);
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
  const read = readHistory(local, documentId);
  if (read.status !== "valid") return false;

  const entries = read.history.entries.filter((entry) => entry.id !== id);
  if (entries.length === read.history.entries.length) return false;

  try {
    if (entries.length === 0) local.removeItem(historyKey(documentId));
    else local.setItem(historyKey(documentId), serializeHistory(documentId, entries));
    return true;
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
    local.removeItem(historyKey(documentId));
    return true;
  } catch {
    return false;
  }
}
