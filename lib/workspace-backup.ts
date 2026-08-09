import type { DocumentSession } from "./document-sessions.ts";

export type WorkspaceBackupDocument = {
  name: string;
  createdAt: number;
  updatedAt: number;
  markdown: string;
};

export type WorkspaceBackup = {
  format: "lab-workspace";
  version: 1;
  exportedAt: number;
  documents: WorkspaceBackupDocument[];
};

const MAX_DOCUMENTS = 512;
const MAX_DOCUMENT_CHARACTERS = 5_000_000;
const MAX_TOTAL_CHARACTERS = 25_000_000;

export async function buildWorkspaceBackup(
  sessions: readonly DocumentSession[],
  loadDocument: (documentId: string) => Promise<string>,
  exportedAt = Date.now(),
): Promise<WorkspaceBackup> {
  const documents: WorkspaceBackupDocument[] = [];
  for (const session of sessions) {
    documents.push({
      name: session.name,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      markdown: await loadDocument(session.id),
    });
  }
  return {
    format: "lab-workspace",
    version: 1,
    exportedAt,
    documents,
  };
}

function finiteTimestamp(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function parseWorkspaceBackup(raw: string): WorkspaceBackup {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("The selected file is not valid JSON.");
  }
  if (!value || typeof value !== "object") throw new Error("This is not a lab workspace backup.");
  const candidate = value as Partial<WorkspaceBackup>;
  if (candidate.format !== "lab-workspace" || candidate.version !== 1 || !Array.isArray(candidate.documents)) {
    throw new Error("This is not a supported lab workspace backup.");
  }
  if (candidate.documents.length === 0 || candidate.documents.length > MAX_DOCUMENTS) {
    throw new Error("The workspace backup has an unsupported document count.");
  }

  let totalCharacters = 0;
  const documents = candidate.documents.map((document, index) => {
    if (!document || typeof document !== "object") throw new Error(`Document ${index + 1} is invalid.`);
    const item = document as Partial<WorkspaceBackupDocument>;
    if (typeof item.markdown !== "string") throw new Error(`Document ${index + 1} has no Markdown content.`);
    if (item.markdown.length > MAX_DOCUMENT_CHARACTERS) throw new Error(`Document ${index + 1} is too large to restore safely.`);
    totalCharacters += item.markdown.length;
    if (totalCharacters > MAX_TOTAL_CHARACTERS) throw new Error("The workspace backup is too large to restore safely.");
    const name = typeof item.name === "string" ? item.name.trim().replace(/\s+/g, " ").slice(0, 80) : "Untitled";
    return {
      name: name || "Untitled",
      createdAt: finiteTimestamp(item.createdAt),
      updatedAt: finiteTimestamp(item.updatedAt),
      markdown: item.markdown,
    };
  });

  return {
    format: "lab-workspace",
    version: 1,
    exportedAt: finiteTimestamp(candidate.exportedAt),
    documents,
  };
}
