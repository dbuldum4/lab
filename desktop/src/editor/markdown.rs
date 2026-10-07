//! Classify Markdown source lines and inline spans for display.
//!
//! The editor keeps Markdown as the text being edited. These helpers decide
//! how each line looks: heading sizes, quiet syntax markers, code and quote
//! containers, and inline emphasis. They never change the text.

use std::ops::Range;

use crate::markdown_info::{closes_fence, parse_fence};
use crate::search::regex;
use crate::text_ops::{BlockKind, block_prefix, is_delimiter_row, line_ranges};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CalloutKind {
    Note,
    Tip,
    Warning,
    Important,
}

/// Containers drawn around runs of related lines.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Group {
    None,
    Code,
    Math,
    Quote,
    Callout(CalloutKind),
    Table,
    Details,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LineKind {
    Blank,
    Paragraph,
    /// Level and the byte length of the `## ` marker.
    Heading(u8, usize),
    /// Marker length (`- `, `1. `, `- [ ] `), indent, and the task state.
    ListItem {
        marker: Range<usize>,
        task: Option<bool>,
    },
    /// Length of the `> ` marker (and `[!NOTE]` header).
    Quote {
        marker: usize,
        header: bool,
    },
    FenceOpen,
    FenceClose,
    Code,
    MathFence,
    Math,
    TableRow,
    TableDelimiter,
    Rule,
    Image(ImageLine),
    DetailsTag,
    DetailsSummary,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImageLine {
    pub alt: String,
    pub src: String,
    pub width: Option<u32>,
    pub centered: bool,
}

#[derive(Clone, Debug)]
pub struct LineInfo {
    pub range: Range<usize>,
    pub kind: LineKind,
    pub group: Group,
}

fn callout_kind(line: &str) -> Option<CalloutKind> {
    let captures =
        regex!(r"(?i)^\s{0,3}>[ \t]*\[!(NOTE|TIP|WARNING|IMPORTANT)\][ \t]*$").captures(line)?;
    Some(match captures[1].to_uppercase().as_str() {
        "TIP" => CalloutKind::Tip,
        "WARNING" => CalloutKind::Warning,
        "IMPORTANT" => CalloutKind::Important,
        _ => CalloutKind::Note,
    })
}

pub fn parse_image_line(line: &str) -> Option<ImageLine> {
    let captures =
        regex!(r#"^\s*!\[((?:\\.|[^\]\\])*)\]\(\s*([^\s)]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\)\s*$"#)
            .captures(line)?;
    let title = captures.get(3).map_or("", |m| m.as_str());
    let width = regex!(r"^lab-size:(\d+)?x")
        .captures(title)
        .and_then(|c| c.get(1)?.as_str().parse().ok());
    Some(ImageLine {
        alt: captures[1].to_string(),
        src: captures[2].to_string(),
        width,
        centered: title.split(';').any(|part| part == "align=center"),
    })
}

/// Classify every line in the document.
pub fn classify(text: &str) -> Vec<LineInfo> {
    let ranges = line_ranges(text);
    let mut infos: Vec<LineInfo> = Vec::with_capacity(ranges.len());
    let mut fence = None;
    let mut math = false;
    let mut details_depth = 0usize;
    let mut quote_group: Option<Group> = None;
    // Lines that start with `|`, with the group they get if their run turns
    // out not to be a table.
    let mut table_lines: Vec<(usize, Group)> = Vec::new();

    for range in &ranges {
        let line = &text[range.clone()];
        let blank = line.trim().is_empty();

        if let Some(open) = fence {
            let kind = if closes_fence(line, open) {
                fence = None;
                LineKind::FenceClose
            } else {
                LineKind::Code
            };
            infos.push(LineInfo {
                range: range.clone(),
                kind,
                group: Group::Code,
            });
            continue;
        }
        if math {
            let kind = if line.trim() == "$$" {
                math = false;
                LineKind::MathFence
            } else {
                LineKind::Math
            };
            infos.push(LineInfo {
                range: range.clone(),
                kind,
                group: Group::Math,
            });
            continue;
        }
        if let Some((open, _)) = parse_fence(line) {
            fence = Some(open);
            infos.push(LineInfo {
                range: range.clone(),
                kind: LineKind::FenceOpen,
                group: Group::Code,
            });
            continue;
        }
        if line.trim() == "$$" {
            math = true;
            infos.push(LineInfo {
                range: range.clone(),
                kind: LineKind::MathFence,
                group: Group::Math,
            });
            continue;
        }

        // Details sections may contain other blocks; they only contribute
        // the frame, so inner lines keep their own kind.
        let trimmed = line.trim();
        if regex!(r"(?i)^<details(?:\s[^>]*)?>$").is_match(trimmed) {
            details_depth += 1;
            infos.push(LineInfo {
                range: range.clone(),
                kind: LineKind::DetailsTag,
                group: Group::Details,
            });
            continue;
        }
        if details_depth > 0 && regex!(r"(?i)^</details>$").is_match(trimmed) {
            details_depth -= 1;
            infos.push(LineInfo {
                range: range.clone(),
                kind: LineKind::DetailsTag,
                group: Group::Details,
            });
            continue;
        }
        if details_depth > 0 && regex!(r"(?i)^<summary>.*</summary>$").is_match(trimmed) {
            infos.push(LineInfo {
                range: range.clone(),
                kind: LineKind::DetailsSummary,
                group: Group::Details,
            });
            continue;
        }

        let (indent, block, prefix) = block_prefix(line);
        let mut group = if details_depth > 0 {
            Group::Details
        } else {
            Group::None
        };
        let kind = if blank {
            quote_group = None;
            LineKind::Blank
        } else if block == BlockKind::Quote {
            let header = callout_kind(line);
            if let Some(kind) = header {
                quote_group = Some(Group::Callout(kind));
            } else if quote_group.is_none() {
                quote_group = Some(Group::Quote);
            }
            group = quote_group.unwrap_or(Group::Quote);
            let marker = if header.is_some() {
                line.len()
            } else {
                indent + prefix
            };
            LineKind::Quote {
                marker,
                header: header.is_some(),
            }
        } else {
            quote_group = None;
            if regex!(r"^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$")
                .is_match(line)
            {
                LineKind::Rule
            } else if let BlockKind::Heading(level) = block {
                LineKind::Heading(level, indent + prefix)
            } else if matches!(
                block,
                BlockKind::Bullet | BlockKind::Number | BlockKind::Todo
            ) {
                let task = (block == BlockKind::Todo).then(|| {
                    line[indent..indent + prefix].contains("[x]")
                        || line[indent..indent + prefix].contains("[X]")
                });
                LineKind::ListItem {
                    marker: indent..indent + prefix,
                    task,
                }
            } else if trimmed.starts_with('|') {
                table_lines.push((infos.len(), group));
                group = Group::Table;
                LineKind::TableRow
            } else if let Some(image) = parse_image_line(line) {
                LineKind::Image(image)
            } else {
                LineKind::Paragraph
            }
        };
        infos.push(LineInfo {
            range: range.clone(),
            kind,
            group,
        });
    }
    mark_tables(text, &mut infos, &table_lines);
    infos
}

/// Like `text_ops::table_at`, a run of `|` lines is a table only when its
/// second line is a delimiter row. Other runs are plain paragraphs.
fn mark_tables(text: &str, infos: &mut [LineInfo], table_lines: &[(usize, Group)]) {
    let mut start = 0;
    while start < table_lines.len() {
        let mut end = start + 1;
        while end < table_lines.len() && table_lines[end].0 == table_lines[end - 1].0 + 1 {
            end += 1;
        }
        let run = &table_lines[start..end];
        let table = run.len() >= 2 && is_delimiter_row(&text[infos[run[1].0].range.clone()]);
        if table {
            infos[run[1].0].kind = LineKind::TableDelimiter;
        } else {
            for &(index, group) in run {
                infos[index].kind = LineKind::Paragraph;
                infos[index].group = group;
            }
        }
        start = end;
    }
}

// ---------------------------------------------------------------------------
// Inline spans

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct InlineStyle {
    pub bold: bool,
    pub italic: bool,
    pub code: bool,
    pub strike: bool,
    pub link: bool,
    /// Syntax characters such as `**`, `](url)`, and backticks.
    pub marker: bool,
    pub math: bool,
}

/// Inline styles for a line, as non-overlapping, sorted byte ranges. Ranges
/// not covered are plain text.
pub fn inline_spans(line: &str) -> Vec<(Range<usize>, InlineStyle)> {
    let bytes = line.as_bytes();
    let mut styles = vec![InlineStyle::default(); line.len()];
    let mut taken = vec![false; line.len()];
    let mark = |styles: &mut Vec<InlineStyle>,
                taken: &mut Vec<bool>,
                range: Range<usize>,
                apply: &dyn Fn(&mut InlineStyle)| {
        for index in range {
            apply(&mut styles[index]);
            taken[index] = true;
        }
    };

    // Code spans first: nothing inside them is Markdown.
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'`' && (index == 0 || bytes[index - 1] != b'\\') {
            let mut run = index;
            while run < bytes.len() && bytes[run] == b'`' {
                run += 1;
            }
            let len = run - index;
            let delimiter = &line[index..run];
            if let Some(close) = line[run..].find(delimiter).map(|offset| run + offset)
                && !line[close + len..].starts_with('`')
            {
                mark(&mut styles, &mut taken, index..run, &|s| s.marker = true);
                mark(&mut styles, &mut taken, run..close, &|s| s.code = true);
                mark(&mut styles, &mut taken, close..close + len, &|s| {
                    s.marker = true
                });
                index = close + len;
                continue;
            }
            index = run;
            continue;
        }
        index += 1;
    }

    let free = |taken: &Vec<bool>, range: &Range<usize>| range.clone().all(|i| !taken[i]);

    for captures in regex!(r"\$\$([^$]+)\$\$").captures_iter(line) {
        let whole = captures.get(0).unwrap();
        if free(&taken, &whole.range()) {
            let inner = captures.get(1).unwrap().range();
            mark(&mut styles, &mut taken, whole.start()..inner.start, &|s| {
                s.marker = true
            });
            mark(&mut styles, &mut taken, inner.clone(), &|s| s.math = true);
            mark(&mut styles, &mut taken, inner.end..whole.end(), &|s| {
                s.marker = true
            });
        }
    }

    for captures in
        regex!(r#"!?\[((?:\\.|[^\]\\])*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)"#).captures_iter(line)
    {
        let whole = captures.get(0).unwrap();
        if !free(&taken, &whole.range()) || (whole.start() > 0 && bytes[whole.start() - 1] == b'\\')
        {
            continue;
        }
        let label = captures.get(1).unwrap().range();
        let image = bytes[whole.start()] == b'!';
        mark(&mut styles, &mut taken, whole.start()..label.start, &|s| {
            s.marker = true
        });
        if !image {
            for i in label.clone() {
                styles[i].link = true;
            }
        }
        mark(&mut styles, &mut taken, label.end..whole.end(), &|s| {
            s.marker = true
        });
    }

    let bold: &dyn Fn(&mut InlineStyle) = &|s| s.bold = true;
    let strike: &dyn Fn(&mut InlineStyle) = &|s| s.strike = true;
    let italic: &dyn Fn(&mut InlineStyle) = &|s| s.italic = true;
    // `w` is the whole delimited span and `i` its content. Italic patterns
    // need a boundary before the opening delimiter so `snake_case` and
    // `2 * 3` stay plain.
    for (pattern, apply) in [
        (
            regex!(r"(?P<w>\*\*(?P<i>[^*\s](?:[^*]*[^*\s])?)\*\*)"),
            bold,
        ),
        (regex!(r"(?P<w>__(?P<i>[^_\s](?:[^_]*[^_\s])?)__)"), bold),
        (regex!(r"(?P<w>~~(?P<i>[^~\s](?:[^~]*[^~\s])?)~~)"), strike),
        (
            regex!(r"(?:^|[^*\w])(?P<w>\*(?P<i>[^*\s](?:[^*]*[^*\s])?)\*)(?:$|[^*\w])"),
            italic,
        ),
        (
            regex!(r"(?:^|[^_\w])(?P<w>_(?P<i>[^_\s](?:[^_]*[^_\s])?)_)(?:$|[^_\w])"),
            italic,
        ),
    ] {
        for captures in pattern.captures_iter(line) {
            let whole = captures.name("w").unwrap().range();
            let inner = captures.name("i").unwrap().range();
            let delimiters = [whole.start..inner.start, inner.end..whole.end];
            if delimiters.iter().any(|d| !free(&taken, d)) {
                continue;
            }
            for d in delimiters {
                mark(&mut styles, &mut taken, d, &|s| s.marker = true);
            }
            for i in inner {
                if !styles[i].marker && !styles[i].code {
                    apply(&mut styles[i]);
                }
            }
        }
    }

    // Collapse per-byte styles into ranges.
    let mut spans: Vec<(Range<usize>, InlineStyle)> = Vec::new();
    for (index, style) in styles.into_iter().enumerate() {
        if style == InlineStyle::default() {
            continue;
        }
        match spans.last_mut() {
            Some((range, last)) if range.end == index && *last == style => range.end = index + 1,
            _ => spans.push((index..index + 1, style)),
        }
    }
    // Spans must sit on character boundaries.
    spans.retain(|(range, _)| {
        line.is_char_boundary(range.start) && line.is_char_boundary(range.end)
    });
    spans
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(text: &str) -> Vec<(LineKind, Group)> {
        classify(text)
            .into_iter()
            .map(|info| (info.kind, info.group))
            .collect()
    }

    #[test]
    fn pipe_lines_without_a_delimiter_row_are_paragraphs() {
        let result =
            kinds("| just a thought\n\n| a | b |\n| x | y |\n\n| a |\n|---|\n| 1 |\n|---|");
        assert_eq!(result[0], (LineKind::Paragraph, Group::None));
        assert_eq!(result[2], (LineKind::Paragraph, Group::None));
        assert_eq!(result[3], (LineKind::Paragraph, Group::None));
        assert_eq!(result[5], (LineKind::TableRow, Group::Table));
        assert_eq!(result[6], (LineKind::TableDelimiter, Group::Table));
        assert_eq!(result[7], (LineKind::TableRow, Group::Table));
        // Only the second line is the delimiter, as in `text_ops::table_at`.
        assert_eq!(result[8], (LineKind::TableRow, Group::Table));
    }

    #[test]
    fn classifies_blocks_and_groups() {
        let text = "# Title\n\n- item\n- [x] done\n> quote\n> more\n\n> [!TIP]\n> tip\n```rs\n# not heading\n```\n| a |\n| - |\n---\n![alt](lab-asset://asset-1 \"lab-size:320x;align=center\")";
        let result = kinds(text);
        assert_eq!(result[0], (LineKind::Heading(1, 2), Group::None));
        assert_eq!(result[1].0, LineKind::Blank);
        assert_eq!(
            result[2].0,
            LineKind::ListItem {
                marker: 0..2,
                task: None
            }
        );
        assert_eq!(
            result[3].0,
            LineKind::ListItem {
                marker: 0..6,
                task: Some(true)
            }
        );
        assert_eq!(
            result[4],
            (
                LineKind::Quote {
                    marker: 2,
                    header: false
                },
                Group::Quote
            )
        );
        assert_eq!(result[5].1, Group::Quote);
        assert_eq!(
            result[7],
            (
                LineKind::Quote {
                    marker: 8,
                    header: true
                },
                Group::Callout(CalloutKind::Tip)
            )
        );
        assert_eq!(result[8].1, Group::Callout(CalloutKind::Tip));
        assert_eq!(result[9], (LineKind::FenceOpen, Group::Code));
        assert_eq!(result[10], (LineKind::Code, Group::Code));
        assert_eq!(result[11], (LineKind::FenceClose, Group::Code));
        assert_eq!(result[12], (LineKind::TableRow, Group::Table));
        assert_eq!(result[13], (LineKind::TableDelimiter, Group::Table));
        assert_eq!(result[14].0, LineKind::Rule);
        assert_eq!(
            result[15].0,
            LineKind::Image(ImageLine {
                alt: "alt".into(),
                src: "lab-asset://asset-1".into(),
                width: Some(320),
                centered: true
            })
        );
    }

    #[test]
    fn details_and_math_groups() {
        let text = "<details open>\n<summary>More</summary>\n\nbody\n</details>\n$$\nx^2\n$$";
        let result = kinds(text);
        assert_eq!(result[0], (LineKind::DetailsTag, Group::Details));
        assert_eq!(result[1], (LineKind::DetailsSummary, Group::Details));
        assert_eq!(result[3], (LineKind::Paragraph, Group::Details));
        assert_eq!(result[4], (LineKind::DetailsTag, Group::Details));
        assert_eq!(result[5], (LineKind::MathFence, Group::Math));
        assert_eq!(result[6], (LineKind::Math, Group::Math));
    }

    fn styled(line: &str) -> Vec<(&str, InlineStyle)> {
        inline_spans(line)
            .into_iter()
            .map(|(range, style)| (&line[range], style))
            .collect()
    }

    #[test]
    fn inline_emphasis_code_and_links() {
        let spans = styled("a **bold** and *it* `**x**` [l](u)");
        let bold = spans.iter().find(|(text, _)| *text == "bold").unwrap();
        assert!(bold.1.bold);
        assert!(
            spans
                .iter()
                .any(|(text, style)| *text == "it" && style.italic)
        );
        assert!(
            spans
                .iter()
                .any(|(text, style)| *text == "**x**" && style.code)
        );
        assert!(spans.iter().any(|(text, style)| *text == "l" && style.link));
        assert!(
            spans
                .iter()
                .any(|(text, style)| *text == "](u)" && style.marker)
        );
        assert!(styled("snake_case_name").is_empty());
        assert!(styled("2 * 3 * 4").is_empty());
    }

    #[test]
    fn spans_respect_multibyte_text() {
        let spans = styled("é **ü** ✓");
        assert!(spans.iter().any(|(text, style)| *text == "ü" && style.bold));
    }
}
