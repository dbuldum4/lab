import {
  DEFAULT_DOCUMENT_ID,
  deleteLocalDocument,
  ensureDocumentNotDeleted,
  isLocalDocumentDeleted,
} from "./local-vault.ts";
import { clearDocumentVersions } from "./version-history.ts";

const SESSION_KEY_PREFIX = "lab.session.v1.";
const SESSION_ACTIVITY_KEY_PREFIX = "lab.session.activity.v1.";
const SESSION_LOCK_PREFIX = "lab-session-metadata";
const SESSION_HASH_PREFIX = "#session=";

export type DocumentSession = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};

function storage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function isValidDocumentId(value: string) {
  return /^[a-zA-Z0-9_-]{1,96}$/.test(value);
}

function normalizeId(value: string | null | undefined) {
  return value && isValidDocumentId(value) ? value : DEFAULT_DOCUMENT_ID;
}

export type ActiveDocumentLocation = {
  id: string;
  /** True when the hash claimed a session id that failed validation. */
  hadInvalidSessionHash: boolean;
};

/**
 * Parse the location hash into a document id.
 * Invalid `#session=…` values map to the default document and set
 * `hadInvalidSessionHash` so callers can rewrite the URL to match storage.
 */
export function parseActiveDocumentLocation(
  location: Pick<Location, "hash"> | undefined = globalThis.location,
): ActiveDocumentLocation {
  const hash = location?.hash ?? "";
  if (!hash.startsWith(SESSION_HASH_PREFIX)) {
    return { id: DEFAULT_DOCUMENT_ID, hadInvalidSessionHash: false };
  }
  let raw: string;
  try {
    raw = decodeURIComponent(hash.slice(SESSION_HASH_PREFIX.length));
  } catch {
    return { id: DEFAULT_DOCUMENT_ID, hadInvalidSessionHash: true };
  }
  if (!raw || !isValidDocumentId(raw)) {
    return { id: DEFAULT_DOCUMENT_ID, hadInvalidSessionHash: true };
  }
  return { id: raw, hadInvalidSessionHash: false };
}

function normalizeName(value: string) {
  return value.trim().replace(/\s+/g, " ").slice(0, 80) || "Untitled";
}

function sessionKey(id: string) {
  return `${SESSION_KEY_PREFIX}${id}`;
}

function activityKey(id: string) {
  return `${SESSION_ACTIVITY_KEY_PREFIX}${id}`;
}

function parseSession(value: string | null): DocumentSession | null {
  if (!value) return null;
  try {
    const session = JSON.parse(value) as Partial<DocumentSession>;
    if (
      typeof session.id !== "string"
      || normalizeId(session.id) !== session.id
      || typeof session.name !== "string"
      || !Number.isFinite(session.createdAt)
      || !Number.isFinite(session.updatedAt)
    ) return null;
    return {
      id: session.id,
      name: normalizeName(session.name),
      createdAt: session.createdAt as number,
      updatedAt: session.updatedAt as number,
    };
  } catch {
    return null;
  }
}

function latestActivity(storage: Storage, id: string) {
  try {
    const raw = storage.getItem(activityKey(id));
    if (raw === null) return null;
    const updatedAt = Number(raw);
    return Number.isFinite(updatedAt) ? updatedAt : null;
  } catch {
    return null;
  }
}

function mergeActivity(storage: Storage, session: DocumentSession) {
  const updatedAt = latestActivity(storage, session.id);
  return updatedAt !== null && updatedAt > session.updatedAt
    ? { ...session, updatedAt }
    : session;
}

function readSession(id: string) {
  const local = storage();
  if (!local) return null;
  try {
    const session = parseSession(local.getItem(sessionKey(id)));
    return session ? mergeActivity(local, session) : null;
  } catch {
    return null;
  }
}

function writeSession(session: DocumentSession) {
  const local = storage();
  if (!local) throw new Error("Session metadata storage is unavailable.");
  local.setItem(sessionKey(session.id), JSON.stringify(session));
  return session;
}

