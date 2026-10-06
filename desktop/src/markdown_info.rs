//! Read-only facts about a Markdown note: statistics, outline, automatic
//! title, export filename, and local session links.
//!
//! Each function mirrors a module in `lib/` so both apps agree on results.

use std::ops::Range;
use std::sync::LazyLock;

use regex::Regex;
use unicode_normalization::UnicodeNormalization;

use crate::search::regex;

// ---------------------------------------------------------------------------
// Fences

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Fence {
    pub marker: char,
    pub length: usize,
}

/// Parse a CommonMark fence opener/closer (up to three leading spaces).
pub fn parse_fence(line: &str) -> Option<(Fence, &str)> {
    let indent = line.len() - line.trim_start_matches(' ').len();
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    let marker = rest.chars().next().filter(|c| *c == '`' || *c == '~')?;
    let length = rest.len() - rest.trim_start_matches(marker).len();
    if length < 3 {
        return None;
    }
    let suffix = &rest[length..];
    if marker == '`' && suffix.contains('`') {
        return None;
    }
    Some((Fence { marker, length }, suffix))
}

pub fn closes_fence(line: &str, fence: Fence) -> bool {
    parse_fence(line).is_some_and(|(candidate, suffix)| {
        candidate.marker == fence.marker
            && candidate.length >= fence.length
            && suffix.chars().all(|c| c == ' ' || c == '\t')
    })
}

