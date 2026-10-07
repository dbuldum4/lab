//! Markdown source transforms behind the slash commands.
//!
//! The web editor applies commands to a rich document; the native editor keeps
//! Markdown as the source of truth, so each command is a small, testable text
//! edit. Offsets are byte offsets; every edit returns the caret/selection in
//! the coordinates of the edited document.

use std::ops::Range;

use crate::markdown_info::{closes_fence, parse_fence};
use crate::search::regex;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextEdit {
    pub range: Range<usize>,
    pub text: String,
    pub selection: Range<usize>,
}

impl TextEdit {
    #[cfg(test)]
    pub fn apply(&self, source: &str) -> String {
        let mut out = String::with_capacity(source.len() + self.text.len());
        out.push_str(&source[..self.range.start]);
        out.push_str(&self.text);
        out.push_str(&source[self.range.end..]);
        out
    }
}

pub fn line_start(text: &str, offset: usize) -> usize {
    text[..offset].rfind('\n').map_or(0, |index| index + 1)
}

pub fn line_end(text: &str, offset: usize) -> usize {
    text[offset..]
        .find('\n')
        .map_or(text.len(), |index| offset + index)
}

pub fn line_range(text: &str, offset: usize) -> Range<usize> {
    line_start(text, offset)..line_end(text, offset)
}

/// Whole lines touched by a selection (a selection ending at a line start
/// does not include that line).
fn covered_lines(text: &str, selection: &Range<usize>) -> Range<usize> {
    let end = if selection.end > selection.start && text[..selection.end].ends_with('\n') {
        selection.end - 1
    } else {
        selection.end
    };
    line_start(text, selection.start)..line_end(text, end.max(selection.start))
}

/// Byte ranges of every line in `text`, without the newline.
pub fn line_ranges(text: &str) -> Vec<Range<usize>> {
    let mut ranges = Vec::new();
    let mut start = 0;
    for line in text.split('\n') {
        ranges.push(start..start + line.len());
        start += line.len() + 1;
    }
    ranges
}

// ---------------------------------------------------------------------------
// Block prefixes

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlockKind {
    Paragraph,
    Heading(u8),
    Bullet,
    Number,
    Todo,
    Quote,
}

/// Split a line into (indent, existing block kind, prefix length after indent).
pub fn block_prefix(line: &str) -> (usize, BlockKind, usize) {
    let indent = line.len() - line.trim_start_matches([' ', '\t']).len();
    let rest = &line[indent..];
    if let Some(m) = regex!(r"^(#{1,6})(?:[ \t]+|$)").captures(rest) {
        return (indent, BlockKind::Heading(m[1].len() as u8), m[0].len());
    }
    if let Some(m) = regex!(r"^[-*+][ \t]+\[[ xX]\](?:[ \t]+|$)").find(rest) {
        return (indent, BlockKind::Todo, m.end());
    }
    if let Some(m) = regex!(r"^[-*+](?:[ \t]+|$)").find(rest)
        && !regex!(r"^(?:\*[ \t]*){3,}$|^(?:-[ \t]*){3,}$").is_match(rest)
    {
        return (indent, BlockKind::Bullet, m.end());
    }
    if let Some(m) = regex!(r"^\d{1,9}[.)](?:[ \t]+|$)").find(rest) {
        return (indent, BlockKind::Number, m.end());
    }
    if let Some(m) = regex!(r"^>[ \t]?").find(rest) {
        return (indent, BlockKind::Quote, m.end());
    }
    (indent, BlockKind::Paragraph, 0)
}

fn prefix_for(kind: BlockKind, number: usize) -> String {
    match kind {
        BlockKind::Paragraph => String::new(),
        BlockKind::Heading(level) => format!("{} ", "#".repeat(level as usize)),
        BlockKind::Bullet => "- ".into(),
        BlockKind::Number => format!("{number}. "),
        BlockKind::Todo => "- [ ] ".into(),
        BlockKind::Quote => "> ".into(),
    }
}

