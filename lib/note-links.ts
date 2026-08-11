export type BacklinkDocument = {
  id: string;
  name: string;
  markdown: string;
  updatedAt: number;
};

export type Backlink = {
  documentId: string;
  name: string;
  excerpt: string;
  updatedAt: number;
};

const MARKDOWN_LINK = /\[([^\]]+)]\((#[^)\s]+)(?:\s+["'][^"']*["'])?\)/g;

export function localSessionHref(documentId: string): string {
  return `#session=${encodeURIComponent(documentId)}`;
}
export function documentIdFromLocalHref(href: string | null | undefined): string | null {
  if (!href?.startsWith("#session=")) return null;
  try {
    const id = decodeURIComponent(href.slice("#session=".length));
    return /^[a-zA-Z0-9_-]{1,96}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function linkedDocumentIds(markdown: string): string[] {
  const ids = new Set<string>();
  for (const match of markdown.matchAll(MARKDOWN_LINK)) {
    const id = documentIdFromLocalHref(match[2]);
    if (id) ids.add(id);
  }
  return [...ids];
}

function backlinkExcerpt(markdown: string, targetId: string): string {
  const target = localSessionHref(targetId);
  const lines = markdown.split("\n");
  const index = lines.findIndex((line) => line.includes(`](${target})`));
  const source = lines[index] ?? "";
  return source
    .replace(/!\[([^\]]*)]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s*>\s?/, "")
    .replace(/[*_`~]/g, "")
    .trim()
    .slice(0, 180) || "Links to this session";
}

export function findBacklinks(documents: readonly BacklinkDocument[], targetId: string): Backlink[] {
  return documents
    .filter((document) => document.id !== targetId && linkedDocumentIds(document.markdown).includes(targetId))
    .map((document) => ({
      documentId: document.id,
      name: document.name,
      excerpt: backlinkExcerpt(document.markdown, targetId),
      updatedAt: document.updatedAt,
    }))
    .sort((left, right) => right.updatedAt - left.updatedAt || left.name.localeCompare(right.name));
}