/// For every line, whether it belongs to a fenced code block (fences included).
pub fn fenced_lines(lines: &[&str]) -> Vec<bool> {
    let mut open: Option<Fence> = None;
    lines
        .iter()
        .map(|line| match open {
            Some(fence) => {
                if closes_fence(line, fence) {
                    open = None;
                }
                true
            }
            None => {
                if let Some((fence, _)) = parse_fence(line) {
                    open = Some(fence);
                    true
                } else {
                    false
                }
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Statistics

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DocumentStats {
    pub words: usize,
    pub characters: usize,
    pub characters_no_spaces: usize,
    pub paragraphs: usize,
    pub headings: usize,
    pub code_blocks: usize,
    pub reading_minutes: usize,
}

const WORDS_PER_MINUTE: usize = 225;

/// Strip Markdown syntax while retaining the words a reader would consume.
pub fn readable_markdown(markdown: &str) -> String {
    let text = regex!(r"```[^\n]*\n?((?s:.*?))```").replace_all(markdown, "$1");
    let text = regex!(r"~~~[^\n]*\n?((?s:.*?))~~~").replace_all(&text, "$1");
    let text =
        regex!(r"(?i)<details[^>]*>|</details>|<summary[^>]*>|</summary>").replace_all(&text, " ");
    let text = regex!(r"<!--(?s:.*?)-->").replace_all(&text, " ");
    let text = regex!(r"!\[([^\]]*)\]\([^)]*\)").replace_all(&text, "$1");
    let text = regex!(r"\[([^\]]+)\]\([^)]*\)").replace_all(&text, "$1");
    let text = regex!(r"(?m)^\s{0,3}>\s?(?:\[![A-Z]+\]\s*)?").replace_all(&text, "");
    let text = regex!(r"(?m)^\s{0,3}#{1,6}\s+").replace_all(&text, "");
    let text = regex!(r"(?m)^\s*(?:[-*+] |\d+[.)] )").replace_all(&text, "");
    let text = regex!(r"\[(?: |x|X)\]\s*").replace_all(&text, "");
    let text = regex!(r"\$\$((?s:.*?))\$\$").replace_all(&text, "$1");
    let text = regex!(r"[`*_~]").replace_all(&text, "");
    let text = regex!(r"\\([\\`*_{}\[\]()#+.!-])").replace_all(&text, "$1");
    text.trim().to_string()
}

pub fn document_stats(markdown: &str) -> DocumentStats {
    let readable = readable_markdown(markdown);
    let words = regex!(r"[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*")
        .find_iter(&readable)
        .count();
    let paragraphs = regex!(r"\n\s*\n")
        .split(markdown)
        .filter(|block| !block.trim().is_empty() && !regex!(r"^\s*(?:```|~~~)").is_match(block))
        .count();
    let headings = regex!(r"(?m)^\s{0,3}#{1,6}\s+\S")
        .find_iter(markdown)
        .count();
    let fences = regex!(r"(?m)^\s*(?:```|~~~)").find_iter(markdown).count();
    DocumentStats {
        words,
        characters: readable.chars().count(),
        characters_no_spaces: readable.chars().filter(|c| !c.is_whitespace()).count(),
        paragraphs,
        headings,
        code_blocks: fences / 2,
        reading_minutes: if words == 0 {
            0
        } else {
            words.div_ceil(WORDS_PER_MINUTE).max(1)
        },
    }
}

// ---------------------------------------------------------------------------
// Outline

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutlineItem {
    pub level: u8,
    pub depth: u8,
    pub title: String,
    /// Byte offset of the heading line start.
    pub position: usize,
}

fn normalize_outline_title(title: &str) -> String {
    let normalized = regex!(r"\s+").replace_all(title, " ").trim().to_string();
    if normalized.is_empty() {
        "Untitled section".into()
    } else {
        normalized
    }
}

/// Outline from `#`, `##`, and `###` headings outside code fences.
pub fn outline(markdown: &str) -> Vec<OutlineItem> {
    let lines: Vec<&str> = markdown.split('\n').collect();
    let fenced = fenced_lines(&lines);
    let mut offset = 0;
    let mut items = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        if !fenced[index]
            && let Some(captures) =
                regex!(r"^ {0,3}(#{1,3})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$").captures(line)
        {
            let level = captures[1].len() as u8;
            let title = captures.get(2).map_or("", |m| m.as_str());
            items.push(OutlineItem {
                level,
                depth: level - 1,
                title: normalize_outline_title(&strip_inline(title)),
                position: offset,
            });
        }
        offset += line.len() + 1;
    }
    items
}

/// Index of the heading that contains `position`, if any.
pub fn active_outline_index(items: &[OutlineItem], position: usize) -> Option<usize> {
    let count = items.partition_point(|item| item.position <= position);
    count.checked_sub(1)
}

// ---------------------------------------------------------------------------
// Automatic title

const MAX_TITLE_CHARS: usize = 80;

fn strip_details_wrappers(value: &str) -> String {
    let mut result = value.to_string();
    loop {
        let previous = result.clone();
        result = regex!(r"(?i)^\s*<details\b[^>]*>\s*")
            .replace(&result, "")
            .into_owned();
        result = regex!(r"(?i)^\s*<summary\b[^>]*>\s*")
            .replace(&result, "")
            .into_owned();
        result = regex!(r"(?i)\s*</summary>\s*$")
            .replace(&result, "")
            .into_owned();
        result = regex!(r"(?i)\s*</details>\s*$")
            .replace(&result, "")
            .into_owned();
        if result == previous {
            return result;
        }
    }
}

pub fn strip_inline(value: &str) -> String {
    let text = regex!(r"!\[([^\]]*)\]\([^)]*\)").replace_all(value, "$1");
    let text = regex!(r"\[([^\]]+)\]\([^)]*\)").replace_all(&text, "$1");
    let text = regex!(r"\$\$([^$]+)\$\$").replace_all(&text, "$1");
    let text = regex!(r"[*_`~]").replace_all(&text, "");
    regex!(r"\\([\\`*_{}\[\]()#+.!-])")
        .replace_all(&text, "$1")
        .into_owned()
}

fn clean_title(value: &str) -> String {
    let text = strip_inline(&strip_details_wrappers(value));
    let text = regex!(r"\s+").replace_all(&text, " ");
    text.trim()
        .chars()
        .take(MAX_TITLE_CHARS)
        .collect::<String>()
        .trim_end()
        .to_string()
}

fn first_outside_fences(lines: &[&str], read: impl Fn(&str) -> Option<String>) -> Option<String> {
    let fenced = fenced_lines(lines);
    lines
        .iter()
        .zip(fenced)
        .filter(|(_, fenced)| !fenced)
        .find_map(|(line, _)| read(line).filter(|title| !title.is_empty()))
}

/// Prefer the first heading, then the first readable prose line.
pub fn automatic_title(markdown: &str) -> String {
    let normalized = markdown.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();
    if let Some(title) = first_outside_fences(&lines, |line| {
        regex!(r"^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$")
            .captures(line)
            .map(|c| clean_title(&c[1]))
    }) {
        return title;
    }
    first_outside_fences(&lines, |line| {
        let prose = regex!(r"^\s{0,3}>\s?(?:\[![A-Z]+\]\s*)?").replace(line, "");
        let prose = regex!(r"^\s*(?:[-*+] |\d+[.)] )").replace(&prose, "");
        Some(clean_title(&prose))
    })
    .unwrap_or_else(|| "Untitled".into())
}

// ---------------------------------------------------------------------------
// Export filename

/// Build a portable `.md` filename from a session name.
pub fn markdown_export_filename(session_name: &str) -> String {
    const DEFAULT: &str = "untitled.md";
    let normalized: String = session_name.nfkc().collect::<String>().trim().to_string();
    let without_ext = regex!(r"(?i)(?:\s*\.md)+$")
        .replace(&normalized, "")
        .trim()
        .to_string();
    if without_ext.is_empty() || without_ext.eq_ignore_ascii_case("untitled") {
        return DEFAULT.into();
    }
    let lower = without_ext.to_lowercase();
    let no_controls = regex!(r"[\x00-\x1f\x7f]").replace_all(&lower, " ");
    let slug = regex!(r"[^\p{L}\p{N}\p{M}]+").replace_all(&no_controls, "-");
    let slug = regex!(r"-+").replace_all(&slug, "-");
    let slug = slug.trim_matches('-');
    let stem: String = slug.chars().take(80).collect();
    let stem = stem.trim_matches('-');
    if stem.is_empty() {
        return DEFAULT.into();
    }
    if regex!(r"(?i)^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$").is_match(stem) {
        format!("note-{stem}.md")
    } else {
        format!("{stem}.md")
    }
}

// ---------------------------------------------------------------------------
// Local session links and backlinks

pub const SESSION_HREF_PREFIX: &str = "#session=";

pub fn is_valid_document_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub fn local_session_href(document_id: &str) -> String {
    // Valid ids never need percent-encoding.
    format!("{SESSION_HREF_PREFIX}{document_id}")
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = value.get(index + 1..index + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

pub fn document_id_from_href(href: &str) -> Option<String> {
    let raw = href.strip_prefix(SESSION_HREF_PREFIX)?;
    let id = percent_decode(raw)?;
    is_valid_document_id(&id).then_some(id)
}

fn is_escaped(bytes: &[u8], index: usize) -> bool {
    let mut count = 0;
    let mut cursor = index;
    while cursor > 0 && bytes[cursor - 1] == b'\\' {
        count += 1;
        cursor -= 1;
    }
    count % 2 == 1
}

/// Whether a backtick run of `len` opening before `from` has a matching
/// closer. Code spans never cross a blank line, so the search stops there.
fn has_inline_close(bytes: &[u8], from: usize, len: usize) -> bool {
    let mut cursor = from;
    while cursor < bytes.len() {
        match bytes[cursor] {
            b'\n' => {
                let next = &bytes[cursor + 1..];
                let line = next.split(|byte| *byte == b'\n').next().unwrap_or_default();
                if line.iter().all(u8::is_ascii_whitespace) {
                    return false;
                }
                cursor += 1;
            }
            b'`' if !is_escaped(bytes, cursor) => {
                let mut end = cursor + 1;
                while end < bytes.len() && bytes[end] == b'`' {
                    end += 1;
                }
                if end - cursor == len {
                    return true;
                }
                cursor = end;
            }
            _ => cursor += 1,
        }
    }
    false
}

/// Byte ranges of code: fenced block lines and inline spans, delimiters
/// included. Ranges are sorted and start and end on ASCII bytes.
pub fn code_ranges(markdown: &str) -> Vec<Range<usize>> {
    let bytes = markdown.as_bytes();
    let mut ranges = Vec::new();
    let mut fence: Option<Fence> = None;
    // Length and start of the open inline code span.
    let mut inline: Option<(usize, usize)> = None;
    let mut offset = 0;
    for line in markdown.split('\n') {
        let line_end = offset + line.len();
        let content = line.strip_suffix('\r').unwrap_or(line);
        if let Some(open) = fence {
            ranges.push(offset..line_end);
            if closes_fence(content, open) {
                fence = None;
            }
        } else if inline.is_none()
            && let Some((open, _)) = parse_fence(content)
        {
            ranges.push(offset..line_end);
            fence = Some(open);
        } else {
            let end = offset + content.len();
            let mut cursor = offset;
            while cursor < end {
                if bytes[cursor] != b'`' || is_escaped(bytes, cursor) {
                    cursor += 1;
                    continue;
                }
                let mut run_end = cursor + 1;
                while run_end < end && bytes[run_end] == b'`' {
                    run_end += 1;
                }
                let run = run_end - cursor;
                match inline {
                    None => {
                        if has_inline_close(bytes, run_end, run) {
                            inline = Some((run, cursor));
                        }
                    }
                    Some((open, start)) => {
                        if open == run {
                            ranges.push(start..run_end);
                            inline = None;
                        }
                    }
                }
                cursor = run_end;
            }
        }
        offset = line_end + 1;
    }
    ranges
}

/// Replace code (fenced and inline) with spaces, keeping byte offsets stable.
pub fn mask_code(markdown: &str) -> String {
    let mut masked = markdown.as_bytes().to_vec();
    for range in code_ranges(markdown) {
        for byte in &mut masked[range] {
            if *byte != b'\n' && *byte != b'\r' {
                *byte = b' ';
            }
        }
    }
    // Masking only replaces ASCII bytes or whole multi-byte sequences inside
    // code with spaces, but a code span can cut through nothing but complete
    // characters, so the result stays valid UTF-8; fall back defensively.
    String::from_utf8(masked)
        .unwrap_or_else(|err| String::from_utf8_lossy(err.as_bytes()).into_owned())
}

static MARKDOWN_LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"\[([^\]]+)\]\((#[^)\s]+)(?:\s+["'][^"']*["'])?\)"#).unwrap());

/// Local session links in the note as (target id, byte index of `[`).
pub fn local_links(markdown: &str) -> Vec<(String, usize)> {
    let masked = mask_code(markdown);
    let bytes = markdown.as_bytes();
    MARKDOWN_LINK
        .captures_iter(&masked)
        .filter_map(|captures| {
            let whole = captures.get(0)?;
            let index = whole.start();
            if is_escaped(bytes, index) {
                return None;
            }
            if index > 0 && bytes[index - 1] == b'!' && !is_escaped(bytes, index - 1) {
                return None;
            }
            document_id_from_href(&captures[2]).map(|id| (id, index))
        })
        .collect()
}

pub fn linked_document_ids(markdown: &str) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for (id, _) in local_links(markdown) {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids
}

pub fn backlink_excerpt(markdown: &str, target: &str) -> String {
    const FALLBACK: &str = "Links to this session";
    let Some((_, index)) = local_links(markdown)
        .into_iter()
        .find(|(id, _)| id == target)
    else {
        return FALLBACK.into();
    };
    let start = markdown[..index].rfind('\n').map_or(0, |i| i + 1);
    let end = markdown[index..]
        .find('\n')
        .map_or(markdown.len(), |i| index + i);
    let line = &markdown[start..end];
    let text = regex!(r"!\[([^\]]*)\]\([^)]*\)").replace_all(line, "$1");
    let text = regex!(r"\[([^\]]+)\]\([^)]*\)").replace_all(&text, "$1");
    let text = regex!(r"^\s{0,3}#{1,6}\s+").replace(&text, "");
    let text = regex!(r"^\s*>\s?").replace(&text, "");
    let text = regex!(r"[*_`~]").replace_all(&text, "");
    let excerpt: String = text.trim().chars().take(180).collect();
    if excerpt.is_empty() {
        FALLBACK.into()
    } else {
        excerpt
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stats_ignore_markdown_punctuation() {
        let stats = document_stats(
            "# Hello world\n\nIt's a **bold** [link](https://x).\n\n```\ncode here\n```\n",
        );
        assert_eq!(stats.words, 8);
        assert_eq!(stats.headings, 1);
        assert_eq!(stats.code_blocks, 1);
        assert_eq!(stats.paragraphs, 2);
        assert_eq!(stats.reading_minutes, 1);
        assert_eq!(document_stats("").reading_minutes, 0);
    }

    #[test]
    fn outline_skips_fenced_headings() {
        let items = outline("# One\ntext\n```\n# not\n```\n### Three ###\n#### Four");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].title, "One");
        assert_eq!(items[1].title, "Three");
        assert_eq!(items[1].depth, 2);
        assert_eq!(items[1].position, "# One\ntext\n```\n# not\n```\n".len());
        assert_eq!(active_outline_index(&items, 0), Some(0));
        assert_eq!(active_outline_index(&items, 1000), Some(1));
        assert_eq!(outline("#\n")[0].title, "Untitled section");
    }

    #[test]
    fn automatic_title_prefers_heading_then_prose() {
        assert_eq!(
            automatic_title("intro\n## **Plan** for [today](x)"),
            "Plan for today"
        );
        assert_eq!(
            automatic_title("```\n# code\n```\n> [!NOTE] Remember milk"),
            "Remember milk"
        );
        assert_eq!(automatic_title("- item one"), "item one");
        assert_eq!(automatic_title("\n\n"), "Untitled");
        assert_eq!(automatic_title(&"x".repeat(200)).len(), 80);
    }

    #[test]
    fn export_filenames_are_portable() {
        assert_eq!(markdown_export_filename("Untitled"), "untitled.md");
        assert_eq!(markdown_export_filename("  "), "untitled.md");
        assert_eq!(
            markdown_export_filename("My Plan: v2/3.md"),
            "my-plan-v2-3.md"
        );
        assert_eq!(markdown_export_filename("CON"), "note-con.md");
        assert_eq!(markdown_export_filename("Café ☕ notes"), "café-notes.md");
        assert_eq!(markdown_export_filename("???"), "untitled.md");
    }

    #[test]
    fn links_skip_code_images_and_escapes() {
        let md = "[a](#session=one) `[b](#session=two)` ![c](#session=three) \\[d](#session=four)\n```\n[e](#session=five)\n```\n[f](#session=one) [g](#session=bad!)";
        assert_eq!(linked_document_ids(md), vec!["one".to_string()]);
        assert_eq!(
            backlink_excerpt("# See [Plan](#session=p) now", "p"),
            "See Plan now"
        );
        assert_eq!(backlink_excerpt("nothing", "p"), "Links to this session");
    }

    #[test]
    fn document_ids_decode_and_validate() {
        assert_eq!(
            document_id_from_href("#session=abc-1").as_deref(),
            Some("abc-1")
        );
        assert_eq!(
            document_id_from_href("#session=a%2Db").as_deref(),
            Some("a-b")
        );
        assert_eq!(document_id_from_href("#session=a b"), None);
        assert_eq!(document_id_from_href("https://x"), None);
    }
}