/// Turn the selected lines into `kind`. Applying a kind that every line already
/// has turns them back into paragraphs, like the web editor's toggles.
pub fn set_block(text: &str, selection: Range<usize>, kind: BlockKind) -> TextEdit {
    let lines = covered_lines(text, &selection);
    let source = &text[lines.clone()];
    let parsed: Vec<_> = source.split('\n').map(block_prefix).collect();
    let all_same = parsed.iter().all(|(_, existing, _)| *existing == kind);
    let target = if all_same && kind != BlockKind::Paragraph {
        BlockKind::Paragraph
    } else {
        kind
    };
    // Headings and quotes do not nest, so they drop indentation.
    let keep_indent = !matches!(target, BlockKind::Heading(_) | BlockKind::Quote);
    let multi_line = source.contains('\n');

    let mut rewritten: Vec<String> = Vec::new();
    let mut number = 0;
    for (line, (indent, _, prefix_len)) in source.split('\n').zip(parsed) {
        // Blank lines inside a multi-line selection stay blank.
        let prefix = if multi_line && line.trim().is_empty() {
            String::new()
        } else {
            number += 1;
            prefix_for(target, number)
        };
        let indent_text = if keep_indent { &line[..indent] } else { "" };
        rewritten.push(format!(
            "{indent_text}{prefix}{}",
            &line[indent + prefix_len..]
        ));
    }
    let out = rewritten.join("\n");
    let selection = remap_selection(text, &lines, &out, &selection);
    TextEdit {
        range: lines,
        text: out,
        selection,
    }
}

/// Map each selection end through a line-by-line rewrite of `lines`.
fn remap_selection(
    text: &str,
    lines: &Range<usize>,
    rewritten: &str,
    selection: &Range<usize>,
) -> Range<usize> {
    let old_lines: Vec<&str> = text[lines.clone()].split('\n').collect();
    let new_lines: Vec<&str> = rewritten.split('\n').collect();
    let map = |offset: usize| -> usize {
        if offset < lines.start {
            return offset;
        }
        if offset > lines.end {
            return offset + rewritten.len() - (lines.end - lines.start);
        }
        let mut old_start = lines.start;
        let mut new_start = lines.start;
        for (old, new) in old_lines.iter().zip(&new_lines) {
            let old_end = old_start + old.len();
            if offset <= old_end {
                let (old_indent, _, old_prefix) = block_prefix(old);
                let (new_indent, _, new_prefix) = block_prefix(new);
                let old_body = old_start + old_indent + old_prefix;
                let new_body = new_start + new_indent + new_prefix;
                return if offset <= old_body {
                    new_body
                } else {
                    (new_body + (offset - old_body)).min(new_start + new.len())
                };
            }
            old_start = old_end + 1;
            new_start += new.len() + 1;
        }
        lines.start + rewritten.len()
    };
    map(selection.start)..map(selection.end)
}

// ---------------------------------------------------------------------------
// Block insertion

/// Insert `block` on its own lines at the caret. An empty current line is
/// replaced; otherwise the block goes after the current line. Blank lines keep
/// the block from merging with neighbouring paragraphs. `select` is relative
/// to the start of `block`.
pub fn insert_block(text: &str, caret: usize, block: &str, select: Range<usize>) -> TextEdit {
    let line = line_range(text, caret);
    let current_empty = text[line.clone()].trim().is_empty();
    let (range, before_line_end) = if current_empty {
        (line.clone(), line.start)
    } else {
        (line.end..line.end, line.end)
    };

    let previous_nonblank = {
        let before = &text[..before_line_end];
        let previous_line = if current_empty {
            before
                .strip_suffix('\n')
                .map(|b| &b[line_start(b, b.len())..])
        } else {
            Some(&text[line.clone()])
        };
        previous_line.is_some_and(|l| !l.trim().is_empty())
    };
    let next_nonblank = {
        let after = &text[line.end..];
        after
            .strip_prefix('\n')
            .map(|rest| rest.split('\n').next().unwrap_or(""))
            .is_some_and(|next| !next.trim().is_empty())
    };

    let mut out = String::new();
    if !current_empty {
        out.push('\n');
    }
    if previous_nonblank {
        out.push('\n');
    }
    let block_start = range.start + out.len();
    out.push_str(block);
    if next_nonblank {
        out.push('\n');
    }
    TextEdit {
        range,
        text: out,
        selection: block_start + select.start..block_start + select.end,
    }
}

