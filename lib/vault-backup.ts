import {
  DEFAULT_DOCUMENT_ID,
  inspectLocalStorageForDocument,
  isLocalDocumentDeleted,
  deleteLocalDocumentIfMatches,
  loadLocalDocumentForDocument,
  saveLocalDocumentForDocument,
  saveLocalDocumentForDocumentIfMatches,
  type StorageHealth,
} from "./local-vault.ts";
import {
  getDocumentSession,
  listDocumentSessionsWithStatus,
  restoreExistingDocumentSession,
  restoreDocumentSession,
  rollbackDocumentSessionMetadata,
  type DocumentSession,
} from "./document-sessions.ts";

export const VAULT_BACKUP_FORMAT = "lab-local-vault" as const;
export const VAULT_BACKUP_VERSION = 1 as const;
export const VAULT_BACKUP_FILENAME = "lab-vault-backup.json";
/** Maximum serialized backup size accepted by both parser and file input. */
export const MAX_VAULT_BACKUP_BYTES = 64 * 1024 * 1024;
const ASSET_URI_PREFIX = "lab-asset://";
const ASSET_ID_PATTERN = /^asset-[a-z0-9_-]{1,64}$/;
const DOCUMENT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,96}$/;
const MARKDOWN_DATA_IMAGE_PATTERN = /(!\[(?:\\.|[^\]\\\r\n])*\]\(\s*)(data:image\/[a-z0-9.+-]+(?:;[a-z0-9!#$&^_.+-]+)*,[^\s)]+)(?=\s*(?:"(?:[^"\\]|\\.)*")?\s*\))/gi;
const MARKDOWN_ASSET_IMAGE_PATTERN = /(!\[(?:\\.|[^\]\\\r\n])*\]\(\s*)(lab-asset:\/\/[a-z0-9_-]{1,64})(?=\s*(?:"(?:[^"\\]|\\.)*")?\s*\))/g;
const MAX_SESSIONS = 2_000;
const MAX_ASSETS = 10_000;
const MAX_MARKDOWN_CHARS = 16 * 1024 * 1024;
const MAX_DATA_URL_CHARS = 16 * 1024 * 1024;
const MAX_TOTAL_MARKDOWN_CHARS = 64 * 1024 * 1024;
const MAX_TOTAL_ASSET_CHARS = 64 * 1024 * 1024;
const MAX_RESTORED_MARKDOWN_CHARS = 16 * 1024 * 1024;

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

export type VaultBackupSourceSession = Omit<DocumentSession, "titleSource" | "pinned" | "archived"> &
Partial<Pick<DocumentSession, "titleSource" | "pinned" | "archived">> & {
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

export type VaultRestoreOptions = {
  /** The URL-scoped editor session that should be refreshed after restore. */
  activeDocumentId?: string;
};

export class VaultRestoreError extends Error {
  readonly result: VaultRestoreResult;
  readonly failedSessionId: string;
  readonly cleanupErrors: readonly string[];

  constructor(
    message: string,
    result: VaultRestoreResult,
    failedSessionId: string,
    cleanupErrors: readonly string[] = [],
  ) {
    super(message);
    this.name = "VaultRestoreError";
    this.result = result;
    this.failedSessionId = failedSessionId;
    this.cleanupErrors = cleanupErrors;
  }
}

function fail(message: string): never {
  throw new Error(`Invalid Lab vault backup: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

type MarkdownTransform = (segment: string) => string;

/**
 * Apply an image transformation only to ordinary Markdown text. Fenced code
 * blocks and inline code spans are opaque: asset-looking text in examples or
 * pasted source must remain literal Markdown.
 */
function transformMarkdownOutsideCode(markdown: string, transform: MarkdownTransform) {
  const parts = markdown.split(/(\r?\n)/);
  let fence: { marker: "`" | "~"; length: number } | null = null;
  let inlineDelimiter: string | null = null;
  let output = "";

  const findBacktickRun = (value: string, from: number) => {
    for (let index = from; index < value.length; index += 1) {
      if (value[index] !== "`") continue;
      let end = index + 1;
      while (end < value.length && value[end] === "`") end += 1;
      return { start: index, end, text: value.slice(index, end) };
    }
    return null;
  };

  const transformInline = (line: string, lineStart: number) => {
    let cursor = lineStart;
    while (cursor < line.length) {
      if (inlineDelimiter) {
        let close: ReturnType<typeof findBacktickRun> = null;
        let search = cursor;
        while ((close = findBacktickRun(line, search))) {
          if (close.text.length === inlineDelimiter.length) break;
          search = close.end;
        }
        if (!close) {
          output += line.slice(cursor);
          return;
        }
        output += line.slice(cursor, close.end);
        cursor = close.end;
        inlineDelimiter = null;
        continue;
      }

      const opening = findBacktickRun(line, cursor);
      if (!opening) {
        output += transform(line.slice(cursor));
        return;
      }
      output += transform(line.slice(cursor, opening.start));
      output += opening.text;
      let close: ReturnType<typeof findBacktickRun> = null;
      let search = opening.end;
      while ((close = findBacktickRun(line, search))) {
        if (close.text.length === opening.text.length) break;
        search = close.end;
      }
      if (!close) {
        inlineDelimiter = opening.text;
        output += line.slice(opening.end);
        return;
      }
      output += line.slice(opening.end, close.end);
      cursor = close.end;
    }
  };

  for (const part of parts) {
    if (part === "\n" || part === "\r\n") {
      output += part;
      continue;
    }

    const fenceMatch = part.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      output += part;
      if (
        fenceMatch
        && fenceMatch[1]?.[0] === fence.marker
        && fenceMatch[1].length >= fence.length
        && fenceMatch[2].trim() === ""
      ) {
        fence = null;
      }
      continue;
    }
    if (fenceMatch && !inlineDelimiter) {
      output += part;
      fence = { marker: fenceMatch[1][0] as "`" | "~", length: fenceMatch[1].length };
      continue;
    }

    transformInline(part, 0);
  }

  return output;
}

function decodeImagePayload(payload: string, base64: boolean): Uint8Array | null {
  try {
    if (base64) {
      if (!/^[a-z0-9+/]*={0,2}$/i.test(payload) || payload.length % 4 === 1) return null;
      if (typeof globalThis.atob !== "function") return null;
      const decoded = globalThis.atob(payload);
      const bytes = new Uint8Array(decoded.length);
      for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
      return bytes;
    }
    return new TextEncoder().encode(decodeURIComponent(payload));
  } catch {
    return null;
  }
}

function startsWithBytes(bytes: Uint8Array, expected: readonly number[]) {
  return expected.every((value, index) => bytes[index] === value);
}

function imageSignatureMatches(mimeType: string, bytes: Uint8Array) {
  if (bytes.length === 0) return false;
  switch (mimeType) {
    case "image/png":
      return startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
    case "image/jpg":
      return startsWithBytes(bytes, [0xff, 0xd8, 0xff]);
    case "image/gif":
      return new TextDecoder().decode(bytes.slice(0, 6)) === "GIF87a"
        || new TextDecoder().decode(bytes.slice(0, 6)) === "GIF89a";
    case "image/webp":
      return startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46])
        && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
    case "image/bmp":
      return startsWithBytes(bytes, [0x42, 0x4d]);
    case "image/x-icon":
    case "image/vnd.microsoft.icon":
      return startsWithBytes(bytes, [0x00, 0x00, 0x01, 0x00]);
    case "image/svg+xml": {
      const text = new TextDecoder().decode(bytes).replace(/^\uFEFF/, "").trimStart();
      return /^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(text);
    }
    default:
      // Unknown image subtypes are still bounded and must contain bytes. The
      // renderer will apply the same parser, so they cannot bypass validation.
      return true;
  }
}

function parseImageDataUrl(value: string) {
  if (value.length > MAX_DATA_URL_CHARS) return null;
  const comma = value.indexOf(",");
  if (!value.toLowerCase().startsWith("data:image/") || comma <= "data:".length) return null;
  const header = value.slice("data:".length, comma);
  const [rawMimeType, ...parameters] = header.split(";");
  if (!/^image\/[a-z0-9.+-]+$/i.test(rawMimeType ?? "")) return null;
  if (parameters.some((parameter) => !/^[a-z0-9!#$&^_.+-]+(?:=[a-z0-9!#$&^_.+-]*)?$/i.test(parameter))) {
    return null;
  }
  const payload = value.slice(comma + 1);
  if (!payload || /[\u0000-\u0020\u007f]/.test(payload)) return null;
  const base64 = parameters.some((parameter) => parameter.toLowerCase() === "base64");
  if (!base64 && /%(?![a-f0-9]{2})/i.test(payload)) return null;
  const mimeType = rawMimeType.toLowerCase();
  const bytes = decodeImagePayload(payload, base64);
  if (!bytes || !imageSignatureMatches(mimeType, bytes)) return null;
  const canonicalParameters = parameters.map((parameter) => (
    parameter.toLowerCase() === "base64" ? "base64" : parameter
  ));
  const canonicalHeader = [mimeType, ...canonicalParameters].join(";");
  return {
    mimeType,
    dataUrl: `data:${canonicalHeader},${payload}`,
  };
}

/** Shared image validation used by backup parsing and the editor renderer. */
export function isValidLocalImageDataUrl(value: string) {
  return Boolean(parseImageDataUrl(value.trim()));
}

function externalizeEmbeddedImages(markdown: string, assets: VaultBackupAsset[]) {
  const byDataUrl = new Map<string, VaultBackupAsset>();
  for (const asset of assets) byDataUrl.set(asset.dataUrl, asset);

  const transform = (segment: string) => segment.replace(
    MARKDOWN_DATA_IMAGE_PATTERN,
    (_match, prefix: string, rawDataUrl: string) => {
      const parsed = parseImageDataUrl(rawDataUrl);
      if (!parsed) fail("an embedded image has an invalid local data URL");
      let asset = byDataUrl.get(parsed.dataUrl);
      if (!asset) {
        if (assets.length >= MAX_ASSETS || assets.reduce((total, item) => total + item.dataUrl.length, 0) + parsed.dataUrl.length > MAX_TOTAL_ASSET_CHARS) {
          fail("the image asset table is oversized");
        }
        asset = {
          id: `asset-${assets.length + 1}`,
          dataUrl: parsed.dataUrl,
          mimeType: parsed.mimeType,
        };
        assets.push(asset);
        byDataUrl.set(parsed.dataUrl, asset);
      }
      return `${prefix}${ASSET_URI_PREFIX}${asset.id}`;
    },
  );

  // A malformed image URL outside a normal Markdown image destination is not
  // silently dropped. It stays in the note and is still safe to export, but
  // it is not considered an embedded image asset.
  return transformMarkdownOutsideCode(markdown, transform);
}

function validateEmbeddedImageReferences(
  markdown: string,
  assets: Map<string, VaultBackupAsset>,
) {
  let expandedLength = markdown.length;
  transformMarkdownOutsideCode(markdown, (segment) => {
    segment.replace(MARKDOWN_ASSET_IMAGE_PATTERN, (_match, _prefix: string, assetUri: string) => {
      const asset = assets.get(assetUri.slice(ASSET_URI_PREFIX.length));
      if (!asset) fail(`the Markdown references missing image asset ${assetUri}`);
      expandedLength += asset.dataUrl.length - assetUri.length;
      if (expandedLength > MAX_RESTORED_MARKDOWN_CHARS) {
        fail("the restored Markdown is oversized after image expansion");
      }
      return _match;
    });
    return segment;
  });
  return expandedLength;
}

function restoreEmbeddedImages(markdown: string, assets: Map<string, VaultBackupAsset>) {
  validateEmbeddedImageReferences(markdown, assets);
  return transformMarkdownOutsideCode(markdown, (segment) => segment.replace(
    MARKDOWN_ASSET_IMAGE_PATTERN,
    (_match, prefix: string, assetUri: string) => {
      const asset = assets.get(assetUri.slice(ASSET_URI_PREFIX.length));
      if (!asset) fail(`the Markdown references missing image asset ${assetUri}`);
      return `${prefix}${asset.dataUrl}`;
    },
  ));
}

function validateSession(value: unknown, index: number): VaultBackupSession {
  if (!isRecord(value)) fail(`session ${index + 1} is not an object`);
  const { id, name, titleSource, pinned, archived, createdAt, updatedAt, markdown } = value;
  if (typeof id !== "string" || !DOCUMENT_ID_PATTERN.test(id)) {
    fail(`session ${index + 1} has an invalid id`);
  }
  if (typeof name !== "string" || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
    fail(`session ${id} has an invalid name`);
  }
  if (titleSource !== undefined && titleSource !== "automatic" && titleSource !== "manual") {
    fail(`session ${id} has an invalid title source`);
  }
  if (pinned !== undefined && typeof pinned !== "boolean") {
    fail(`session ${id} has an invalid pinned state`);
  }
  if (archived !== undefined && typeof archived !== "boolean") {
    fail(`session ${id} has an invalid archived state`);
  }
  if (!isFiniteTimestamp(createdAt) || !isFiniteTimestamp(updatedAt)) {
    fail(`session ${id} has invalid timestamps`);
  }
  if (typeof markdown !== "string" || markdown.length > MAX_MARKDOWN_CHARS) {
    fail(`session ${id} has invalid or oversized Markdown`);
  }
  return {
    id,
    name,
    titleSource: titleSource ?? (name.trim().replace(/\s+/g, " ") === "Untitled" ? "automatic" : "manual"),
    pinned: pinned ?? false,
    archived: id === DEFAULT_DOCUMENT_ID ? false : (archived ?? false),
    createdAt,
    updatedAt,
    markdown,
  };
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
  return { id, dataUrl: parsed.dataUrl, mimeType: parsed.mimeType };
}

/** Validate an untrusted parsed backup before any storage mutation occurs. */
export function parseVaultBackup(value: unknown): VaultBackup {
  const candidate = typeof value === "string"
    ? (() => {
      if (value.length > MAX_VAULT_BACKUP_BYTES) fail("the backup file is oversized");
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
  const totalMarkdownChars = sessions.reduce((total, session) => total + session.markdown.length, 0);
  if (totalMarkdownChars > MAX_TOTAL_MARKDOWN_CHARS) fail("the Markdown payload is oversized");
  const sessionIds = new Set<string>();
  for (const session of sessions) {
    if (sessionIds.has(session.id)) fail(`the session id ${session.id} appears more than once`);
    sessionIds.add(session.id);
  }

  const assets = rawAssets.map(validateAsset);
  const totalAssetChars = assets.reduce((total, asset) => total + asset.dataUrl.length, 0);
  if (totalAssetChars > MAX_TOTAL_ASSET_CHARS) fail("the image asset table is oversized");
  if (totalMarkdownChars + totalAssetChars > MAX_VAULT_BACKUP_BYTES) {
    fail("the backup payload is oversized");
  }
  const assetsById = new Map<string, VaultBackupAsset>();
  for (const asset of assets) {
    if (assetsById.has(asset.id)) fail(`the image asset id ${asset.id} appears more than once`);
    assetsById.set(asset.id, asset);
  }
  let totalRestoredMarkdownChars = 0;
  for (const session of sessions) {
    // This second pass validates every asset reference and expansion bound
    // without allocating the expanded Markdown string.
    totalRestoredMarkdownChars += validateEmbeddedImageReferences(session.markdown, assetsById);
    if (totalRestoredMarkdownChars > MAX_TOTAL_MARKDOWN_CHARS) {
      fail("the restored Markdown payload is oversized");
    }
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
  const sourceIds = new Set<string>();
  let totalMarkdownChars = 0;
  const sessions = [...sourceSessions]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((session) => {
      if (!DOCUMENT_ID_PATTERN.test(session.id) || sourceIds.has(session.id)) {
        throw new Error("The vault contains duplicate or invalid session metadata.");
      }
      sourceIds.add(session.id);
      const titleSource = session.titleSource
        ?? (typeof session.name === "string" && session.name.trim().replace(/\s+/g, " ") === "Untitled"
          ? "automatic"
          : "manual");
      const pinned = session.pinned ?? false;
      const archived = session.id === DEFAULT_DOCUMENT_ID ? false : (session.archived ?? false);
      if (
        typeof session.name !== "string"
        || session.name.length > 80
        || /[\u0000-\u001f\u007f]/.test(session.name)
        || (titleSource !== "automatic" && titleSource !== "manual")
        || typeof pinned !== "boolean"
        || typeof archived !== "boolean"
        || !isFiniteTimestamp(session.createdAt)
        || !isFiniteTimestamp(session.updatedAt)
        || typeof session.markdown !== "string"
        || session.markdown.length > MAX_MARKDOWN_CHARS
      ) throw new Error(`Session ${session.id} cannot be exported.`);
      totalMarkdownChars += session.markdown.length;
      if (totalMarkdownChars > MAX_TOTAL_MARKDOWN_CHARS) throw new Error("The Markdown payload is oversized.");
      return {
        id: session.id,
        name: session.name,
        titleSource,
        pinned,
        archived,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        markdown: externalizeEmbeddedImages(session.markdown, assets),
      };
    });
  const backup: VaultBackup = {
    format: VAULT_BACKUP_FORMAT,
    version: VAULT_BACKUP_VERSION,
    exportedAt,
    counts: { sessions: sessions.length, assets: assets.length },
    sessions,
    assets,
  };
  if (`${JSON.stringify(backup, null, 2)}\n`.length > MAX_VAULT_BACKUP_BYTES) {
    throw new Error("The serialized vault backup is oversized.");
  }
  return backup;
}

export function serializeVaultBackup(backup: VaultBackup) {
  const serialized = `${JSON.stringify(parseVaultBackup(backup), null, 2)}\n`;
  if (serialized.length > MAX_VAULT_BACKUP_BYTES) throw new Error("The serialized vault backup is oversized.");
  return serialized;
}

function sameSessionCatalog(left: readonly DocumentSession[], right: readonly DocumentSession[]) {
  if (left.length !== right.length) return false;
  const rightById = new Map(right.map((session) => [session.id, session]));
  return left.every((session) => sameSessionMetadata(rightById.get(session.id) ?? null, {
    ...session,
    markdown: "",
  }));
}

function sameSessionIdentity(left: readonly DocumentSession[], right: readonly DocumentSession[]) {
  if (left.length !== right.length) return false;
  const rightById = new Map(right.map((session) => [session.id, session]));
  return left.every((session) => {
    const other = rightById.get(session.id);
    return Boolean(
      other
      && other.id === session.id
      && other.name === session.name
      && other.titleSource === session.titleSource
      && other.pinned === session.pinned
      && other.archived === session.archived
      && other.createdAt === session.createdAt,
    );
  });
}

function storageHealthFailure(sessionId: string, health: StorageHealth) {
  if (health.saved !== true) {
    return new Error(`Session ${sessionId} was not durably saved: ${health.errors[0] ?? "the storage authority rejected the write"}`);
  }
  if (health.errors.length > 0) {
    return new Error(`Session ${sessionId} has incomplete redundant storage: ${health.errors.join("; ")}`);
  }
  return null;
}

async function readExportSession(session: DocumentSession): Promise<VaultBackupSourceSession> {
  if (session.id !== DEFAULT_DOCUMENT_ID && isLocalDocumentDeleted(session.id)) {
    throw new Error(`Session ${session.id} was deleted while the backup was being prepared.`);
  }
  const markdown = await loadLocalDocumentForDocument(session.id);
  const health = await inspectLocalStorageForDocument(session.id);
  if (health.errors.length > 0) {
    throw new Error(`Session ${session.id} could not be verified for backup: ${health.errors.join("; ")}`);
  }
  if (session.id !== DEFAULT_DOCUMENT_ID && isLocalDocumentDeleted(session.id)) {
    throw new Error(`Session ${session.id} was deleted while the backup was being prepared.`);
  }
  return { ...session, markdown };
}

/**
 * Read every live session through the existing scoped/redundant vault path.
 * The catalog/content double fence makes a backup fail closed when another tab
 * creates, deletes, renames, or edits a session during the export.
 */
export async function exportLocalVault(): Promise<VaultBackup> {
  let catalog = listDocumentSessionsWithStatus({ archived: "all" });
  if (!catalog.complete) throw new Error("The session catalog could not be read completely.");
  let sourceSessions = await Promise.all(catalog.sessions.map(readExportSession));

  // A durable save updates the active session's activity timestamp through a
  // separate metadata task. Allow a bounded timestamp-only stabilization pass
  // so that task is not mistaken for a concurrent rename/delete/create. Any
  // identity change still fails closed, and content is re-read after each
  // timestamp change.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const next = listDocumentSessionsWithStatus({ archived: "all" });
    if (!next.complete || !sameSessionIdentity(catalog.sessions, next.sessions)) {
      throw new Error("The session catalog changed while the backup was being prepared.");
    }
    if (sameSessionCatalog(catalog.sessions, next.sessions)) {
      const verified = await Promise.all(next.sessions.map(readExportSession));
      const sourceById = new Map(sourceSessions.map((session) => [session.id, session.markdown]));
      if (verified.some((session) => session.markdown !== sourceById.get(session.id))) {
        throw new Error("A session changed while the backup was being prepared.");
      }
      const final = listDocumentSessionsWithStatus({ archived: "all" });
      if (!final.complete || !sameSessionIdentity(next.sessions, final.sessions)) {
        throw new Error("The session catalog changed while the backup was being finalized.");
      }
      if (sameSessionCatalog(next.sessions, final.sessions)) return buildVaultBackup(sourceSessions, Date.now());
      catalog = final;
      sourceSessions = await Promise.all(catalog.sessions.map(readExportSession));
      continue;
    }
    catalog = next;
    sourceSessions = await Promise.all(catalog.sessions.map(readExportSession));
  }
  throw new Error("The session catalog changed repeatedly while the backup was being prepared.");
}

function sameSessionMetadata(left: DocumentSession | null, right: VaultBackupSession) {
  return Boolean(
    left
    && left.id === right.id
    && left.name === right.name
    && left.titleSource === right.titleSource
    && left.pinned === right.pinned
    && left.archived === right.archived
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt,
  );
}

/**
 * Merge a validated backup without replacing existing documents. Exact matches
 * are skipped; conflicts are imported under a fresh id. No existing id is
 * overwritten, and tombstoned ids are never revived.
 */
export async function restoreLocalVault(
  input: VaultBackup,
  options: VaultRestoreOptions = {},
): Promise<VaultRestoreResult> {
  const backup = parseVaultBackup(input);
  const assets = new Map(backup.assets.map((asset) => [asset.id, asset]));
  const activeDocumentId = options.activeDocumentId && DOCUMENT_ID_PATTERN.test(options.activeDocumentId)
    ? options.activeDocumentId
    : DEFAULT_DOCUMENT_ID;
  const result: VaultRestoreResult = {
    imported: 0,
    skipped: 0,
    renamed: 0,
    assets: backup.assets.length,
    importedSessionIds: [],
    activeDocumentUpdated: false,
  };

  const createdSessions: Array<{ metadata: DocumentSession; markdown: string; contentCommitted: boolean }> = [];
  let filledDefault: {
    originalMetadata: DocumentSession;
    originalMarkdown: string;
    restoredMarkdown: string;
    restoredMetadata: DocumentSession;
  } | null = null;
  let failedSessionId = "unknown";

  const cleanupCreatedSession = async (
    record: { metadata: DocumentSession; markdown: string; contentCommitted: boolean },
  ) => {
    const errors: string[] = [];
    try {
      const removed = await rollbackDocumentSessionMetadata(
        record.metadata,
        async () => {
          if (!record.contentCommitted) {
            // The authority rejected the restore write, so there is no restore
            // content to purge. Preserve any peer content; metadata itself is
            // still removed only if it exactly matches our allocation.
            return true;
          }
          if (record.metadata.id !== DEFAULT_DOCUMENT_ID) {
            return deleteLocalDocumentIfMatches(record.metadata.id, record.markdown);
          }
          const compared = await saveLocalDocumentForDocumentIfMatches(
            DEFAULT_DOCUMENT_ID,
            record.markdown,
            "",
          );
          if (!compared.matched) return false;
          const failure = compared.health && storageHealthFailure(DEFAULT_DOCUMENT_ID, compared.health);
          if (failure) throw failure;
          return true;
        },
      );
      if (!removed) errors.push(`${record.metadata.id} content or metadata changed before cleanup`);
    } catch (error) {
      errors.push(`${record.metadata.id} coordinated cleanup failed: ${String(error)}`);
    }
    return errors;
  };

  const rollbackFilledDefault = async () => {
    if (!filledDefault) return [] as string[];
    const errors: string[] = [];
    try {
      const rollbackContent = async () => {
        const compared = await saveLocalDocumentForDocumentIfMatches(
          DEFAULT_DOCUMENT_ID,
          filledDefault!.restoredMarkdown,
          filledDefault!.originalMarkdown,
        );
        if (!compared.matched) return false;
        const failure = compared.health && storageHealthFailure(DEFAULT_DOCUMENT_ID, compared.health);
        if (failure) throw failure;
        return true;
      };
      const restored = await restoreExistingDocumentSession(
        filledDefault.originalMetadata,
        filledDefault.restoredMetadata,
        rollbackContent,
      ) ?? await restoreExistingDocumentSession(
        filledDefault.originalMetadata,
        filledDefault.originalMetadata,
        rollbackContent,
      );
      if (!restored) errors.push("default content or metadata changed before rollback");
    } catch (error) {
      errors.push(`default rollback failed: ${String(error)}`);
    }
    return errors;
  };

  const rollbackAll = async () => {
    const errors = await rollbackFilledDefault();
    for (const record of [...createdSessions].reverse()) {
      errors.push(...await cleanupCreatedSession(record));
    }
    return errors;
  };

  try {
    for (const session of backup.sessions) {
      failedSessionId = session.id;
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
        && existingMetadata?.name === "Untitled"
        && existingMetadata.titleSource === "automatic";
      if (canFillEmptyDefault && existingMetadata) {
        filledDefault = {
          originalMetadata: existingMetadata,
          originalMarkdown: existingMarkdown,
          restoredMarkdown: markdown,
          restoredMetadata: session,
        };
        const restoredMetadata = await restoreExistingDocumentSession(
          session,
          existingMetadata,
          async () => {
            const compared = await saveLocalDocumentForDocumentIfMatches(DEFAULT_DOCUMENT_ID, "", markdown);
            if (!compared.matched) return false;
            const failure = compared.health && storageHealthFailure(session.id, compared.health);
            if (failure) throw failure;
            return true;
          },
        );
        if (!restoredMetadata) {
          filledDefault = null;
          // The empty snapshot or its metadata lost the CAS. Import safely under
          // a fresh id rather than overwriting the peer edit.
        } else {
          result.imported += 1;
          result.importedSessionIds.push(DEFAULT_DOCUMENT_ID);
          result.activeDocumentUpdated = activeDocumentId === DEFAULT_DOCUMENT_ID;
          continue;
        }
      }

      // A null preferred id skips the backup id entirely. This matters when a
      // corrupt/orphaned content replica exists without readable metadata.
      const preferredId = existingMetadata || existingMarkdown || tombstoned ? null : session.id;
      const imported = await restoreDocumentSession(session, preferredId);
      const record = { metadata: imported, markdown, contentCommitted: false };
      createdSessions.push(record);
      const health: StorageHealth = await saveLocalDocumentForDocument(imported.id, markdown);
      const currentMarkdown = await loadLocalDocumentForDocument(imported.id);
      // No readable copy means the failed write left metadata only. Any
      // readable differing copy may be a peer edit and must go through CAS.
      record.contentCommitted = currentMarkdown === markdown || health.copies > 0;
      const failure = storageHealthFailure(imported.id, health);
      if (failure) throw failure;

      result.imported += 1;
      result.importedSessionIds.push(imported.id);
      if (imported.id !== session.id) result.renamed += 1;
      if (imported.id === activeDocumentId) result.activeDocumentUpdated = true;
    }
    return result;
  } catch (error) {
    const cleanupErrors = await rollbackAll();
    const suffix = cleanupErrors.length > 0
      ? ` Cleanup was incomplete: ${cleanupErrors.join("; ")}`
      : " All changes from this restore were rolled back.";
    throw new VaultRestoreError(
      `Could not restore session ${failedSessionId}: ${String(error)}.${suffix}`,
      result,
      failedSessionId,
      cleanupErrors,
    );
  }
}

/** Exposed for focused tests and diagnostics without exporting format internals. */
export function backupAssetUri(id: string) {
  return `${ASSET_URI_PREFIX}${id}`;
}

/** Detect embedded data-image destinations in ordinary Markdown. */
export function countEmbeddedLocalImages(markdown: string) {
  let count = 0;
  transformMarkdownOutsideCode(markdown, (segment) => {
    count += [...segment.matchAll(MARKDOWN_DATA_IMAGE_PATTERN)].length;
    return segment;
  });
  return count;
}
