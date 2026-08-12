import {
  normalizeSearchText,
  normalizeSearchTextWithMapping,
  type SearchSourceRange,
} from "./search-normalization.ts";

export { normalizeSearchText } from "./search-normalization.ts";

export type LocalSearchDocument = {
  id: string;
  name: string;
  markdown: string;
  /** Precomputed once per index refresh so each query does not reparse Markdown. */
  searchableText?: string;
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
    .replace(/~~~[^\n]*\n?([\s\S]*?)~~~/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/\\([\\`*_{}[\]()#+.!-])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeSearchQuery(query: string) {
  return normalizeSearchText(query);
}

function searchTerms(query: string) {
  return [...new Set(normalizeSearchQuery(query).split(" ").filter(Boolean))];
}

function firstMatchIndex(value: string, terms: readonly string[]) {
  return terms.reduce((earliest, term) => {
    const index = value.indexOf(term);
    return index >= 0 && (earliest < 0 || index < earliest) ? index : earliest;
  }, -1);
}

export function searchMatchRanges(value: string, query: string): SearchSourceRange[] {
  const normalized = normalizeSearchTextWithMapping(value);
  const terms = searchTerms(query);
  const ranges: SearchSourceRange[] = [];
  for (const term of terms) {
    let index = normalized.text.indexOf(term);
    while (index >= 0) {
      const endIndex = index + term.length;
      const startRange = normalized.sourceRanges[index];
      const endRange = normalized.sourceRanges[endIndex - 1];
      if (startRange && endRange) ranges.push({ start: startRange.start, end: endRange.end });
      index = normalized.text.indexOf(term, endIndex);
    }
  }
  return ranges
    .sort((left, right) => left.start - right.start || left.end - right.end)
    .reduce<SearchSourceRange[]>((merged, range) => {
      const previous = merged.at(-1);
      if (previous && range.start <= previous.end) {
        previous.end = Math.max(previous.end, range.end);
      } else {
        merged.push({ ...range });
      }
      return merged;
    }, []);
}

export function searchExcerpt(markdown: string, query: string, maxLength = DEFAULT_EXCERPT_LENGTH) {
  return searchExcerptFromText(searchableMarkdown(markdown), query, maxLength);
}

function searchExcerptFromText(text: string, query: string, maxLength: number) {
  if (!text) return "";
  if (text.length <= maxLength) return text;

  const terms = searchTerms(query);
  const normalized = normalizeSearchTextWithMapping(text);
  const matchIndex = firstMatchIndex(normalized.text, terms);
  const center = matchIndex < 0 ? 0 : normalized.sourceRanges[matchIndex]?.start ?? 0;
  // Keep the first matching term near the start of the excerpt. The result
  // card is intentionally compact, so a long lead can hide the match behind
  // the card's two-line clamp on narrow screens.
  const lead = Math.min(24, Math.floor(maxLength * 0.2));
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
      const content = document.searchableText ?? searchableMarkdown(document.markdown);
      const normalizedName = normalizeSearchText(name);
      const normalizedContent = normalizeSearchText(content);
      const nameTermCount = terms.filter((term) => normalizedName.includes(term)).length;
      const contentTermCount = terms.filter((term) => normalizedContent.includes(term)).length;
      const nameMatches = nameTermCount === terms.length;
      const contentMatches = contentTermCount === terms.length;
      const combinedMatches = terms.every((term) => (
        normalizedName.includes(term) || normalizedContent.includes(term)
      ));
      if (!combinedMatches) return [];

      const nameScore = normalizedName === normalizedQuery
        ? 0
        : normalizedName.startsWith(normalizedQuery)
          ? 1
          : 2;
      const match: LocalSearchMatch = nameMatches && contentMatches
        ? "name-and-content"
        : nameTermCount > 0 && contentTermCount > 0
          ? "name-and-content"
        : nameMatches
          ? "name"
          : "content";
      const score = nameMatches ? nameScore : nameTermCount > 0 ? 2 : 3;
      return [{
        documentId: document.id,
        name,
        excerpt: contentTermCount > 0 ? searchExcerptFromText(content, normalizedQuery, DEFAULT_EXCERPT_LENGTH) : "",
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
    .map(({ documentId, name, excerpt, match, updatedAt }) => ({
      documentId,
      name,
      excerpt,
      match,
      updatedAt,
    }));
}