pub fn insert_inline(text: &str, selection: Range<usize>, before: &str, after: &str) -> TextEdit {
    let inner = &text[selection.clone()];
    let caret = selection.start + before.len() + inner.len();
    TextEdit {
        range: selection.clone(),
        text: format!("{before}{inner}{after}"),
        selection: if inner.is_empty() {
            caret..caret
        } else {
            selection.start + before.len()..caret
        },
    }
}

pub fn divider(text: &str, caret: usize) -> TextEdit {
    let mut edit = insert_block(text, caret, "---\n", 4..4);
    // Ensure the caret lands on a fresh paragraph line after the rule.
    if !edit.text.ends_with('\n')
        || edit.range.end < text.len() && !text[edit.range.end..].starts_with('\n')
    {
        edit.text.push('\n');
    }
    edit
}

pub fn callout(text: &str, caret: usize, kind: &str) -> TextEdit {
    let block = format!("> [!{}]\n> ", kind.to_uppercase());
    let len = block.len();
    insert_block(text, caret, &block, len..len)
}

pub fn details(text: &str, caret: usize) -> TextEdit {
    let block = "<details open>\n<summary>Summary</summary>\n\n\n\n</details>";
    let summary = "<details open>\n<summary>".len();
    insert_block(text, caret, block, summary..summary + "Summary".len())
}

pub fn block_math(text: &str, caret: usize) -> TextEdit {
    insert_block(text, caret, "$$\n\n$$", 3..3)
}

pub fn table(text: &str, caret: usize) -> TextEdit {
    let block = "|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |";
    insert_block(text, caret, block, 2..2)
}

// ---------------------------------------------------------------------------
// Code fences

/// The fenced code block around `offset`: (opening line, closing line or
/// None when the fence runs to the end of the note).
pub fn code_block_at(text: &str, offset: usize) -> Option<(Range<usize>, Option<Range<usize>>)> {
    let target = line_start(text, offset);
    let mut open: Option<(crate::markdown_info::Fence, Range<usize>)> = None;
    for range in line_ranges(text) {
        let line = &text[range.clone()];
        match &open {
            Some((fence, opening)) => {
                if closes_fence(line, *fence) {
                    if target >= opening.start && target <= range.start {
                        return Some((opening.clone(), Some(range)));
                    }
                    open = None;
                }
            }
            None => {
                if range.start > target {
                    return None;
                }
                if let Some((fence, _)) = parse_fence(line) {
                    open = Some((fence, range));
                }
            }
        }
    }
    open.filter(|(_, opening)| target >= opening.start)
        .map(|(_, opening)| (opening, None))
}

pub fn toggle_code_block(text: &str, selection: Range<usize>) -> TextEdit {
    if let Some((opening, closing)) = code_block_at(text, selection.start) {
        let body_start = (opening.end + 1).min(text.len());
        let (body_end, end) = match &closing {
            Some(closing) => (closing.start.saturating_sub(1).max(body_start), closing.end),
            None => (text.len(), text.len()),
        };
        let body = &text[body_start..body_end];
        let caret = selection.start.clamp(body_start, body_end) - body_start + opening.start;
        return TextEdit {
            range: opening.start..end,
            text: body.to_string(),
            selection: caret..caret,
        };
    }
    let lines = covered_lines(text, &selection);
    let body = &text[lines.clone()];
    if body.trim().is_empty() {
        return insert_block(text, selection.start, "```\n\n```", 4..4);
    }
    let caret = selection.start - lines.start + 4;
    TextEdit {
        range: lines.clone(),
        text: format!("```\n{body}\n```"),
        selection: lines.start + caret..lines.start + caret,
    }
}

pub fn code_language(text: &str, offset: usize) -> Option<String> {
    let (opening, _) = code_block_at(text, offset)?;
    let line = &text[opening];
    let (_, suffix) = parse_fence(line)?;
    Some(suffix.split_whitespace().next().unwrap_or("").to_string())
}

pub fn set_code_language(text: &str, offset: usize, language: &str) -> Option<TextEdit> {
    let (opening, _) = code_block_at(text, offset)?;
    let line = &text[opening.clone()];
    let (fence, _) = parse_fence(line)?;
    let indent = line.len() - line.trim_start_matches(' ').len();
    let marker: String = std::iter::repeat_n(fence.marker, fence.length).collect();
    let new_line = format!("{}{}{}", &line[..indent], marker, language);
    let caret = offset as isize + new_line.len() as isize - line.len() as isize;
    let caret = if offset > opening.end {
        caret as usize
    } else {
        opening.start + new_line.len()
    };
    Some(TextEdit {
        range: opening,
        text: new_line,
        selection: caret..caret,
    })
}

