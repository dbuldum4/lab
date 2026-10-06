//! Accent- and case-insensitive search across local notes.
//!
//! Mirrors `lib/search-normalization.ts` and `lib/local-search.ts`. Offsets in
//! source ranges are byte offsets into the original string.

use std::ops::Range;
use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::is_combining_mark;

pub struct NormalizedText {
    pub text: String,
    /// One source byte range per byte of `text`.
    pub source_ranges: Vec<Range<usize>>,
}

fn normalize_char(ch: char, out: &mut String) {
    for decomposed in std::iter::once(ch).nfkd() {
        if is_combining_mark(decomposed) {
            continue;
        }
        for lower in decomposed.to_lowercase() {
            if is_combining_mark(lower) {
                continue;
            }
            out.push(if lower.is_whitespace() { ' ' } else { lower });
        }
    }
}

/// Normalize text while keeping a source range for every normalized byte.
pub fn normalize_with_mapping(value: &str) -> NormalizedText {
    let mut text = String::new();
    let mut ranges: Vec<Range<usize>> = Vec::new();
    let mut pending_start: Option<usize> = None;
    let mut scratch = String::new();

    for (start, ch) in value.char_indices() {
        let end = start + ch.len_utf8();
        scratch.clear();
        normalize_char(ch, &mut scratch);
        if scratch.is_empty() {
            if is_combining_mark(ch) {
                if let Some(last) = ranges.last_mut() {
                    last.end = end;
                } else {
                    pending_start.get_or_insert(start);
                }
            }
            continue;
        }
        let range_start = pending_start.take().unwrap_or(start);
        for normalized in scratch.chars() {
            if normalized == ' ' && text.ends_with(' ') {
                if let Some(last) = ranges.last_mut() {
                    last.end = end;
                }
                continue;
            }
            text.push(normalized);
            for _ in 0..normalized.len_utf8() {
                ranges.push(range_start..end);
            }
        }
    }

    let leading = text.len() - text.trim_start_matches(' ').len();
    let trailing = text.len() - text.trim_end_matches(' ').len();
    let end = text.len() - trailing;
    if leading >= end {
        return NormalizedText {
            text: String::new(),
            source_ranges: Vec::new(),
        };
    }
    NormalizedText {
        text: text[leading..end].to_string(),
        source_ranges: ranges[leading..end].to_vec(),
    }
}

pub fn normalize(value: &str) -> String {
    normalize_with_mapping(value).text
}

macro_rules! regex {
    ($pattern:expr) => {{
        static RE: std::sync::LazyLock<regex::Regex> =
            std::sync::LazyLock::new(|| regex::Regex::new($pattern).unwrap());
        &*RE
    }};
}
pub(crate) use regex;

/// Convert Markdown into compact, readable text for search.
pub fn searchable_markdown(markdown: &str) -> String {
    let text = regex!(r"```[^\n]*\n?((?s:.*?))```").replace_all(markdown, "$1");
    let text = regex!(r"~~~[^\n]*\n?((?s:.*?))~~~").replace_all(&text, "$1");
    let text = regex!(r"!\[([^\]]*)\]\([^)]*\)").replace_all(&text, "$1");
    let text = regex!(r"\[([^\]]+)\]\([^)]*\)").replace_all(&text, "$1");
    let text = regex!(r"(?m)^\s{0,3}#{1,6}\s+").replace_all(&text, "");
    let text = regex!(r"(?m)^\s*[-*+]\s+").replace_all(&text, "");
    let text = regex!(r"(?m)^\s*\d+[.)]\s+").replace_all(&text, "");
    let text = regex!(r"\\([\\`*_{}\[\]()#+.!-])").replace_all(&text, "$1");
    let text = regex!(r"\s+").replace_all(&text, " ");
    text.trim().to_string()
}

fn search_terms(query: &str) -> Vec<String> {
    let mut terms: Vec<String> = Vec::new();
    for term in normalize(query).split(' ').filter(|term| !term.is_empty()) {
        if !terms.iter().any(|existing| existing == term) {
            terms.push(term.to_string());
        }
    }
    terms
}