async function withSessionLock<T>(id: string, operation: () => T | Promise<T>) {
  let operationStarted = false;
  try {
    const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
    if (typeof locks?.request === "function") {
      return await locks.request(`${SESSION_LOCK_PREFIX}:${id}`, { mode: "exclusive" }, () => {
        operationStarted = true;
        return operation();
      });
    }
  } catch (error) {
    if (operationStarted) throw error;
    // Activity timestamps use a separate key, so an unlocked touch cannot
    // overwrite a concurrent rename's session name. Surface broken lock
    // implementations in development so silent fallback is observable.
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        `[document-sessions] Web Lock request failed for ${id}; continuing without exclusive lock.`,
        error,
      );
    }
  }
  return operation();
}

export function activeDocumentIdFromLocation(location: Pick<Location, "hash"> | undefined = globalThis.location) {
  return parseActiveDocumentLocation(location).id;
}

/**
 * Clear a bad `#session=…` hash so the address bar matches default storage.
 * Returns true when an invalid hash was present and rewritten.
 * The app only uses #session= for routing; other hash fragments are not used
 * and are intentionally not preserved when an invalid session hash is
 * rewritten to avoid leaving a stale, misleading `#session=bad` in history.
 */
export function clearInvalidDocumentSessionHash(
  location: Pick<Location, "hash" | "pathname" | "search"> | undefined = globalThis.location,
  history: Pick<History, "replaceState"> | undefined = globalThis.history,
): boolean {
  if (!location || !history?.replaceState) return false;
  if (!parseActiveDocumentLocation(location).hadInvalidSessionHash) return false;
  const target = `${location.pathname}${location.search}`;
  history.replaceState({ labDocumentId: DEFAULT_DOCUMENT_ID }, "", target);
  return true;
}

export function documentSessionHash(id: string) {
  const normalized = normalizeId(id);
  return normalized === DEFAULT_DOCUMENT_ID ? "" : `${SESSION_HASH_PREFIX}${encodeURIComponent(normalized)}`;
}

/** Read session metadata without creating a ghost entry for unknown hashes. */
export async function getDocumentSession(id: string): Promise<DocumentSession | null> {
  const normalized = normalizeId(id);
  if (normalized !== DEFAULT_DOCUMENT_ID && isLocalDocumentDeleted(normalized)) return null;
  return withSessionLock(normalized, () => {
    if (normalized !== DEFAULT_DOCUMENT_ID && isLocalDocumentDeleted(normalized)) return null;
    return readSession(normalized);
  });
}

/**
 * Return existing metadata, or create it. Prefer getDocumentSession for hydration
 * of arbitrary URL hashes so typos do not pollute /sessions.
 */
export async function ensureDocumentSession(id: string) {
  const normalized = normalizeId(id);
  await ensureDocumentNotDeleted(normalized);
  return withSessionLock(normalized, () => {
    if (normalized !== DEFAULT_DOCUMENT_ID && isLocalDocumentDeleted(normalized)) {
      throw new Error("This session was deleted.");
    }
    const existing = readSession(normalized);
    if (existing) return existing;
    const now = Date.now();
    return writeSession({
      id: normalized,
      name: "Untitled",
      createdAt: now,
      updatedAt: now,
    });
  });
}