// ---------------------------------------------------------------------------
// Links

pub struct LinkAt {
    pub range: Range<usize>,
    pub label: String,
    pub href: String,
}

/// The Markdown link `[label](href)` containing the caret, if any.
pub fn link_at(text: &str, offset: usize) -> Option<LinkAt> {
    let line = line_range(text, offset);
    let source = &text[line.clone()];
    regex!(r#"\[((?:\\.|[^\]\\])*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)"#)
        .captures_iter(source)
        .find(|captures| {
            let whole = captures.get(0).unwrap();
            let start = line.start + whole.start();
            let preceded_by_bang =
                whole.start() > 0 && source.as_bytes()[whole.start() - 1] == b'!';
            !preceded_by_bang && offset >= start && offset <= line.start + whole.end()
        })
        .map(|captures| {
            let whole = captures.get(0).unwrap();
            LinkAt {
                range: line.start + whole.start()..line.start + whole.end(),
                label: unescape_link_brackets(&captures[1]),
                href: captures[2].to_string(),
            }
        })
}

/// Decode `\[` and `\]` in link text. Other escapes, `\\` included, stay as
/// written, so `escape_link_source` gives back the original source.
fn unescape_link_brackets(source: &str) -> String {
    let mut out = String::with_capacity(source.len());
    let mut chars = source.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some(next @ ('[' | ']')) => out.push(next),
            Some(next) => {
                out.push('\\');
                out.push(next);
            }
            None => out.push('\\'),
        }
    }
    out
}

/// Escape Markdown source for use as link text. Brackets are escaped and
/// backslash escapes already in the source are kept as written.
pub fn escape_link_source(label: &str) -> String {
    let mut out = String::with_capacity(label.len());
    let mut chars = label.chars();
    while let Some(ch) = chars.next() {
        match ch {
            '\\' => match chars.next() {
                Some('\n') => out.push_str("\\ "),
                Some(next) => {
                    out.push('\\');
                    out.push(next);
                }
                // A lone trailing backslash would escape the closing `]`.
                None => out.push_str("\\\\"),
            },
            '[' | ']' => {
                out.push('\\');
                out.push(ch);
            }
            '\n' => out.push(' '),
            _ => out.push(ch),
        }
    }
    out
}

/// A link whose text is Markdown source, such as the link editor's label.
pub fn markdown_source_link(label: &str, href: &str) -> String {
    format!(
        "[{}]({})",
        escape_link_source(label),
        escape_link_href(href)
    )
}

/// Escape plain text, such as a file or session name, for use as link text.
pub fn escape_link_label(label: &str) -> String {
    label
        .replace('\\', "\\\\")
        .replace('[', "\\[")
        .replace(']', "\\]")
        .replace('\n', " ")
}

pub fn escape_link_href(href: &str) -> String {
    href.trim()
        .replace(' ', "%20")
        .replace('(', "%28")
        .replace(')', "%29")
}

pub fn markdown_link(label: &str, href: &str) -> String {
    format!("[{}]({})", escape_link_label(label), escape_link_href(href))
}

// ---------------------------------------------------------------------------
// Tables

pub struct TableAt {
    /// Byte range of the whole table (all rows).
    pub range: Range<usize>,
    /// Rows without the delimiter row.
    pub rows: Vec<Vec<String>>,
    pub alignments: Vec<String>,
    /// Caret position as (row index into `rows`, column).
    pub row: usize,
    pub column: usize,
}

pub fn split_cells(line: &str) -> Vec<String> {
    let trimmed = line.trim();
    let inner = trimmed.strip_prefix('|').unwrap_or(trimmed);
    let inner = if inner.ends_with('|') && unescaped_pipes(inner).last() == Some(&(inner.len() - 1))
    {
        &inner[..inner.len() - 1]
    } else {
        inner
    };
    let mut cells = Vec::new();
    let mut current = String::new();
    let mut escaped = false;
    for ch in inner.chars() {
        if ch == '|' && !escaped {
            cells.push(current.trim().to_string());
            current.clear();
        } else {
            current.push(ch);
        }
        escaped = ch == '\\' && !escaped;
    }
    cells.push(current.trim().to_string());
    cells
}