/// Byte ranges in `value` that match any query term, merged and sorted.
pub fn match_ranges(value: &str, query: &str) -> Vec<Range<usize>> {
    let normalized = normalize_with_mapping(value);
    let mut ranges: Vec<Range<usize>> = Vec::new();
    for term in search_terms(query) {
        let mut from = 0;
        while let Some(found) = normalized.text[from..].find(&term) {
            let index = from + found;
            let end = index + term.len();
            ranges
                .push(normalized.source_ranges[index].start..normalized.source_ranges[end - 1].end);
            from = end;
        }
    }
    ranges.sort_by(|a, b| a.start.cmp(&b.start).then(a.end.cmp(&b.end)));
    let mut merged: Vec<Range<usize>> = Vec::new();
    for range in ranges {
        match merged.last_mut() {
            Some(previous) if range.start <= previous.end => {
                previous.end = previous.end.max(range.end)
            }
            _ => merged.push(range),
        }
    }
    merged
}

const EXCERPT_CHARS: usize = 176;

fn excerpt_from_text(text: &str, query: &str, max_chars: usize) -> String {
    let total = text.chars().count();
    if total <= max_chars {
        return text.to_string();
    }
    let terms = search_terms(query);
    let normalized = normalize_with_mapping(text);
    let first = terms
        .iter()
        .filter_map(|term| normalized.text.find(term.as_str()))
        .min();
    let center_byte = first
        .map(|index| normalized.source_ranges[index].start)
        .unwrap_or(0);
    let center = text[..center_byte].chars().count();
    let lead = 24.min(max_chars / 5);
    let start = center.saturating_sub(lead).min(total - max_chars);
    let end = (start + max_chars).min(total);
    let slice: String = text.chars().skip(start).take(end - start).collect();
    format!(
        "{}{}{}",
        if start > 0 { "…" } else { "" },
        slice.trim(),
        if end < total { "…" } else { "" }
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MatchKind {
    Name,
    Content,
    NameAndContent,
}

impl MatchKind {
    pub fn label(self) -> &'static str {
        match self {
            MatchKind::Name => "Session name",
            MatchKind::Content => "Note text",
            MatchKind::NameAndContent => "Name + note text",
        }
    }
}

pub struct SearchDocument<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub searchable_text: &'a str,
    pub updated_at: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SearchResult {
    pub document_id: String,
    pub name: String,
    pub excerpt: String,
    pub kind: MatchKind,
    pub updated_at: i64,
}

/// Search names and note text, returning at most one result per session.
pub fn search_documents(documents: &[SearchDocument<'_>], query: &str) -> Vec<SearchResult> {
    let normalized_query = normalize(query);
    let terms = search_terms(&normalized_query);
    if terms.is_empty() {
        return Vec::new();
    }
    let mut scored: Vec<(u8, SearchResult)> = documents
        .iter()
        .filter_map(|document| {
            let name = match document.name.trim() {
                "" => "Untitled",
                trimmed => trimmed,
            };
            let normalized_name = normalize(name);
            let normalized_content = normalize(document.searchable_text);
            let name_terms = terms
                .iter()
                .filter(|t| normalized_name.contains(t.as_str()))
                .count();
            let content_terms = terms
                .iter()
                .filter(|t| normalized_content.contains(t.as_str()))
                .count();
            let combined = terms.iter().all(|t| {
                normalized_name.contains(t.as_str()) || normalized_content.contains(t.as_str())
            });
            if !combined {
                return None;
            }
            let name_matches = name_terms == terms.len();
            let content_matches = content_terms == terms.len();
            let name_score = if normalized_name == normalized_query {
                0
            } else if normalized_name.starts_with(&normalized_query) {
                1
            } else {
                2
            };
            let kind = if (name_matches && content_matches) || (name_terms > 0 && content_terms > 0)
            {
                MatchKind::NameAndContent
            } else if name_matches {
                MatchKind::Name
            } else {
                MatchKind::Content
            };
            let score = if name_matches {
                name_score
            } else if name_terms > 0 {
                2
            } else {
                3
            };
            Some((
                score,
                SearchResult {
                    document_id: document.id.to_string(),
                    name: name.to_string(),
                    excerpt: if content_terms > 0 {
                        excerpt_from_text(
                            document.searchable_text,
                            &normalized_query,
                            EXCERPT_CHARS,
                        )
                    } else {
                        String::new()
                    },
                    kind,
                    updated_at: document.updated_at,
                },
            ))
        })
        .collect();
    scored.sort_by(|(left_score, left), (right_score, right)| {
        left_score
            .cmp(right_score)
            .then(right.updated_at.cmp(&left.updated_at))
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.document_id.cmp(&right.document_id))
    });
    scored.into_iter().map(|(_, result)| result).collect()
}

/// Filter a picker list by every query term, keeping the original order.
pub fn filter_by_terms<T>(items: &[T], query: &str, text: impl Fn(&T) -> String) -> Vec<usize> {
    let terms = search_terms(query);
    items
        .iter()
        .enumerate()
        .filter(|(_, item)| {
            let haystack = normalize(&text(item));
            terms.iter().all(|term| haystack.contains(term.as_str()))
        })
        .map(|(index, _)| index)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization_folds_case_accents_and_whitespace() {
        assert_eq!(normalize("  Crème\tBRÛLÉE \n "), "creme brulee");
        assert_eq!(normalize("ﬁle"), "file");
    }

    #[test]
    fn mapping_points_back_to_original_bytes() {
        let value = "Café au lait";
        let ranges = match_ranges(value, "cafe");
        assert_eq!(ranges, vec![0..5]);
        assert_eq!(&value[ranges[0].clone()], "Café");
    }

    #[test]
    fn match_ranges_merge_overlaps() {
        assert_eq!(match_ranges("abcabc", "abc bc"), vec![0..6]);
        assert_eq!(match_ranges("ab xab", "ab"), vec![0..2, 4..6]);
    }

    #[test]
    fn searchable_markdown_strips_syntax() {
        let markdown = "# Title\n\n- [Link](https://x) and ![alt](img.png)\n\n```js\nconst x\n```";
        assert_eq!(searchable_markdown(markdown), "Title Link and alt const x");
        assert_eq!(searchable_markdown("1. one\n2. two \\*"), "one two *");
    }

    #[test]
    fn search_ranks_names_before_content() {
        let docs = [
            SearchDocument {
                id: "a",
                name: "Groceries",
                searchable_text: "apples",
                updated_at: 5,
            },
            SearchDocument {
                id: "b",
                name: "Notes",
                searchable_text: "groceries list",
                updated_at: 9,
            },
            SearchDocument {
                id: "c",
                name: "Other",
                searchable_text: "nothing",
                updated_at: 1,
            },
        ];
        let results = search_documents(&docs, "groceries");
        assert_eq!(
            results
                .iter()
                .map(|r| r.document_id.as_str())
                .collect::<Vec<_>>(),
            ["a", "b"]
        );
        assert_eq!(results[0].kind, MatchKind::Name);
        assert_eq!(results[1].kind, MatchKind::Content);
        assert_eq!(results[1].excerpt, "groceries list");
    }

    #[test]
    fn search_requires_every_term() {
        let docs = [SearchDocument {
            id: "a",
            name: "Trip",
            searchable_text: "Paris museum",
            updated_at: 0,
        }];
        assert_eq!(search_documents(&docs, "trip paris").len(), 1);
        assert_eq!(search_documents(&docs, "trip rome").len(), 0);
        assert!(search_documents(&docs, "   ").is_empty());
    }

    #[test]
    fn excerpt_centers_on_match() {
        let text = format!("{} needle {}", "a ".repeat(200), "b ".repeat(200));
        let excerpt = excerpt_from_text(&text, "needle", 60);
        assert!(excerpt.starts_with('…') && excerpt.ends_with('…'));
        assert!(excerpt.contains("needle"));
    }
}