export async function createDocumentSession(name = "Untitled") {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const fallbackId = (() => {
      const time = Date.now().toString(36);
      const bytes = (() => {
        try {
          const buf = new Uint8Array(12);
          globalThis.crypto?.getRandomValues?.(buf);
          // Hex is [0-9a-f] so already valid for isValidDocumentId.
          return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
        } catch {
          return `${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;
        }
      })();
      return `${time}${bytes}`;
    })();
    const raw = globalThis.crypto?.randomUUID?.().replaceAll("-", "") ?? fallbackId;
    // Sanitize entropy (randomUUID without dashes is hex; fallback is [0-9a-z]) and cap
    // length so isValidDocumentId stays cheap and the loop can retry on any invalid shape.
    const id = raw.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32) || fallbackId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
    if (!isValidDocumentId(id) || isLocalDocumentDeleted(id)) continue;
    const now = Date.now();
    // null means the id became unusable under the lock (tombstone or live
    // collision); retry with a fresh id so create never clobbers metadata.
    const created = await withSessionLock(id, () => {
      if (isLocalDocumentDeleted(id)) return null;
      if (readSession(id)) return null;
      return writeSession({
        id,
        name: normalizeName(name),
        createdAt: now,
        updatedAt: now,
      });
    });
    if (created) return created;
  }
  throw new Error("A new session id could not be allocated.");
}

export async function renameDocumentSession(id: string, name: string) {
  const normalized = normalizeId(id);
  await ensureDocumentNotDeleted(normalized);
  return withSessionLock(normalized, () => {
    if (normalized !== DEFAULT_DOCUMENT_ID && isLocalDocumentDeleted(normalized)) {
      throw new Error("This session was deleted.");
    }
    const existing = readSession(normalized);
    const now = Date.now();
    return writeSession({
      id: normalized,
      name: normalizeName(name),
      createdAt: existing?.createdAt ?? now,
      updatedAt: Math.max(now, (existing?.updatedAt ?? 0) + 1),
    });
  });
}

/**
 * Advance activity metadata without rewriting the session name record.
 * Creates a session entry on first durable save so unknown hashes only appear
 * in /sessions after the user has written real content.
 */
export async function touchDocumentSession(id: string) {
  const normalized = normalizeId(id);
  await ensureDocumentNotDeleted(normalized);
  return withSessionLock(normalized, () => {
    if (normalized !== DEFAULT_DOCUMENT_ID && isLocalDocumentDeleted(normalized)) {
      throw new Error("This session was deleted.");
    }
    const existing = readSession(normalized);
    const now = Math.max(Date.now(), (existing?.updatedAt ?? 0) + 1);
    const local = storage();
    if (!local) throw new Error("Session metadata storage is unavailable.");
    try {
      local.setItem(activityKey(normalized), String(now));
    } catch {
      throw new Error("Session activity storage is unavailable.");
    }
    if (!existing) {
      return writeSession({
        id: normalized,
        name: "Untitled",
        createdAt: now,
        updatedAt: now,
      });
    }
    return {
      id: normalized,
      name: existing.name,
      createdAt: existing.createdAt,
      updatedAt: now,
    };
  });
}

/** Remove session metadata. The original document cannot be deleted. */
export async function deleteDocumentSession(id: string) {
  const normalized = normalizeId(id);
  if (normalized === DEFAULT_DOCUMENT_ID) {
    throw new Error("The original session cannot be deleted.");
  }
  return withSessionLock(normalized, () => {
    const local = storage();
    if (!local) throw new Error("Session metadata storage is unavailable.");
    try {
      local.removeItem(sessionKey(normalized));
      local.removeItem(activityKey(normalized));
    } catch {
      throw new Error("Session metadata could not be deleted.");
    }
    return { id: normalized };
  });
}

/**
 * Permanently remove a non-default session's content and metadata.
 * Purges durable replicas first, then list metadata, so a partial failure
 * cannot leave private note text attached to a named session entry.
 */
export async function purgeDocumentSession(id: string) {
  const normalized = normalizeId(id);
  if (normalized === DEFAULT_DOCUMENT_ID) {
    throw new Error("The original session cannot be deleted.");
  }
  if (!clearDocumentVersions(normalized)) {
    throw new Error("Local version history could not be deleted.");
  }
  await deleteLocalDocument(normalized);
  return deleteDocumentSession(normalized);
}

export function listDocumentSessions(): DocumentSession[] {
  const local = storage();
  const sessions: DocumentSession[] = [];
  if (local) {
    try {
      for (let index = 0; index < local.length; index += 1) {
        const key = local.key(index);
        if (!key?.startsWith(SESSION_KEY_PREFIX)) continue;
        const session = parseSession(local.getItem(key));
        if (!session) continue;
        if (session.id !== DEFAULT_DOCUMENT_ID && isLocalDocumentDeleted(session.id)) continue;
        sessions.push(mergeActivity(local, session));
      }
    } catch {
      // Return any metadata that was readable before enumeration failed.
    }
  }
  if (!sessions.some((session) => session.id === DEFAULT_DOCUMENT_ID)) {
    sessions.push({ id: DEFAULT_DOCUMENT_ID, name: "Untitled", createdAt: 0, updatedAt: 0 });
  }
  return sessions.sort((left, right) => (
    right.updatedAt - left.updatedAt
    || left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
    || left.id.localeCompare(right.id)
  ));
}