pub fn is_delimiter_row(line: &str) -> bool {
    regex!(r"^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$").is_match(line)
        && line.contains('-')
}

fn is_table_line(line: &str) -> bool {
    line.trim_start().starts_with('|')
}

pub fn table_at(text: &str, offset: usize) -> Option<TableAt> {
    if code_block_at(text, offset).is_some() {
        return None;
    }
    let ranges = line_ranges(text);
    let current = ranges
        .iter()
        .position(|range| offset >= range.start && offset <= range.end)?;
    if !is_table_line(&text[ranges[current].clone()]) {
        return None;
    }
    let mut first = current;
    while first > 0 && is_table_line(&text[ranges[first - 1].clone()]) {
        first -= 1;
    }
    let mut last = current;
    while last + 1 < ranges.len() && is_table_line(&text[ranges[last + 1].clone()]) {
        last += 1;
    }
    if last == first || !is_delimiter_row(&text[ranges[first + 1].clone()]) {
        return None;
    }
    let alignments: Vec<String> = split_cells(&text[ranges[first + 1].clone()])
        .into_iter()
        .map(|cell| match (cell.starts_with(':'), cell.ends_with(':')) {
            (true, true) => ":---:".into(),
            (true, false) => ":---".into(),
            (false, true) => "---:".into(),
            _ => "---".into(),
        })
        .collect();
    let mut rows = Vec::new();
    for (index, range) in ranges[first..=last].iter().enumerate() {
        if index == 1 {
            continue;
        }
        rows.push(split_cells(&text[range.clone()]));
    }
    let width = rows
        .iter()
        .map(Vec::len)
        .max()
        .unwrap_or(1)
        .max(alignments.len());
    for row in &mut rows {
        row.resize(width, String::new());
    }
    let mut alignments = alignments;
    alignments.resize(width, "---".into());

    let line_index = current - first;
    let row = line_index.saturating_sub(1);
    let line = &text[ranges[current].clone()];
    let column = cell_starts(line)
        .iter()
        .rposition(|start| *start <= offset - ranges[current].start)
        .unwrap_or(0)
        .min(width - 1);
    Some(TableAt {
        range: ranges[first].start..ranges[last].end,
        rows,
        alignments,
        row,
        column,
    })
}

fn render_table(rows: &[Vec<String>], alignments: &[String]) -> String {
    let render_row = |cells: &[String]| {
        let mut line = String::from("|");
        for cell in cells {
            line.push(' ');
            line.push_str(cell);
            line.push_str(" |");
        }
        line
    };
    let mut lines = vec![render_row(&rows[0]), render_row(alignments)];
    lines.extend(rows[1..].iter().map(|row| render_row(row)));
    lines.join("\n")
}

/// Offset of the start of a cell's content within a rendered table.
fn cell_offset(rendered: &str, row: usize, column: usize) -> usize {
    let line_index = if row == 0 { 0 } else { row + 1 };
    let mut offset = 0;
    for (index, line) in rendered.split('\n').enumerate() {
        if index == line_index {
            return offset + cell_starts(line).get(column).copied().unwrap_or(line.len());
        }
        offset += line.len() + 1;
    }
    offset
}

/// Pipes preceded by an even number of backslashes delimit cells.
fn unescaped_pipes(line: &str) -> Vec<usize> {
    let mut pipes = Vec::new();
    let mut escaped = false;
    for (index, byte) in line.bytes().enumerate() {
        if byte == b'|' && !escaped {
            pipes.push(index);
        }
        escaped = byte == b'\\' && !escaped;
    }
    pipes
}

/// Offsets (relative to the line) where each cell's content starts.
pub fn cell_starts(line: &str) -> Vec<usize> {
    let bytes = line.as_bytes();
    let pipes = unescaped_pipes(line);
    let leading = line.trim_start().starts_with('|');
    let trimmed = line.trim_end();
    let trailing = trimmed.ends_with('|')
        && pipes.len() > usize::from(leading)
        && pipes.last() == Some(&(trimmed.len() - 1));
    let mut starts: Vec<usize> = Vec::new();
    if !leading {
        starts.push(line.len() - line.trim_start().len());
    }
    let usable = if trailing {
        &pipes[..pipes.len() - 1]
    } else {
        &pipes[..]
    };
    for pipe in usable {
        let start = pipe + 1;
        starts.push(if bytes.get(start) == Some(&b' ') {
            start + 1
        } else {
            start
        });
    }
    starts
}

