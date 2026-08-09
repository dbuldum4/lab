import type { DocumentSession } from "./document-sessions.ts";

export type WorkspaceSearchResult = {
  session: DocumentSession;
  snippet: string;
  score: number;
};

function normalize(value: string) {
  return value.trim().toLocaleLowerCase();
}

function contentSnippet(markdown: string, query: string) {
  const compact = markdown.replace(/\s+/g, " ").trim();
  if (!compact) return "Empty note";
  const lower = compact.toLocaleLowerCase();
  const index = lower.indexOf(query);
  if (index < 0) return compact.slice(0, 110);
  const start = Math.max(0, index - 42);
  const end = Math.min(compact.length, index + query.length + 68);
  return `${start > 0 ? "…" : ""}${compact.slice(start, end)}${end < compact.length ? "…" : ""}`;
}

export async function searchWorkspace(
  sessions: readonly DocumentSession[],
  rawQuery: string,
  loadDocument: (documentId: string) => Promise<string>,
  limit = 50,
): Promise<WorkspaceSearchResult[]> {
  const query = normalize(rawQuery);
  if (!query) {
    return sessions.slice(0, limit).map((session) => ({
      session,
      snippet: session.updatedAt > 0 ? "Recent local session" : "Original session",
      score: 0,
    }));
  }

  const results: WorkspaceSearchResult[] = [];
  for (const session of sessions) {
    const name = session.name.toLocaleLowerCase();
    const nameExact = name === query;
    const nameStarts = name.startsWith(query);
    const nameIncludes = name.includes(query);
    let markdown = "";
    try {
      markdown = await loadDocument(session.id);
    } catch {
      // A single inaccessible local session should not make the entire search fail.
    }
    const contentIncludes = markdown.toLocaleLowerCase().includes(query);
    if (!nameIncludes && !contentIncludes) continue;

    const score = nameExact ? 100 : nameStarts ? 80 : nameIncludes ? 60 : 30;
    results.push({
      session,
      snippet: contentIncludes ? contentSnippet(markdown, query) : "Session name match",
      score,
    });
  }

  return results
    .sort((left, right) => (
      right.score - left.score
      || right.session.updatedAt - left.session.updatedAt
      || left.session.name.localeCompare(right.session.name, undefined, { sensitivity: "base" })
    ))
    .slice(0, Math.max(1, limit));
}
