const SESSION_SEED_PREFIX = "lab.session.seed.v1.";

type SessionSeed = {
  version: 1;
  markdown: string;
};

function seedKey(documentId: string) {
  if (!/^[a-zA-Z0-9_-]{1,96}$/.test(documentId)) return null;
  return `${SESSION_SEED_PREFIX}${documentId}`;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export function stageSessionSeed(documentId: string, markdown: string) {
  const key = seedKey(documentId);
  const local = storage();
  if (!key || !local) return false;
  try {
    local.setItem(key, JSON.stringify({ version: 1, markdown } satisfies SessionSeed));
    return true;
  } catch {
    return false;
  }
}

export function readSessionSeed(documentId: string): string | null {
  const key = seedKey(documentId);
  const local = storage();
  if (!key || !local) return null;
  try {
    const raw = local.getItem(key);
    if (!raw) return null;
    const seed = JSON.parse(raw) as Partial<SessionSeed>;
    return seed.version === 1 && typeof seed.markdown === "string" ? seed.markdown : null;
  } catch {
    return null;
  }
}

export function clearSessionSeed(documentId: string) {
  const key = seedKey(documentId);
  const local = storage();
  if (!key || !local) return;
  try {
    local.removeItem(key);
  } catch {
    // The seed is only a reload bridge; a stale entry is harmless once a
    // durable document exists because hydration prefers the durable snapshot.
  }
}
