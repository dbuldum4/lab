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

type Fence = { marker: "`" | "~"; length: number };

function parseFenceMarker(line: string) {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!match) return null;
  const marker = match[1][0] as Fence["marker"];
  if (marker === "`" && match[2].includes("`")) return null;
  return { marker, length: match[1].length, suffix: match[2] };
}

function closesFence(line: string, fence: Fence) {
  const marker = parseFenceMarker(line);
  return Boolean(
    marker
    && marker.marker === fence.marker
    && marker.length >= fence.length
    && /^[ \t]*$/.test(marker.suffix),
  );
}

function isEscaped(value: string, index: number) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function hasInlineClose(markdown: string, start: number, delimiter: string) {
  let cursor = start;
  while (cursor < markdown.length) {
    if (markdown[cursor] !== "`" || isEscaped(markdown, cursor)) {
      cursor += 1;
      continue;
    }
    let runEnd = cursor + 1;
    while (runEnd < markdown.length && markdown[runEnd] === "`") runEnd += 1;
    if (runEnd - cursor === delimiter.length) return true;
    cursor = runEnd;
  }
  return false;
}

function maskMarkdownCode(markdown: string) {
  const masked = markdown.split("");
  let fence: Fence | null = null;
  let inlineDelimiter: string | null = null;

  const mask = (start: number, end: number) => {
    for (let cursor = start; cursor < end; cursor += 1) {
      if (masked[cursor] !== "\n" && masked[cursor] !== "\r") masked[cursor] = " ";
    }
  };

  const scanInline = (start: number, end: number) => {
    let cursor = start;
    while (cursor < end) {
      if (markdown[cursor] !== "`" || isEscaped(markdown, cursor)) {
        if (inlineDelimiter) masked[cursor] = " ";
        cursor += 1;
        continue;
      }
      let runEnd = cursor + 1;
      while (runEnd < end && markdown[runEnd] === "`") runEnd += 1;
      const run = markdown.slice(cursor, runEnd);
      if (!inlineDelimiter) {
        // An unmatched backtick run is literal Markdown. Only enter code-span
        // state when the same delimiter occurs later, including on another line.
        if (hasInlineClose(markdown, runEnd, run)) {
          mask(cursor, runEnd);
          inlineDelimiter = run;
        }
      } else if (run === inlineDelimiter) {
        mask(cursor, runEnd);
        inlineDelimiter = null;
      } else {
        mask(cursor, runEnd);
      }
      cursor = runEnd;
    }
  };

  let offset = 0;
  while (offset <= markdown.length) {
    const newline = markdown.indexOf("\n", offset);
    const rawEnd = newline === -1 ? markdown.length : newline;
    const lineEnd = rawEnd > offset && markdown[rawEnd - 1] === "\r" ? rawEnd - 1 : rawEnd;
    const line = markdown.slice(offset, lineEnd);

    if (fence) {
      mask(offset, rawEnd);
      if (closesFence(line, fence)) fence = null;
    } else if (!inlineDelimiter) {
      const opening = parseFenceMarker(line);
      if (opening) {
        mask(offset, rawEnd);
        fence = { marker: opening.marker, length: opening.length };
      } else {
        scanInline(offset, lineEnd);
      }
    } else {
      scanInline(offset, lineEnd);
    }

    if (newline === -1) break;
    offset = newline + 1;
  }

  return masked.join("");
}

type LocalLink = { id: string; index: number };

function localLinks(markdown: string): LocalLink[] {
  const masked = maskMarkdownCode(markdown);
  const links: LocalLink[] = [];
  for (const match of masked.matchAll(MARKDOWN_LINK)) {
    const index = match.index ?? 0;
    if (isEscaped(markdown, index)) continue;
    const previous = markdown[index - 1];
    if (previous === "!" && !isEscaped(markdown, index - 1)) continue;
    const id = documentIdFromLocalHref(match[2]);
    if (id) links.push({ id, index });
  }
  return links;
}

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
  for (const link of localLinks(markdown)) ids.add(link.id);
  return [...ids];
}

function backlinkExcerpt(markdown: string, targetId: string): string {
  const link = localLinks(markdown).find((candidate) => candidate.id === targetId);
  if (!link) return "Links to this session";
  const lineStart = markdown.lastIndexOf("\n", link.index - 1) + 1;
  const lineEnd = markdown.indexOf("\n", link.index);
  const source = markdown.slice(lineStart, lineEnd === -1 ? markdown.length : lineEnd);
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
