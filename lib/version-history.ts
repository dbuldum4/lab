const HISTORY_KEY_PREFIX = "lab.history.v1.";
const MAX_ENTRIES = 20;
const MAX_ENTRY_CHARACTERS = 500_000;
const MAX_TOTAL_CHARACTERS = 2_000_000;
const CHECKPOINT_INTERVAL_MS = 120_000;

export type DocumentVersion = {
  id: string;
  markdown: string;
  createdAt: number;
};

type RecordVersionOptions = {
  now?: number;
  force?: boolean;
};

function normalizedDocumentId(documentId: string) {
  return /^[a-zA-Z0-9_-]{1,96}$/.test(documentId) ? documentId : null;
}

function historyKey(documentId: string) {
  const id = normalizedDocumentId(documentId);
  return id ? `${HISTORY_KEY_PREFIX}${id}` : null;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function parseVersions(raw: string | null): DocumentVersion[] {
  if (!raw) return [];
  try {
    const values = JSON.parse(raw) as unknown;
    if (!Array.isArray(values)) return [];
    return values.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const candidate = value as Partial<DocumentVersion>;
      if (
        typeof candidate.id !== "string"
        || typeof candidate.markdown !== "string"
        || !Number.isFinite(candidate.createdAt)
      ) return [];
      return [{
        id: candidate.id,
        markdown: candidate.markdown,
        createdAt: candidate.createdAt as number,
      }];
    }).sort((left, right) => right.createdAt - left.createdAt);
  } catch {
    return [];
  }
}

export function listDocumentVersions(documentId: string): DocumentVersion[] {
  const key = historyKey(documentId);
  const local = storage();
  if (!key || !local) return [];
  try {
    return parseVersions(local.getItem(key));
  } catch {
    return [];
  }
}

export function recordDocumentVersion(
  documentId: string,
  markdown: string,
  options: RecordVersionOptions = {},
): boolean {
  const key = historyKey(documentId);
  const local = storage();
  if (!key || !local || markdown.length > MAX_ENTRY_CHARACTERS) return false;

  try {
    const existing = parseVersions(local.getItem(key));
    const newest = existing[0];
    if (newest?.markdown === markdown) return true;

    const now = Number.isFinite(options.now) ? options.now as number : Date.now();
    if (!options.force && newest && now - newest.createdAt < CHECKPOINT_INTERVAL_MS) {
      return true;
    }

    const id = globalThis.crypto?.randomUUID?.() ?? `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const next = [{ id, markdown, createdAt: now }, ...existing];
    const bounded: DocumentVersion[] = [];
    let totalCharacters = 0;
    for (const version of next) {
      if (bounded.length >= MAX_ENTRIES) break;
      if (version.markdown.length > MAX_ENTRY_CHARACTERS) continue;
      if (totalCharacters + version.markdown.length > MAX_TOTAL_CHARACTERS) continue;
      bounded.push(version);
      totalCharacters += version.markdown.length;
    }
    local.setItem(key, JSON.stringify(bounded));
    return true;
  } catch {
    return false;
  }
}

export function clearDocumentVersions(documentId: string) {
  const key = historyKey(documentId);
  if (!key) return false;
  const local = storage();
  // If localStorage itself is unavailable, this history backend could not have
  // persisted readable checkpoints in the current environment, so deletion is
  // already satisfied rather than blocking document deletion forever.
  if (!local) return true;
  try {
    local.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
