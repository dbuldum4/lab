export type LocalSearchDocument = {
  id: string;
  name: string;
  markdown: string;
  updatedAt?: number;
};

export type LocalSearchMatch = "name" | "content" | "name-and-content";

export type LocalSearchResult = {
  documentId: string;
  name: string;
  excerpt: string;
  match: LocalSearchMatch;
  updatedAt: number;
};

const DEFAULT_EXCERPT_LENGTH = 176;

/** Convert persisted Markdown into compact, readable text for local search. */
export function searchableMarkdown(markdown: string) {
  return markdown
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/\$\$?/g, "")
    .replace(/[\\*_~`]/g, "")
    .replace(/\\([\\`*_{}[\]()#+.!-])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeSearchQuery(query: string) {
  return query.trim().replace(/\s+/g, " ");
}

function searchTerms(query: string) {
  return [...new Set(normalizeSearchQuery(query).toLowerCase().split(" ").filter(Boolean))];
}

function containsEveryTerm(value: string, terms: readonly string[]) {
  const normalized = value.toLowerCase();
  return terms.every((term) => normalized.includes(term));
}

function firstMatchIndex(value: string, terms: readonly string[]) {
  const normalized = value.toLowerCase();
  return terms.reduce((earliest, term) => {
    const index = normalized.indexOf(term);
    return index >= 0 && (earliest < 0 || index < earliest) ? index : earliest;
  }, -1);
}

export function searchExcerpt(markdown: string, query: string, maxLength = DEFAULT_EXCERPT_LENGTH) {
  const text = searchableMarkdown(markdown);
  if (!text) return "";
  if (text.length <= maxLength) return text;

  const terms = searchTerms(query);
  const matchIndex = firstMatchIndex(text, terms);
  const center = matchIndex < 0 ? 0 : matchIndex;
  const lead = Math.min(52, Math.floor(maxLength * 0.32));
  const start = Math.max(0, Math.min(center - lead, text.length - maxLength));
  const end = Math.min(text.length, start + maxLength);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

/** Search names and note text, returning at most one useful result per session. */
export function searchLocalDocuments(
  documents: readonly LocalSearchDocument[],
  query: string,
): LocalSearchResult[] {
  const normalizedQuery = normalizeSearchQuery(query);
  const terms = searchTerms(normalizedQuery);
  if (terms.length === 0) return [];

  return documents
    .flatMap((document) => {
      const name = document.name.trim() || "Untitled";
      const content = searchableMarkdown(document.markdown);
      const nameMatches = containsEveryTerm(name, terms);
      const contentMatches = containsEveryTerm(content, terms);
      if (!nameMatches && !contentMatches) return [];

      const normalizedName = name.toLowerCase();
      const normalizedQueryLower = normalizedQuery.toLowerCase();
      const nameScore = normalizedName === normalizedQueryLower
        ? 0
        : normalizedName.startsWith(normalizedQueryLower)
          ? 1
          : 2;
      const match: LocalSearchMatch = nameMatches && contentMatches
        ? "name-and-content"
        : nameMatches
          ? "name"
          : "content";
      const score = nameMatches ? nameScore : 3;
      return [{
        documentId: document.id,
        name,
        excerpt: contentMatches ? searchExcerpt(document.markdown, normalizedQuery) : "",
        match,
        updatedAt: Number.isFinite(document.updatedAt) ? Number(document.updatedAt) : 0,
        score,
      }];
    })
    .sort((left, right) => (
      left.score - right.score
      || right.updatedAt - left.updatedAt
      || left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
      || left.documentId.localeCompare(right.documentId)
    ))
    .slice(0, 24)
    .map(({ documentId, name, excerpt, match, updatedAt }) => ({
      documentId,
      name,
      excerpt,
      match,
      updatedAt,
    }));
}
