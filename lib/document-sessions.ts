import { DEFAULT_DOCUMENT_ID } from "./local-vault.ts";

const SESSION_KEY_PREFIX = "lab.session.v1.";
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

function normalizeId(value: string | null | undefined) {
  return value && /^[a-zA-Z0-9_-]{1,96}$/.test(value) ? value : DEFAULT_DOCUMENT_ID;
}

function normalizeName(value: string) {
  return value.trim().replace(/\s+/g, " ").slice(0, 80) || "Untitled";
}

function sessionKey(id: string) {
  return `${SESSION_KEY_PREFIX}${id}`;
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

function readSession(id: string) {
  const local = storage();
  if (!local) return null;
  try {
    return parseSession(local.getItem(sessionKey(id)));
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
    // Per-session localStorage writes remain atomic when Web Locks are unavailable.
  }
  return operation();
}

export function activeDocumentIdFromLocation(location: Pick<Location, "hash"> | undefined = globalThis.location) {
  const hash = location?.hash ?? "";
  if (!hash.startsWith(SESSION_HASH_PREFIX)) return DEFAULT_DOCUMENT_ID;
  try {
    return normalizeId(decodeURIComponent(hash.slice(SESSION_HASH_PREFIX.length)));
  } catch {
    return DEFAULT_DOCUMENT_ID;
  }
}

export function documentSessionHash(id: string) {
  const normalized = normalizeId(id);
  return normalized === DEFAULT_DOCUMENT_ID ? "" : `${SESSION_HASH_PREFIX}${encodeURIComponent(normalized)}`;
}

export async function ensureDocumentSession(id: string) {
  const normalized = normalizeId(id);
  return withSessionLock(normalized, () => {
    const existing = readSession(normalized);
    if (existing) return existing;
    const now = Date.now();
    return writeSession({
      id: normalized,
      name: normalized === DEFAULT_DOCUMENT_ID ? "Untitled" : "Untitled",
      createdAt: now,
      updatedAt: now,
    });
  });
}

export async function createDocumentSession(name = "Untitled") {
  const id = globalThis.crypto?.randomUUID?.().replaceAll("-", "")
    ?? `${Date.now()}${Math.random().toString(36).slice(2)}`;
  const now = Date.now();
  return withSessionLock(id, () => writeSession({
    id,
    name: normalizeName(name),
    createdAt: now,
    updatedAt: now,
  }));
}

export async function renameDocumentSession(id: string, name: string) {
  const normalized = normalizeId(id);
  return withSessionLock(normalized, () => {
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

/** Advance activity metadata after a document has been durably saved. */
export async function touchDocumentSession(id: string) {
  const normalized = normalizeId(id);
  return withSessionLock(normalized, () => {
    const existing = readSession(normalized);
    const now = Math.max(Date.now(), (existing?.updatedAt ?? 0) + 1);
    return writeSession({
      id: normalized,
      name: existing?.name ?? "Untitled",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  });
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
        if (session) sessions.push(session);
      }
    } catch {
      // Return any metadata that was readable before enumeration failed.
    }
  }
  if (!sessions.some((session) => session.id === DEFAULT_DOCUMENT_ID)) {
    sessions.push({ id: DEFAULT_DOCUMENT_ID, name: "Untitled", createdAt: 0, updatedAt: 0 });
  }
  return sessions.sort((left, right) => (
    right.updatedAt - left.updatedAt || left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
  ));
}
