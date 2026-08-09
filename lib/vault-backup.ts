import {
  DEFAULT_DOCUMENT_ID,
  isLocalDocumentDeleted,
  loadLocalDocumentForDocument,
  saveLocalDocumentForDocument,
  type StorageHealth,
} from "./local-vault.ts";
import {
  getDocumentSession,
  listDocumentSessions,
  purgeDocumentSession,
  restoreDocumentSession,
  type DocumentSession,
} from "./document-sessions.ts";

export const VAULT_BACKUP_FORMAT = "lab-local-vault" as const;
export const VAULT_BACKUP_VERSION = 1 as const;
export const VAULT_BACKUP_FILENAME = "lab-vault-backup.json";
const ASSET_URI_PREFIX = "lab-asset://";
const ASSET_ID_PATTERN = /^asset-[a-z0-9_-]{1,64}$/;
const DOCUMENT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,96}$/;
const DATA_IMAGE_URL_PATTERN = /data:image\/[a-z0-9.+-]+(?:;[a-z0-9!#$&^_.+-]+)*,[^\s)]+/gi;
const MARKDOWN_DATA_IMAGE_PATTERN = /(!\[(?:\\.|[^\]\\\r\n])*\]\(\s*)(data:image\/[a-z0-9.+-]+(?:;[a-z0-9!#$&^_.+-]+)*,[^\s)]+)(?=\s*(?:"(?:[^"\\]|\\.)*")?\s*\))/gi;
const MARKDOWN_ASSET_IMAGE_PATTERN = /(!\[(?:\\.|[^\]\\\r\n])*\]\(\s*)(lab-asset:\/\/[a-z0-9_-]{1,64})(?=\s*(?:"(?:[^"\\]|\\.)*")?\s*\))/gi;
const MAX_SESSIONS = 2_000;
const MAX_ASSETS = 10_000;
const MAX_MARKDOWN_CHARS = 16 * 1024 * 1024;
const MAX_DATA_URL_CHARS = 16 * 1024 * 1024;

export type VaultBackupAsset = {
  id: string;
  /** The complete data URL is kept once in the asset table. */
  dataUrl: string;
  mimeType: string;
};

export type VaultBackupSession = DocumentSession & {
  /** Markdown uses lab-asset:// references for embedded local images. */
  markdown: string;
};

export type VaultBackup = {
  format: typeof VAULT_BACKUP_FORMAT;
  version: typeof VAULT_BACKUP_VERSION;
  exportedAt: number;
  counts: {
    sessions: number;
    assets: number;
  };
  sessions: VaultBackupSession[];
  assets: VaultBackupAsset[];
};

export type VaultBackupSourceSession = DocumentSession & {
  markdown: string;
};

export type VaultRestoreResult = {
  imported: number;
  skipped: number;
  renamed: number;
  assets: number;
  importedSessionIds: string[];
  activeDocumentUpdated: boolean;
};

function fail(message: string): never {
  throw new Error(`Invalid Lab vault backup: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseImageDataUrl(value: string) {
  if (value.length > MAX_DATA_URL_CHARS) return null;
  const comma = value.indexOf(",");
  if (!value.toLowerCase().startsWith("data:image/") || comma <= "data:".length) return null;
  const header = value.slice("data:".length, comma);
  const [mimeType, ...parameters] = header.split(";");
  if (!/^image\/[a-z0-9.+-]+$/i.test(mimeType ?? "")) return null;
  if (parameters.some((parameter) => !/^[a-z0-9!#$&^_.+-]+(?:=[a-z0-9!#$&^_.+-]*)?$/i.test(parameter))) {
    return null;
  }
  const payload = value.slice(comma + 1);
  if (!payload || /[\u0000-\u0020\u007f]/.test(payload)) return null;
  const base64 = parameters.some((parameter) => parameter.toLowerCase() === "base64");
  if (base64 && (!/^[a-z0-9+/]*={0,2}$/i.test(payload) || payload.length % 4 === 1)) return null;
  if (!base64 && /%(?![a-f0-9]{2})/i.test(payload)) return null;
  return { mimeType: mimeType.toLowerCase() };
}

function externalizeEmbeddedImages(markdown: string, assets: VaultBackupAsset[]) {
  const byDataUrl = new Map<string, VaultBackupAsset>();
  for (const asset of assets) byDataUrl.set(asset.dataUrl, asset);

  const externalized = markdown.replace(MARKDOWN_DATA_IMAGE_PATTERN, (_match, prefix: string, dataUrl: string) => {
    const parsed = parseImageDataUrl(dataUrl);
    if (!parsed) fail("an embedded image has an invalid local data URL");
    let asset = byDataUrl.get(dataUrl);
    if (!asset) {
      asset = {
        id: `asset-${assets.length + 1}`,
        dataUrl,
        mimeType: parsed.mimeType,
      };
      assets.push(asset);
      byDataUrl.set(dataUrl, asset);
    }
    return `${prefix}${ASSET_URI_PREFIX}${asset.id}`;
  });

  // A malformed image URL outside a normal Markdown image destination is not
  // silently dropped. It stays in the note and is still safe to export, but
  // it is not considered an embedded image asset.
  return externalized;
}

function restoreEmbeddedImages(markdown: string, assets: Map<string, VaultBackupAsset>) {
  return markdown.replace(MARKDOWN_ASSET_IMAGE_PATTERN, (_match, prefix: string, assetUri: string) => {
    const asset = assets.get(assetUri.slice(ASSET_URI_PREFIX.length));
    if (!asset) fail(`the Markdown references missing image asset ${assetUri}`);
    return `${prefix}${asset.dataUrl}`;
  });
}

function validateSession(value: unknown, index: number): VaultBackupSession {
  if (!isRecord(value)) fail(`session ${index + 1} is not an object`);
  const { id, name, createdAt, updatedAt, markdown } = value;
  if (typeof id !== "string" || !DOCUMENT_ID_PATTERN.test(id)) {
    fail(`session ${index + 1} has an invalid id`);
  }
  if (typeof name !== "string" || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
    fail(`session ${id} has an invalid name`);
  }
  if (!isFiniteTimestamp(createdAt) || !isFiniteTimestamp(updatedAt)) {
    fail(`session ${id} has invalid timestamps`);
  }
  if (typeof markdown !== "string" || markdown.length > MAX_MARKDOWN_CHARS) {
    fail(`session ${id} has invalid or oversized Markdown`);
  }
  return { id, name, createdAt, updatedAt, markdown };
}

function validateAsset(value: unknown, index: number): VaultBackupAsset {
  if (!isRecord(value)) fail(`image asset ${index + 1} is not an object`);
  const { id, dataUrl, mimeType } = value;
  if (typeof id !== "string" || !ASSET_ID_PATTERN.test(id)) {
    fail(`image asset ${index + 1} has an invalid id`);
  }
  if (typeof dataUrl !== "string") fail(`image asset ${id} has no data URL`);
  const parsed = parseImageDataUrl(dataUrl);
  if (!parsed || typeof mimeType !== "string" || mimeType.toLowerCase() !== parsed.mimeType) {
    fail(`image asset ${id} is not a valid local image`);
  }
  return { id, dataUrl, mimeType: parsed.mimeType };
}

/** Validate an untrusted parsed backup before any storage mutation occurs. */
export function parseVaultBackup(value: unknown): VaultBackup {
  const candidate = typeof value === "string"
    ? (() => {
      try {
        return JSON.parse(value) as unknown;
      } catch {
        fail("the file is not valid JSON");
      }
    })()
    : value;
  if (!isRecord(candidate)) fail("the root value is not an object");
  if (candidate.format !== VAULT_BACKUP_FORMAT) fail("the format is not supported");
  if (candidate.version !== VAULT_BACKUP_VERSION) fail("the backup version is not supported");
  if (!isFiniteTimestamp(candidate.exportedAt)) fail("the export timestamp is invalid");
  if (!isRecord(candidate.counts)) fail("the backup counts are missing");
  const rawSessions = candidate.sessions;
  const rawAssets = candidate.assets;
  if (!Array.isArray(rawSessions) || rawSessions.length > MAX_SESSIONS) fail("the sessions list is invalid");
  if (!Array.isArray(rawAssets) || rawAssets.length > MAX_ASSETS) fail("the image assets list is invalid");
  if (candidate.counts.sessions !== rawSessions.length || candidate.counts.assets !== rawAssets.length) {
    fail("the manifest counts do not match the payload");
  }

  const sessions = rawSessions.map(validateSession);
  const sessionIds = new Set<string>();
  for (const session of sessions) {
    if (sessionIds.has(session.id)) fail(`the session id ${session.id} appears more than once`);
    sessionIds.add(session.id);
  }

  const assets = rawAssets.map(validateAsset);
  const assetsById = new Map<string, VaultBackupAsset>();
  for (const asset of assets) {
    if (assetsById.has(asset.id)) fail(`the image asset id ${asset.id} appears more than once`);
    assetsById.set(asset.id, asset);
  }
  for (const session of sessions) {
    // This second pass validates every asset reference before restore starts.
    restoreEmbeddedImages(session.markdown, assetsById);
  }

  return {
    format: VAULT_BACKUP_FORMAT,
    version: VAULT_BACKUP_VERSION,
    exportedAt: candidate.exportedAt,
    counts: { sessions: sessions.length, assets: assets.length },
    sessions,
    assets,
  };
}

/** Build a portable payload from already verified local session records. */
export function buildVaultBackup(
  sourceSessions: readonly VaultBackupSourceSession[],
  exportedAt = Date.now(),
): VaultBackup {
  if (!isFiniteTimestamp(exportedAt)) throw new Error("A valid backup timestamp is required.");
  if (sourceSessions.length > MAX_SESSIONS) throw new Error("The vault has too many sessions to export.");
  const assets: VaultBackupAsset[] = [];
  const sessions = [...sourceSessions]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((session) => ({
      id: session.id,
      name: session.name,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      markdown: externalizeEmbeddedImages(session.markdown, assets),
    }));
  return {
    format: VAULT_BACKUP_FORMAT,
    version: VAULT_BACKUP_VERSION,
    exportedAt,
    counts: { sessions: sessions.length, assets: assets.length },
    sessions,
    assets,
  };
}

export function serializeVaultBackup(backup: VaultBackup) {
  return `${JSON.stringify(parseVaultBackup(backup), null, 2)}\n`;
}

/** Read every live session through the existing scoped/redundant vault path. */
export async function exportLocalVault(): Promise<VaultBackup> {
  const sourceSessions: VaultBackupSourceSession[] = [];
  for (const session of listDocumentSessions()) {
    if (session.id !== DEFAULT_DOCUMENT_ID && isLocalDocumentDeleted(session.id)) continue;
    const markdown = await loadLocalDocumentForDocument(session.id);
    // A deletion can race the metadata enumeration. Never put a deleted
    // document's content into a newly-created backup after the tombstone wins.
    if (session.id !== DEFAULT_DOCUMENT_ID && isLocalDocumentDeleted(session.id)) continue;
    sourceSessions.push({ ...session, markdown });
  }
  return buildVaultBackup(sourceSessions);
}

function sameSessionMetadata(left: DocumentSession | null, right: VaultBackupSession) {
  return Boolean(
    left
    && left.id === right.id
    && left.name === right.name
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt,
  );
}

/**
 * Merge a validated backup without replacing existing documents. Exact matches
 * are skipped; conflicts are imported under a fresh id. No existing id is
 * overwritten, and tombstoned ids are never revived.
 */
export async function restoreLocalVault(input: VaultBackup): Promise<VaultRestoreResult> {
  const backup = parseVaultBackup(input);
  const assets = new Map(backup.assets.map((asset) => [asset.id, asset]));
  const result: VaultRestoreResult = {
    imported: 0,
    skipped: 0,
    renamed: 0,
    assets: backup.assets.length,
    importedSessionIds: [],
    activeDocumentUpdated: false,
  };

  for (const session of backup.sessions) {
    const markdown = restoreEmbeddedImages(session.markdown, assets);
    const existingMetadata = await getDocumentSession(session.id);
    const existingMarkdown = await loadLocalDocumentForDocument(session.id);
    const tombstoned = session.id !== DEFAULT_DOCUMENT_ID && isLocalDocumentDeleted(session.id);
    const exactMatch = !tombstoned
      && sameSessionMetadata(existingMetadata, session)
      && existingMarkdown === markdown;
    if (exactMatch) {
      result.skipped += 1;
      continue;
    }

    // The active editor flushes before a restore. On a brand-new vault that
    // creates an Untitled default metadata row containing no user content.
    // Filling that empty original is safe and keeps a restored whole vault
    // usable from the original URL instead of creating a needless duplicate.
    const canFillEmptyDefault = session.id === DEFAULT_DOCUMENT_ID
      && !tombstoned
      && existingMarkdown === ""
      && existingMetadata?.name === "Untitled";
    if (canFillEmptyDefault) {
      const health = await saveLocalDocumentForDocument(DEFAULT_DOCUMENT_ID, markdown);
      if (health.saved !== true) {
        throw new Error(`Could not restore session ${session.id}: ${health.errors[0] ?? "the empty default session could not be saved"}`);
      }
      result.imported += 1;
      result.importedSessionIds.push(DEFAULT_DOCUMENT_ID);
      result.activeDocumentUpdated = true;
      continue;
    }

    // A null preferred id skips the backup id entirely. This matters when a
    // corrupt/orphaned content replica exists without readable metadata.
    const preferredId = existingMetadata || existingMarkdown || tombstoned ? null : session.id;
    let imported: DocumentSession | null = null;
    try {
      imported = await restoreDocumentSession(session, preferredId);
      const health: StorageHealth = await saveLocalDocumentForDocument(imported.id, markdown);
      if (health.saved !== true) {
        throw new Error(health.errors[0] ?? "the restored document could not be saved");
      }
    } catch (error) {
      // The metadata record is new and the content was never allowed to
      // overwrite an existing id. Remove the just-created record when possible;
      // leave already completed imports intact and surface this session as the
      // precise failure to the caller.
      if (imported) {
        try {
          await purgeDocumentSession(imported.id);
        } catch {
          // A cleanup failure is still non-destructive to pre-existing ids;
          // the original restore error is more useful to the caller.
        }
      }
      throw new Error(`Could not restore session ${session.id}: ${String(error)}`);
    }
    result.imported += 1;
    result.importedSessionIds.push(imported.id);
    if (imported.id !== session.id) result.renamed += 1;
    if (imported.id === DEFAULT_DOCUMENT_ID) result.activeDocumentUpdated = true;
  }
  return result;
}

/** Exposed for focused tests and diagnostics without exporting format internals. */
export function backupAssetUri(id: string) {
  return `${ASSET_URI_PREFIX}${id}`;
}

/** Detect embedded data-image destinations in ordinary Markdown. */
export function countEmbeddedLocalImages(markdown: string) {
  return [...markdown.matchAll(DATA_IMAGE_URL_PATTERN)].length;
}