/// Where Tab (or Shift-Tab) moves inside a table: the next cell, or a new
/// row after the last cell. `None` outside tables.
pub fn table_tab(text: &str, offset: usize, forward: bool) -> Option<TextEdit> {
    let table = table_at(text, offset)?;
    let mut starts: Vec<usize> = Vec::new();
    let mut line_start = table.range.start;
    for (index, line) in text[table.range.clone()].split('\n').enumerate() {
        if index != 1 {
            starts.extend(
                cell_starts(line)
                    .into_iter()
                    .map(|start| line_start + start),
            );
        }
        line_start += line.len() + 1;
    }
    let current = starts
        .iter()
        .rposition(|start| *start <= offset)
        .unwrap_or(0);
    let caret_only = |target: usize| TextEdit {
        range: target..target,
        text: String::new(),
        selection: target..target,
    };
    if forward {
        if let Some(next) = starts.get(current + 1) {
            return Some(caret_only(*next));
        }
        let mut edit = table_op(text, offset, TableOp::RowAfter)?;
        let rendered_offset = edit.selection.start - edit.range.start;
        let row_start = edit.text[..rendered_offset]
            .rfind('\n')
            .map_or(0, |i| i + 1);
        let row = &edit.text[row_start
            ..edit.text[row_start..]
                .find('\n')
                .map_or(edit.text.len(), |i| row_start + i)];
        let first = edit.range.start + row_start + cell_starts(row).first().copied().unwrap_or(0);
        edit.selection = first..first;
        Some(edit)
    } else {
        let previous = current
            .checked_sub(1)
            .map_or(starts[0], |index| starts[index]);
        Some(caret_only(previous))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TableOp {
    RowBefore,
    RowAfter,
    DeleteRow,
    ColumnBefore,
    ColumnAfter,
    DeleteColumn,
    ToggleHeader,
    Delete,
}

pub fn table_op(text: &str, offset: usize, op: TableOp) -> Option<TextEdit> {
    let TableAt {
        range,
        mut rows,
        mut alignments,
        mut row,
        mut column,
    } = table_at(text, offset)?;
    let width = alignments.len();
    let delete_table = |range: Range<usize>| {
        // Remove one adjoining blank line so the gap does not double up.
        let end = if text[range.end..].starts_with("\n\n") {
            range.end + 1
        } else {
            range.end
        };
        let end = if end == range.end && text[range.end..].starts_with('\n') && range.start == 0 {
            range.end + 1
        } else {
            end
        };
        TextEdit {
            range: range.start..end,
            text: String::new(),
            selection: range.start..range.start,
        }
    };
    match op {
        TableOp::Delete => return Some(delete_table(range)),
        TableOp::RowBefore => {
            rows.insert(row, vec![String::new(); width]);
        }
        TableOp::RowAfter => {
            rows.insert(row + 1, vec![String::new(); width]);
            row += 1;
        }
        TableOp::DeleteRow => {
            if rows.len() <= 1 {
                return Some(delete_table(range));
            }
            rows.remove(row);
            row = row.min(rows.len() - 1);
        }
        TableOp::ColumnBefore | TableOp::ColumnAfter => {
            let at = if op == TableOp::ColumnBefore {
                column
            } else {
                column + 1
            };
            for cells in &mut rows {
                cells.insert(at, String::new());
            }
            alignments.insert(at, "---".into());
            column = at;
        }
        TableOp::DeleteColumn => {
            if width <= 1 {
                return Some(delete_table(range));
            }
            for cells in &mut rows {
                cells.remove(column);
            }
            alignments.remove(column);
            column = column.min(width - 2);
        }
        TableOp::ToggleHeader => {
            let header_empty = rows[0].iter().all(|cell| cell.is_empty());
            if header_empty && rows.len() > 1 {
                rows.remove(0);
                row = row.saturating_sub(1);
            } else {
                rows.insert(0, vec![String::new(); width]);
                row += 1;
            }
        }
    }
    let rendered = render_table(&rows, &alignments);
    let caret = range.start + cell_offset(&rendered, row, column);
    Some(TextEdit {
        range,
        text: rendered,
        selection: caret..caret,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(text: &str, edit: TextEdit) -> (String, String) {
        let out = edit.apply(text);
        let mut marked = out.clone();
        marked.insert(edit.selection.end, '|');
        if edit.selection.start != edit.selection.end {
            marked.insert(edit.selection.start, '|');
        }
        (out, marked)
    }

    #[test]
    fn headings_toggle_and_keep_caret_in_body() {
        let (out, marked) = run("hello", set_block("hello", 2..2, BlockKind::Heading(2)));
        assert_eq!(out, "## hello");
        assert_eq!(marked, "## he|llo");
        let (out, _) = run(
            "## hello",
            set_block("## hello", 5..5, BlockKind::Heading(2)),
        );
        assert_eq!(out, "hello");
        let (out, _) = run(
            "## hello",
            set_block("## hello", 5..5, BlockKind::Heading(1)),
        );
        assert_eq!(out, "# hello");
    }

    #[test]
    fn lists_apply_to_every_selected_line_and_number_in_order() {
        let text = "a\nb\nc";
        let (out, _) = run(text, set_block(text, 0..5, BlockKind::Number));
        assert_eq!(out, "1. a\n2. b\n3. c");
        let (out, _) = run(&out, set_block(&out, 0..out.len(), BlockKind::Todo));
        assert_eq!(out, "- [ ] a\n- [ ] b\n- [ ] c");
        let (out, _) = run(&out, set_block(&out, 0..out.len(), BlockKind::Todo));
        assert_eq!(out, "a\nb\nc");
    }

    #[test]
    fn empty_line_block_commands_put_caret_after_marker() {
        let (_, marked) = run("", set_block("", 0..0, BlockKind::Bullet));
        assert_eq!(marked, "- |");
        let (_, marked) = run("> quote", set_block("> quote", 7..7, BlockKind::Paragraph));
        assert_eq!(marked, "quote|");
    }

    #[test]
    fn block_insertion_adds_separating_blank_lines() {
        let text = "para\n\nnext";
        let (out, marked) = run(text, table(text, 5));
        assert_eq!(
            out,
            "para\n\n|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |\n\nnext"
        );
        assert!(marked.starts_with("para\n\n| |"));
        let (out, _) = run("para", divider("para", 2));
        assert_eq!(out, "para\n\n---\n");
    }

    #[test]
    fn code_blocks_wrap_and_unwrap() {
        let (out, marked) = run("let x", toggle_code_block("let x", 1..1));
        assert_eq!(out, "```\nlet x\n```");
        assert_eq!(marked, "```\nl|et x\n```");
        let (out, marked) = run(&out, toggle_code_block(&out, 6..6));
        assert_eq!(out, "let x");
        assert_eq!(marked, "le|t x");
        let (_, marked) = run("", toggle_code_block("", 0..0));
        assert_eq!(marked, "```\n|\n```");
    }

    #[test]
    fn code_language_updates_the_fence() {
        let text = "```\nx\n```";
        assert_eq!(code_language(text, 4).as_deref(), Some(""));
        let edit = set_code_language(text, 4, "rust").unwrap();
        let out = edit.apply(text);
        assert_eq!(out, "```rust\nx\n```");
        assert_eq!(code_language(&out, 9).as_deref(), Some("rust"));
        assert!(set_code_language("plain", 0, "rust").is_none());
    }

    #[test]
    fn links_are_found_around_the_caret() {
        let text = "see [the \\] docs](https://x.y) and ![img](a.png)";
        let link = link_at(text, 6).unwrap();
        assert_eq!(link.label, "the ] docs");
        assert_eq!(link.href, "https://x.y");
        assert!(link_at(text, 40).is_none());
        // Saving an unchanged label gives back the same Markdown.
        for source in [
            "[C:\\\\dir](https://x)",
            "[a \\*b\\*](https://x)",
            "[x \\[y\\] \\\\](https://x)",
        ] {
            let link = link_at(source, 1).unwrap();
            assert_eq!(markdown_source_link(&link.label, &link.href), source);
        }
        assert_eq!(escape_link_source("ends with \\"), "ends with \\\\");
        assert_eq!(
            markdown_link("a [b]", "https://x y"),
            "[a \\[b\\]](https://x%20y)"
        );
    }

    #[test]
    fn table_rows_and_columns() {
        let text = "| a | b |\n| --- | :-: |\n| 1 | 2 |";
        let caret = text.find('2').unwrap();
        let table = table_at(text, caret).unwrap();
        assert_eq!((table.row, table.column), (1, 1));

        let out = table_op(text, caret, TableOp::RowAfter)
            .unwrap()
            .apply(text);
        assert_eq!(out, "| a | b |\n| --- | :---: |\n| 1 | 2 |\n|  |  |");
        let out = table_op(text, caret, TableOp::ColumnBefore)
            .unwrap()
            .apply(text);
        assert_eq!(out, "| a |  | b |\n| --- | --- | :---: |\n| 1 |  | 2 |");
        let out = table_op(text, caret, TableOp::DeleteColumn)
            .unwrap()
            .apply(text);
        assert_eq!(out, "| a |\n| --- |\n| 1 |");
        let out = table_op(text, 2, TableOp::DeleteRow).unwrap().apply(text);
        assert_eq!(out, "| 1 | 2 |\n| --- | :---: |");
        let out = table_op(text, caret, TableOp::ToggleHeader)
            .unwrap()
            .apply(text);
        assert_eq!(out, "|  |  |\n| --- | :---: |\n| a | b |\n| 1 | 2 |");
        let back = table_op(&out, 2, TableOp::ToggleHeader)
            .unwrap()
            .apply(&out);
        assert_eq!(back, "| a | b |\n| --- | :---: |\n| 1 | 2 |");
        assert_eq!(
            table_op(text, caret, TableOp::Delete).unwrap().apply(text),
            ""
        );
        assert!(table_at("| not a table", 3).is_none());
    }

    #[test]
    fn tab_moves_between_cells_and_adds_rows() {
        let text = "| a | b |\n| --- | --- |\n| 1 | 2 |";
        assert_eq!(cell_starts("| a | b |"), vec![2, 6]);
        assert_eq!(cell_starts("a | b"), vec![0, 4]);
        let next = table_tab(text, 2, true).unwrap();
        assert_eq!(next.selection.start, 6);
        let down = table_tab(text, 6, true).unwrap();
        assert_eq!(&text[down.selection.start..down.selection.start + 1], "1");
        let back = table_tab(text, down.selection.start, false).unwrap();
        assert_eq!(back.selection.start, 6);
        let last = text.find('2').unwrap();
        let added = table_tab(text, last, true).unwrap();
        let out = added.apply(text);
        assert_eq!(out, "| a | b |\n| --- | --- |\n| 1 | 2 |\n|  |  |");
        assert_eq!(added.selection.start, out.rfind('\n').unwrap() + 3);
        assert!(table_tab("plain", 1, true).is_none());
    }

    #[test]
    fn inline_wrappers_keep_selection() {
        let (out, marked) = run("x", insert_inline("x", 1..1, "$$", "$$"));
        assert_eq!(out, "x$$$$");
        assert_eq!(marked, "x$$|$$");
        let (_, marked) = run("ab", insert_inline("ab", 0..2, "[", "](https://"));
        assert_eq!(marked, "[|ab|](https://");
    }

    #[test]
    fn table_commands_keep_carets_on_cells_after_escaped_pipes() {
        let text = "| a\\|é | b |\n| --- | --- |\n| c\\|é | d |";
        let edit = table_op(text, 2, TableOp::ColumnAfter).unwrap();
        let out = edit.apply(text);
        assert_eq!(
            out,
            "| a\\|é |  | b |\n| --- | --- | --- |\n| c\\|é |  | d |"
        );
        assert!(out.is_char_boundary(edit.selection.start));
        assert_eq!(&out[edit.selection.start..edit.selection.start + 3], " | ");
        let (_, marked) = run(
            text,
            table_op(text, text.find('b').unwrap(), TableOp::ToggleHeader).unwrap(),
        );
        assert!(marked.contains("| a\\|é | |b |"));
        assert_eq!(cell_starts(r"| a\|é | b |"), vec![2, 10]);
        assert_eq!(cell_starts(r"| a\\| b |"), vec![2, 7]);
        assert_eq!(split_cells(r"| a\\| b |"), vec![r"a\\", "b"]);
        assert_eq!(split_cells(r"| a\|"), vec![r"a\|"]);
    }
}
