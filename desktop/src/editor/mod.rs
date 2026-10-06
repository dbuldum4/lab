//! A Markdown text editor built directly on GPUI.
//!
//! The same entity drives the document editor and the single-line fields in
//! the command palette. Text is a `String`; offsets are UTF-8 byte offsets and
//! always sit on character boundaries. The platform input handler speaks
//! UTF-16, so conversions happen at that boundary only.

pub mod element;
pub mod markdown;
pub mod view;

use std::cell::RefCell;
use std::collections::VecDeque;
use std::ops::Range;
use std::path::PathBuf;
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui::{
    App, Bounds, ClipboardEntry, ClipboardItem, Context, EntityInputHandler, EventEmitter,
    FocusHandle, Focusable, ImageFormat, KeyBinding, MouseButton, MouseDownEvent, MouseMoveEvent,
    MouseUpEvent, Pixels, Point, ScrollHandle, SharedString, Task, UTF16Selection, Window, actions,
    point, px,
};
use unicode_segmentation::UnicodeSegmentation;

use crate::text_ops::{self, BlockKind, TextEdit, block_prefix, line_end, line_range, line_start};
use crate::theme::Colors;
use element::LayoutTable;

actions!(
    editor,
    [
        MoveLeft,
        MoveRight,
        MoveUp,
        MoveDown,
        SelectLeft,
        SelectRight,
        SelectUp,
        SelectDown,
        MoveWordLeft,
        MoveWordRight,
        SelectWordLeft,
        SelectWordRight,
        MoveLineStart,
        MoveLineEnd,
        SelectLineStart,
        SelectLineEnd,
        MoveDocStart,
        MoveDocEnd,
        SelectDocStart,
        SelectDocEnd,
        PageUp,
        PageDown,
        Backspace,
        Delete,
        DeleteWordLeft,
        DeleteWordRight,
        DeleteToLineStart,
        Newline,
        NewlinePlain,
        Indent,
        Outdent,
        SelectAll,
        Copy,
        Cut,
        Paste,
        Undo,
        Redo,
        ToggleBold,
        ToggleItalic,
        ShowCharacterPalette,
    ]
);

pub fn bind_keys(cx: &mut App) {
    const DOC: Option<&str> = Some("Editor");
    let mut bindings = vec![
        KeyBinding::new("left", MoveLeft, DOC),
        KeyBinding::new("right", MoveRight, DOC),
        KeyBinding::new("shift-left", SelectLeft, DOC),
        KeyBinding::new("shift-right", SelectRight, DOC),
        KeyBinding::new("home", MoveLineStart, DOC),
        KeyBinding::new("end", MoveLineEnd, DOC),
        KeyBinding::new("shift-home", SelectLineStart, DOC),
        KeyBinding::new("shift-end", SelectLineEnd, DOC),
        KeyBinding::new("backspace", Backspace, DOC),
        KeyBinding::new("shift-backspace", Backspace, DOC),
        KeyBinding::new("delete", Delete, DOC),
        KeyBinding::new("secondary-a", SelectAll, DOC),
        KeyBinding::new("secondary-c", Copy, DOC),
        KeyBinding::new("secondary-x", Cut, DOC),
        KeyBinding::new("secondary-v", Paste, DOC),
        KeyBinding::new("secondary-z", Undo, DOC),
        KeyBinding::new("secondary-shift-z", Redo, DOC),
        KeyBinding::new("secondary-b", ToggleBold, DOC),
        KeyBinding::new("secondary-i", ToggleItalic, DOC),
        // Document-only movement; single-line fields send these to the palette.
        KeyBinding::new("up", MoveUp, Some("Editor && !single_line && !palette")),
        KeyBinding::new("down", MoveDown, Some("Editor && !single_line && !palette")),
        KeyBinding::new("shift-up", SelectUp, Some("Editor && !single_line")),
        KeyBinding::new("shift-down", SelectDown, Some("Editor && !single_line")),
        KeyBinding::new("pageup", PageUp, Some("Editor && !single_line")),
        KeyBinding::new("pagedown", PageDown, Some("Editor && !single_line")),
        KeyBinding::new("enter", Newline, Some("Editor && !palette_confirms")),
        KeyBinding::new("enter", Newline, Some("Editor && single_line")),
        KeyBinding::new("shift-enter", NewlinePlain, Some("Editor && !single_line")),
        KeyBinding::new(
            "tab",
            Indent,
            Some("Editor && !single_line && !palette_confirms"),
        ),
        KeyBinding::new(
            "shift-tab",
            Outdent,
            Some("Editor && !single_line && !palette_confirms"),
        ),
    ];
    if cfg!(target_os = "macos") {
        bindings.extend([
            KeyBinding::new("alt-left", MoveWordLeft, DOC),
            KeyBinding::new("alt-right", MoveWordRight, DOC),
            KeyBinding::new("alt-shift-left", SelectWordLeft, DOC),
            KeyBinding::new("alt-shift-right", SelectWordRight, DOC),
            KeyBinding::new("cmd-left", MoveLineStart, DOC),
            KeyBinding::new("cmd-right", MoveLineEnd, DOC),
            KeyBinding::new("cmd-shift-left", SelectLineStart, DOC),
            KeyBinding::new("cmd-shift-right", SelectLineEnd, DOC),
            KeyBinding::new("cmd-up", MoveDocStart, DOC),
            KeyBinding::new("cmd-down", MoveDocEnd, DOC),
            KeyBinding::new("cmd-shift-up", SelectDocStart, DOC),
            KeyBinding::new("cmd-shift-down", SelectDocEnd, DOC),
            KeyBinding::new("alt-backspace", DeleteWordLeft, DOC),
            KeyBinding::new("alt-delete", DeleteWordRight, DOC),
            KeyBinding::new("cmd-backspace", DeleteToLineStart, DOC),
            KeyBinding::new("ctrl-a", MoveLineStart, DOC),
            KeyBinding::new("ctrl-e", MoveLineEnd, DOC),
            KeyBinding::new("ctrl-cmd-space", ShowCharacterPalette, DOC),
        ]);
    } else {
        bindings.extend([
            KeyBinding::new("ctrl-left", MoveWordLeft, DOC),
            KeyBinding::new("ctrl-right", MoveWordRight, DOC),
            KeyBinding::new("ctrl-shift-left", SelectWordLeft, DOC),
            KeyBinding::new("ctrl-shift-right", SelectWordRight, DOC),
            KeyBinding::new("ctrl-home", MoveDocStart, DOC),
            KeyBinding::new("ctrl-end", MoveDocEnd, DOC),
            KeyBinding::new("ctrl-shift-home", SelectDocStart, DOC),
            KeyBinding::new("ctrl-shift-end", SelectDocEnd, DOC),
            KeyBinding::new("ctrl-backspace", DeleteWordLeft, DOC),
            KeyBinding::new("ctrl-delete", DeleteWordRight, DOC),
            KeyBinding::new("ctrl-y", Redo, DOC),
        ]);
    }
    cx.bind_keys(bindings);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EditorMode {
    Document,
    SingleLine,
}

#[derive(Clone, Debug)]
pub enum EditorEvent {
    /// The text changed through user input or an edit.
    Edited,
    /// The caret or selection moved without a text change.
    SelectionChanged,
    /// Enter in a single-line field.
    Submit,
    /// Cmd/Ctrl-click on a link.
    OpenLink(String),
    /// An image arrived from the clipboard.
    PasteImage(Vec<u8>, &'static str),
}

struct Snapshot {
    text: String,
    selection: Range<usize>,
}

/// How an entry in [`History`] stores its text.
enum Stored {
    /// The whole text. Only the newest entry holds this.
    Full(String),
    /// What differs from the text of the entry above: that text with
    /// `prefix..len - suffix` replaced by `middle`.
    Diff {
        prefix: usize,
        suffix: usize,
        middle: String,
    },
}

struct Entry {
    text: Stored,
    selection: Range<usize>,
}

/// An undo or redo stack. Only the newest entry keeps a full copy of the
/// text; older ones keep the difference from their neighbour, so memory
/// grows with the size of the edits rather than the size of the note.
#[derive(Default)]
struct History {
    entries: VecDeque<Entry>,
}

impl History {
    fn push(&mut self, text: &str, selection: Range<usize>) {
        if let Some(top) = self.entries.back_mut()
            && let Stored::Full(previous) = &top.text
        {
            top.text = diff(previous, text);
        }
        self.entries.push_back(Entry {
            text: Stored::Full(text.to_string()),
            selection,
        });
        if self.entries.len() > UNDO_LIMIT {
            self.entries.pop_front();
        }
    }

    fn pop(&mut self) -> Option<Snapshot> {
        let Entry { text, selection } = self.entries.pop_back()?;
        let Stored::Full(text) = text else {
            unreachable!("the newest history entry holds the full text");
        };
        if let Some(next) = self.entries.back_mut()
            && let Stored::Diff {
                prefix,
                suffix,
                middle,
            } = &next.text
        {
            let mut full = String::with_capacity(*prefix + middle.len() + *suffix);
            full.push_str(&text[..*prefix]);
            full.push_str(middle);
            full.push_str(&text[text.len() - *suffix..]);
            next.text = Stored::Full(full);
        }
        Some(Snapshot { text, selection })
    }

    fn last_text(&self) -> Option<&str> {
        match &self.entries.back()?.text {
            Stored::Full(text) => Some(text),
            Stored::Diff { .. } => None,
        }
    }

    fn clear(&mut self) {
        self.entries.clear();
    }
}

/// Store `old` as the change that turns `new` back into it.
fn diff(old: &str, new: &str) -> Stored {
    let (a, b) = (old.as_bytes(), new.as_bytes());
    let mut prefix = a.iter().zip(b).take_while(|(x, y)| x == y).count();
    while !old.is_char_boundary(prefix) || !new.is_char_boundary(prefix) {
        prefix -= 1;
    }
    let limit = a.len().min(b.len()) - prefix;
    let mut suffix = a
        .iter()
        .rev()
        .zip(b.iter().rev())
        .take(limit)
        .take_while(|(x, y)| x == y)
        .count();
    while !old.is_char_boundary(old.len() - suffix) || !new.is_char_boundary(new.len() - suffix) {
        suffix -= 1;
    }
    Stored::Diff {
        prefix,
        suffix,
        middle: old[prefix..old.len() - suffix].to_string(),
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum EditKind {
    Typing,
    Deleting,
    Other,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum DragUnit {
    Character,
    Word,
    Line,
}

const UNDO_LIMIT: usize = 300;
const UNDO_GROUP: Duration = Duration::from_millis(900);
const BLINK_INTERVAL: Duration = Duration::from_millis(540);

pub type AssetResolver = Rc<dyn Fn(&str) -> Option<PathBuf>>;

pub struct Editor {
    pub(crate) focus_handle: FocusHandle,
    mode: EditorMode,
    text: String,
    selection: Range<usize>,
    reversed: bool,
    marked: Option<Range<usize>>,
    undo_stack: History,
    redo_stack: History,
    last_edit: Option<(Instant, EditKind, usize)>,
    placeholder: SharedString,
    layout: Rc<RefCell<LayoutTable>>,
    scroll: ScrollHandle,
    goal_x: Option<Pixels>,
    drag: Option<(DragUnit, Range<usize>)>,
    autoscroll: Option<AutoscrollTarget>,
    blink_on: bool,
    blink_task: Option<Task<()>>,
    pub(crate) colors: Colors,
    /// True while the slash palette owns arrow keys.
    palette_open: bool,
    /// True while the palette also owns Enter and Tab, which it gives back to
    /// the document when no command matches the slash query.
    palette_confirms: bool,
    pub(crate) asset_resolver: Option<AssetResolver>,
    version: u64,
    classified: RefCell<Option<(u64, Rc<Vec<markdown::LineInfo>>)>>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum AutoscrollTarget {
    /// Keep the caret visible with a comfortable margin.
    Caret,
    /// Put the caret line near the top of the viewport.
    Top,
}

impl EventEmitter<EditorEvent> for Editor {}

impl Focusable for Editor {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Editor {
    pub fn new(
        mode: EditorMode,
        colors: Colors,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let focus_handle = cx.focus_handle();
        cx.on_focus(&focus_handle, window, |this: &mut Self, _window, cx| {
            this.restart_blink(cx)
        })
        .detach();
        cx.on_blur(&focus_handle, window, |this: &mut Self, _window, cx| {
            this.blink_task = None;
            this.drag = None;
            cx.notify();
        })
        .detach();
        Self {
            focus_handle,
            mode,
            text: String::new(),
            selection: 0..0,
            reversed: false,
            marked: None,
            undo_stack: History::default(),
            redo_stack: History::default(),
            last_edit: None,
            placeholder: SharedString::default(),
            layout: Rc::default(),
            scroll: ScrollHandle::new(),
            goal_x: None,
            drag: None,
            autoscroll: None,
            blink_on: true,
            blink_task: None,
            colors,
            palette_open: false,
            palette_confirms: false,
            asset_resolver: None,
            version: 0,
            classified: RefCell::new(None),
        }
    }

    // -- Public API ----------------------------------------------------------

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn selection(&self) -> Range<usize> {
        self.selection.clone()
    }

    pub fn cursor(&self) -> usize {
        if self.reversed {
            self.selection.start
        } else {
            self.selection.end
        }
    }

    pub fn set_placeholder(&mut self, placeholder: impl Into<SharedString>) {
        self.placeholder = placeholder.into();
    }

    pub fn set_colors(&mut self, colors: Colors, cx: &mut Context<Self>) {
        self.colors = colors;
        cx.notify();
    }

    pub fn set_palette_open(&mut self, open: bool, cx: &mut Context<Self>) {
        if self.palette_open != open || self.palette_confirms != open {
            self.palette_open = open;
            self.palette_confirms = open;
            cx.notify();
        }
    }

    pub fn set_palette_confirms(&mut self, confirms: bool, cx: &mut Context<Self>) {
        let confirms = confirms && self.palette_open;
        if self.palette_confirms != confirms {
            self.palette_confirms = confirms;
            cx.notify();
        }
    }

    /// Replace the whole text and put the caret at the top, clearing undo history.
    pub fn set_text(&mut self, text: impl Into<String>, cx: &mut Context<Self>) {
        self.text = normalize_newlines(&text.into());
        self.selection = 0..0;
        self.scroll.set_offset(point(px(0.), px(0.)));
        self.reversed = false;
        self.marked = None;
        self.undo_stack.clear();
        self.redo_stack.clear();
        self.last_edit = None;
        self.goal_x = None;
        self.bump_version();
        cx.notify();
    }

    /// Replace the text as one undoable step (history restore, import, clear).
    pub fn replace_all(&mut self, text: &str, cx: &mut Context<Self>) {
        let len = self.text.len();
        self.apply_edit(
            TextEdit {
                range: 0..len,
                text: normalize_newlines(text),
                selection: 0..0,
            },
            cx,
        );
    }

    pub fn select_all_text(&mut self, cx: &mut Context<Self>) {
        self.set_selection(0..self.text.len(), false, cx);
    }

    pub fn set_cursor(&mut self, offset: usize, cx: &mut Context<Self>) {
        let offset = self.clip(offset);
        self.set_selection(offset..offset, false, cx);
    }

    /// Move the caret to `offset` and scroll its line near the top.
    pub fn reveal_offset(&mut self, offset: usize, cx: &mut Context<Self>) {
        self.set_cursor(offset, cx);
        self.autoscroll = Some(AutoscrollTarget::Top);
    }

    pub fn set_selection(&mut self, range: Range<usize>, reversed: bool, cx: &mut Context<Self>) {
        let range = self.clip(range.start)..self.clip(range.end);
        if range != self.selection || reversed != self.reversed {
            self.selection = range;
            self.reversed = reversed;
            self.after_selection_change(cx);
        }
    }

    /// Apply a computed edit as a single undo step.
    pub fn apply_edit(&mut self, edit: TextEdit, cx: &mut Context<Self>) {
        self.push_undo(EditKind::Other, edit.range.start);
        self.splice(edit.range.clone(), &edit.text);
        let len = self.text.len();
        self.selection = edit.selection.start.min(len)..edit.selection.end.min(len);
        self.reversed = false;
        self.last_edit = None;
        self.after_edit(cx);
    }

    /// Delete a range without recording an undo step. Used to remove the
    /// slash command token, which is palette chrome rather than an edit.
    /// Undo steps that only typed part of the token are dropped too, so undo
    /// never brings the token back or lands on an unchanged note.
    pub fn remove_without_undo(&mut self, range: Range<usize>, cx: &mut Context<Self>) {
        let range = self.clip(range.start)..self.clip(range.end);
        let token = self.text[range.clone()].to_string();
        self.splice(range.clone(), "");
        let (before, after) = self.text.split_at(range.start);
        while let Some(top) = self.undo_stack.last_text() {
            let partial = top.len() >= self.text.len()
                && top.len() - self.text.len() <= token.len()
                && top
                    .strip_prefix(before)
                    .and_then(|rest| rest.strip_suffix(after))
                    .is_some_and(|typed| token.starts_with(typed));
            if !partial {
                break;
            }
            self.undo_stack.pop();
        }
        self.redo_stack.clear();
        self.last_edit = None;
        self.selection = range.start..range.start;
        self.reversed = false;
        self.bump_version();
        self.autoscroll = Some(AutoscrollTarget::Caret);
        cx.notify();
    }

    pub fn insert_text(&mut self, text: &str, cx: &mut Context<Self>) {
        let range = self.selection.clone();
        let caret = range.start + text.len();
        self.apply_edit(
            TextEdit {
                range,
                text: text.to_string(),
                selection: caret..caret,
            },
            cx,
        );
    }

    pub fn undo(&mut self, cx: &mut Context<Self>) {
        if let Some(snapshot) = self.undo_stack.pop() {
            self.redo_stack.push(&self.text, self.selection.clone());
            self.restore(snapshot, cx);
        }
    }

    pub fn redo(&mut self, cx: &mut Context<Self>) {
        if let Some(snapshot) = self.redo_stack.pop() {
            self.undo_stack.push(&self.text, self.selection.clone());
            self.restore(snapshot, cx);
        }
    }

    /// Bottom-left of the caret in window coordinates, from the last frame.
    pub fn caret_bounds(&self) -> Option<Bounds<Pixels>> {
        self.layout.borrow().caret_bounds(self.cursor())
    }

    pub fn viewport(&self) -> Bounds<Pixels> {
        self.scroll.bounds()
    }

    // -- Internals -----------------------------------------------------------

    fn clip(&self, offset: usize) -> usize {
        let mut offset = offset.min(self.text.len());
        while !self.text.is_char_boundary(offset) {
            offset -= 1;
        }
        offset
    }

    fn bump_version(&mut self) {
        self.version = self.version.wrapping_add(1);
    }

    pub(crate) fn line_infos(&self) -> Rc<Vec<markdown::LineInfo>> {
        if let Some((version, infos)) = &*self.classified.borrow()
            && *version == self.version
        {
            return infos.clone();
        }
        let infos = Rc::new(markdown::classify(&self.text));
        *self.classified.borrow_mut() = Some((self.version, infos.clone()));
        infos
    }

    /// The container of the line holding `offset`, from the cached
    /// classification, so caret moves do not rescan the note.
    pub fn group_at(&self, offset: usize) -> markdown::Group {
        let infos = self.line_infos();
        let index = infos.partition_point(|info| info.range.start <= offset);
        index
            .checked_sub(1)
            .map_or(markdown::Group::None, |index| infos[index].group)
    }

    fn splice(&mut self, range: Range<usize>, text: &str) {
        self.text.replace_range(range, text);
        self.marked = None;
    }

    fn push_undo(&mut self, kind: EditKind, at: usize) {
        let now = Instant::now();
        let grouped = matches!(
            self.last_edit,
            Some((time, last_kind, last_at))
                if kind != EditKind::Other && last_kind == kind && now - time < UNDO_GROUP && last_at == at
        );
        if !grouped {
            self.undo_stack.push(&self.text, self.selection.clone());
        }
        self.redo_stack.clear();
    }

    fn restore(&mut self, snapshot: Snapshot, cx: &mut Context<Self>) {
        self.text = snapshot.text;
        self.selection = snapshot.selection;
        self.reversed = false;
        self.marked = None;
        self.last_edit = None;
        self.after_edit(cx);
    }

    fn after_edit(&mut self, cx: &mut Context<Self>) {
        self.bump_version();
        self.goal_x = None;
        self.autoscroll = Some(AutoscrollTarget::Caret);
        self.restart_blink(cx);
        cx.emit(EditorEvent::Edited);
        cx.notify();
    }

    fn after_selection_change(&mut self, cx: &mut Context<Self>) {
        self.autoscroll = Some(AutoscrollTarget::Caret);
        self.last_edit = None;
        self.restart_blink(cx);
        cx.emit(EditorEvent::SelectionChanged);
        cx.notify();
    }

    fn restart_blink(&mut self, cx: &mut Context<Self>) {
        self.blink_on = true;
        let task = cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(BLINK_INTERVAL).await;
                let alive = this.update(cx, |this, cx| {
                    this.blink_on = !this.blink_on;
                    cx.notify();
                });
                if alive.is_err() {
                    break;
                }
            }
        });
        self.blink_task = Some(task);
    }

    /// Replace the selection (or `range`) with typed text.
    fn type_text(&mut self, range: Option<Range<usize>>, text: &str, cx: &mut Context<Self>) {
        let text = if self.mode == EditorMode::SingleLine {
            text.replace(['\n', '\r'], " ")
        } else {
            normalize_newlines(text)
        };
        // Committing a composition: its undo step was taken when it began.
        let composing = self.marked.is_some();
        let range = range
            .or_else(|| self.marked.clone())
            .unwrap_or_else(|| self.selection.clone());
        let kind = if text.is_empty() {
            EditKind::Deleting
        } else {
            EditKind::Typing
        };
        if !composing {
            self.push_undo(kind, range.start);
        }
        self.splice(range.clone(), &text);
        let caret = range.start + text.len();
        self.selection = caret..caret;
        self.reversed = false;
        self.last_edit = Some((Instant::now(), kind, caret));
        self.after_edit(cx);
    }

    fn delete_range(&mut self, range: Range<usize>, cx: &mut Context<Self>) {
        if range.is_empty() {
            return;
        }
        self.push_undo(EditKind::Deleting, range.end);
        self.splice(range.clone(), "");
        self.selection = range.start..range.start;
        self.reversed = false;
        self.last_edit = Some((Instant::now(), EditKind::Deleting, range.start));
        self.after_edit(cx);
    }

    fn previous_boundary(&self, offset: usize) -> usize {
        self.text[..offset]
            .grapheme_indices(true)
            .next_back()
            .map_or(0, |(i, _)| i)
    }

    fn next_boundary(&self, offset: usize) -> usize {
        self.text[offset..]
            .graphemes(true)
            .next()
            .map_or(self.text.len(), |g| offset + g.len())
    }

    fn previous_word(&self, offset: usize) -> usize {
        self.text[..offset]
            .split_word_bound_indices()
            .rev()
            .find(|(_, word)| !word.chars().all(char::is_whitespace))
            .map_or(0, |(index, _)| index)
    }

    fn next_word(&self, offset: usize) -> usize {
        for (index, word) in self.text[offset..].split_word_bound_indices() {
            if !word.chars().all(char::is_whitespace) {
                return offset + index + word.len();
            }
        }
        self.text.len()
    }

    fn word_range(&self, offset: usize) -> Range<usize> {
        let line = line_range(&self.text, offset);
        for (index, word) in self.text[line.clone()].split_word_bound_indices() {
            let start = line.start + index;
            let end = start + word.len();
            if offset >= start && offset < end || offset == end && end == line.end {
                return start..end;
            }
        }
        offset..offset
    }

    fn move_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        self.set_selection(offset..offset, false, cx);
    }

    fn select_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        let anchor = if self.reversed {
            self.selection.end
        } else {
            self.selection.start
        };
        if offset < anchor {
            self.set_selection(offset..anchor, true, cx);
        } else {
            self.set_selection(anchor..offset, false, cx);
        }
    }

    fn vertical_target(&mut self, direction: f32, pages: bool) -> Option<usize> {
        let layout = self.layout.borrow();
        let caret = layout.caret_bounds(self.cursor())?;
        let goal_x = self.goal_x.unwrap_or(caret.origin.x);
        let distance = if pages {
            (self.scroll.bounds().size.height - px(60.)).max(px(60.))
        } else {
            px(0.)
        };
        let target = if direction < 0. {
            // Just above the caret's row; its own top would find the same row.
            layout.index_above(point(goal_x, caret.origin.y - distance - px(1.)))
        } else {
            layout.index_below(point(goal_x, caret.bottom() + distance))
        };
        let target = target.or(Some(if direction < 0. { 0 } else { self.text.len() }));
        let target = match target {
            Some(target) if !pages => layout
                .collapsed_between(self.cursor(), target)
                .or(Some(target)),
            target => target,
        };
        drop(layout);
        self.goal_x = Some(goal_x);
        target
    }

    fn move_vertically(
        &mut self,
        direction: f32,
        select: bool,
        pages: bool,
        cx: &mut Context<Self>,
    ) {
        let goal = self.goal_x;
        if let Some(target) = self.vertical_target(direction, pages) {
            let kept = self.goal_x;
            if select {
                self.select_to(target, cx)
            } else {
                self.move_to(target, cx)
            }
            self.goal_x = kept.or(goal);
        }
        if pages {
            let offset = self.scroll.offset();
            let delta = (self.scroll.bounds().size.height - px(60.)).max(px(60.));
            self.scroll
                .set_offset(point(offset.x, offset.y - delta * direction));
            cx.notify();
        }
    }

    // -- Actions -------------------------------------------------------------

    fn left(&mut self, _: &MoveLeft, _: &mut Window, cx: &mut Context<Self>) {
        let target = if self.selection.is_empty() {
            self.previous_boundary(self.cursor())
        } else {
            self.selection.start
        };
        self.move_to(target, cx);
    }

    fn right(&mut self, _: &MoveRight, _: &mut Window, cx: &mut Context<Self>) {
        let target = if self.selection.is_empty() {
            self.next_boundary(self.cursor())
        } else {
            self.selection.end
        };
        self.move_to(target, cx);
    }

    fn select_left(&mut self, _: &SelectLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.previous_boundary(self.cursor()), cx);
    }

    fn select_right(&mut self, _: &SelectRight, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.next_boundary(self.cursor()), cx);
    }

    fn up(&mut self, _: &MoveUp, _: &mut Window, cx: &mut Context<Self>) {
        self.move_vertically(-1., false, false, cx);
    }

    fn down(&mut self, _: &MoveDown, _: &mut Window, cx: &mut Context<Self>) {
        self.move_vertically(1., false, false, cx);
    }

    fn select_up(&mut self, _: &SelectUp, _: &mut Window, cx: &mut Context<Self>) {
        self.move_vertically(-1., true, false, cx);
    }

    fn select_down(&mut self, _: &SelectDown, _: &mut Window, cx: &mut Context<Self>) {
        self.move_vertically(1., true, false, cx);
    }

    fn page_up(&mut self, _: &PageUp, _: &mut Window, cx: &mut Context<Self>) {
        self.move_vertically(-1., false, true, cx);
    }

    fn page_down(&mut self, _: &PageDown, _: &mut Window, cx: &mut Context<Self>) {
        self.move_vertically(1., false, true, cx);
    }

    fn word_left(&mut self, _: &MoveWordLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.previous_word(self.cursor()), cx);
    }

    fn word_right(&mut self, _: &MoveWordRight, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.next_word(self.cursor()), cx);
    }

    fn select_word_left(&mut self, _: &SelectWordLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.previous_word(self.cursor()), cx);
    }

    fn select_word_right(&mut self, _: &SelectWordRight, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.next_word(self.cursor()), cx);
    }

    fn line_start(&mut self, _: &MoveLineStart, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(line_start(&self.text, self.cursor()), cx);
    }

    fn line_end(&mut self, _: &MoveLineEnd, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(line_end(&self.text, self.cursor()), cx);
    }

    fn select_line_start(&mut self, _: &SelectLineStart, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(line_start(&self.text, self.cursor()), cx);
    }

    fn select_line_end(&mut self, _: &SelectLineEnd, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(line_end(&self.text, self.cursor()), cx);
    }

    fn doc_start(&mut self, _: &MoveDocStart, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(0, cx);
    }

    fn doc_end(&mut self, _: &MoveDocEnd, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.text.len(), cx);
    }

    fn select_doc_start(&mut self, _: &SelectDocStart, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(0, cx);
    }

    fn select_doc_end(&mut self, _: &SelectDocEnd, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.text.len(), cx);
    }

    fn backspace(&mut self, _: &Backspace, _: &mut Window, cx: &mut Context<Self>) {
        if !self.selection.is_empty() {
            self.delete_range(self.selection.clone(), cx);
            return;
        }
        let cursor = self.cursor();
        // Backspace right after a list or quote marker removes the marker.
        if self.mode == EditorMode::Document {
            let start = line_start(&self.text, cursor);
            let (indent, kind, prefix) =
                block_prefix(&self.text[start..line_end(&self.text, cursor)]);
            if kind != BlockKind::Paragraph
                && !matches!(kind, BlockKind::Heading(_))
                && cursor == start + indent + prefix
                && prefix > 0
            {
                self.delete_range(start + indent..cursor, cx);
                return;
            }
        }
        self.delete_range(self.previous_boundary(cursor)..cursor, cx);
    }

    fn delete(&mut self, _: &Delete, _: &mut Window, cx: &mut Context<Self>) {
        if !self.selection.is_empty() {
            self.delete_range(self.selection.clone(), cx);
        } else {
            let cursor = self.cursor();
            self.delete_range(cursor..self.next_boundary(cursor), cx);
        }
    }

    fn delete_word_left(&mut self, _: &DeleteWordLeft, _: &mut Window, cx: &mut Context<Self>) {
        if self.selection.is_empty() {
            let cursor = self.cursor();
            self.delete_range(self.previous_word(cursor)..cursor, cx);
        } else {
            self.delete_range(self.selection.clone(), cx);
        }
    }

    fn delete_word_right(&mut self, _: &DeleteWordRight, _: &mut Window, cx: &mut Context<Self>) {
        if self.selection.is_empty() {
            let cursor = self.cursor();
            self.delete_range(cursor..self.next_word(cursor), cx);
        } else {
            self.delete_range(self.selection.clone(), cx);
        }
    }

    fn delete_to_line_start(
        &mut self,
        _: &DeleteToLineStart,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let cursor = self.cursor();
        let start = line_start(&self.text, cursor);
        let start = if start == cursor {
            self.previous_boundary(cursor)
        } else {
            start
        };
        self.delete_range(start..cursor, cx);
    }

    fn newline(&mut self, _: &Newline, _: &mut Window, cx: &mut Context<Self>) {
        if self.mode == EditorMode::SingleLine {
            cx.emit(EditorEvent::Submit);
            return;
        }
        let cursor = self.selection.start;
        let line = line_range(&self.text, cursor);
        let raw_block = self.in_raw_block(line.start);
        let current = &self.text[line.clone()];
        if text_ops::code_block_at(&self.text, cursor)
            .is_some_and(|(opening, _)| opening.start != line.start)
        {
            let indent: String = current
                .chars()
                .take_while(|c| *c == ' ' || *c == '\t')
                .collect();
            self.type_text(None, &format!("\n{indent}"), cx);
            return;
        }
        let (indent, kind, prefix) = block_prefix(current);
        let body_empty = current[indent + prefix..].trim().is_empty();
        match kind {
            BlockKind::Bullet | BlockKind::Number | BlockKind::Todo | BlockKind::Quote
                if prefix > 0 =>
            {
                if body_empty && self.selection.is_empty() {
                    // Enter on an empty item ends the list or quote.
                    let edit = TextEdit {
                        range: line.clone(),
                        text: String::new(),
                        selection: line.start..line.start,
                    };
                    self.apply_edit(edit, cx);
                    return;
                }
                let marker = &current[indent..indent + prefix];
                let next_marker = match kind {
                    BlockKind::Number => {
                        let digits: String =
                            marker.chars().take_while(char::is_ascii_digit).collect();
                        let delimiter = marker[digits.len()..].chars().next().unwrap_or('.');
                        format!("{}{} ", digits.parse::<u64>().unwrap_or(0) + 1, delimiter)
                    }
                    BlockKind::Todo => format!("{} [ ] ", &marker[..1]),
                    _ => marker.to_string(),
                };
                self.type_text(
                    None,
                    &format!("\n{}{}", &current[..indent], next_marker),
                    cx,
                );
            }
            // Like the web editor, Enter ends a paragraph or heading; the blank
            // line keeps the Markdown paragraphs separate. Shift-Enter inserts
            // a soft line break instead.
            BlockKind::Paragraph | BlockKind::Heading(_)
                if !current.trim().is_empty() && !raw_block =>
            {
                self.type_text(None, "\n\n", cx)
            }
            _ => self.type_text(None, "\n", cx),
        }
    }

    /// Tables, HTML blocks, and display math keep single newlines.
    fn in_raw_block(&mut self, line_start: usize) -> bool {
        let infos = self.line_infos();
        infos
            .binary_search_by_key(&line_start, |info| info.range.start)
            .ok()
            .is_some_and(|index| {
                let info = &infos[index];
                matches!(
                    info.group,
                    markdown::Group::Table | markdown::Group::Math | markdown::Group::Code
                )
            })
    }

    fn newline_plain(&mut self, _: &NewlinePlain, _: &mut Window, cx: &mut Context<Self>) {
        self.type_text(None, "\n", cx);
    }

    fn indent(&mut self, _: &Indent, _: &mut Window, cx: &mut Context<Self>) {
        let cursor = self.cursor();
        if let Some(edit) = text_ops::table_tab(&self.text, cursor, true) {
            if edit.range.is_empty() && edit.text.is_empty() {
                self.set_cursor(edit.selection.start, cx);
            } else {
                self.apply_edit(edit, cx);
            }
            return;
        }
        let start = line_start(&self.text, cursor);
        let (_, kind, _) = block_prefix(&self.text[start..line_end(&self.text, cursor)]);
        if matches!(
            kind,
            BlockKind::Bullet | BlockKind::Number | BlockKind::Todo
        ) {
            let shift = |offset: usize| if offset < start { offset } else { offset + 2 };
            let selection = shift(self.selection.start)..shift(self.selection.end);
            self.apply_edit(
                TextEdit {
                    range: start..start,
                    text: "  ".into(),
                    selection,
                },
                cx,
            );
        } else if text_ops::code_block_at(&self.text, cursor).is_some() {
            self.type_text(None, "  ", cx);
        } else {
            cx.propagate();
        }
    }

    fn outdent(&mut self, _: &Outdent, _: &mut Window, cx: &mut Context<Self>) {
        let cursor = self.cursor();
        if let Some(edit) = text_ops::table_tab(&self.text, cursor, false) {
            self.set_cursor(edit.selection.start, cx);
            return;
        }
        let start = line_start(&self.text, cursor);
        let line = &self.text[start..line_end(&self.text, cursor)];
        let remove = line.len() - line.trim_start_matches(' ').len();
        let remove = remove.min(2);
        if remove == 0 {
            cx.propagate();
            return;
        }
        // Only this line moves; offsets before it, such as the start of a
        // selection that begins on an earlier line, stay put.
        let shift = |offset: usize| {
            if offset <= start {
                offset
            } else {
                offset.saturating_sub(remove).max(start)
            }
        };
        let selection = shift(self.selection.start)..shift(self.selection.end);
        self.apply_edit(
            TextEdit {
                range: start..start + remove,
                text: String::new(),
                selection,
            },
            cx,
        );
    }

    fn select_all(&mut self, _: &SelectAll, _: &mut Window, cx: &mut Context<Self>) {
        self.select_all_text(cx);
    }

    fn copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
        if !self.selection.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(
                self.text[self.selection.clone()].to_string(),
            ));
        }
    }

    fn cut(&mut self, _: &Cut, _: &mut Window, cx: &mut Context<Self>) {
        if !self.selection.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(
                self.text[self.selection.clone()].to_string(),
            ));
            self.delete_range(self.selection.clone(), cx);
        }
    }

    fn paste(&mut self, _: &Paste, _: &mut Window, cx: &mut Context<Self>) {
        let Some(item) = cx.read_from_clipboard() else {
            return;
        };
        if self.mode == EditorMode::Document {
            for entry in item.entries() {
                if let ClipboardEntry::Image(image) = entry {
                    let mime = match image.format {
                        ImageFormat::Png => "image/png",
                        ImageFormat::Jpeg => "image/jpeg",
                        ImageFormat::Webp => "image/webp",
                        ImageFormat::Gif => "image/gif",
                        ImageFormat::Svg => "image/svg+xml",
                        ImageFormat::Bmp => "image/bmp",
                        _ => continue,
                    };
                    cx.emit(EditorEvent::PasteImage(image.bytes.clone(), mime));
                    return;
                }
            }
        }
        if let Some(text) = item.text() {
            self.push_undo(EditKind::Other, self.selection.start);
            self.last_edit = None;
            let text = if self.mode == EditorMode::SingleLine {
                text.replace(['\n', '\r'], " ")
            } else {
                normalize_newlines(&text)
            };
            let range = self.selection.clone();
            self.splice(range.clone(), &text);
            let caret = range.start + text.len();
            self.selection = caret..caret;
            self.reversed = false;
            self.after_edit(cx);
        }
    }

    fn undo_action(&mut self, _: &Undo, _: &mut Window, cx: &mut Context<Self>) {
        self.undo(cx);
    }

    fn redo_action(&mut self, _: &Redo, _: &mut Window, cx: &mut Context<Self>) {
        self.redo(cx);
    }

    fn toggle_wrap(&mut self, marker: &str, cx: &mut Context<Self>) {
        let range = self.selection.clone();
        let before = range
            .start
            .checked_sub(marker.len())
            .filter(|start| self.text.get(*start..range.start) == Some(marker));
        let after = self.text.get(range.end..range.end + marker.len()) == Some(marker);
        if let (Some(start), true) = (before, after) {
            let inner = self.text[range.clone()].to_string();
            let edit = TextEdit {
                range: start..range.end + marker.len(),
                text: inner.clone(),
                selection: start..start + inner.len(),
            };
            self.apply_edit(edit, cx);
        } else {
            self.apply_edit(
                text_ops::insert_inline(&self.text, range, marker, marker),
                cx,
            );
        }
    }

    fn toggle_bold(&mut self, _: &ToggleBold, _: &mut Window, cx: &mut Context<Self>) {
        if self.mode == EditorMode::Document {
            self.toggle_wrap("**", cx);
        }
    }

    fn toggle_italic(&mut self, _: &ToggleItalic, _: &mut Window, cx: &mut Context<Self>) {
        if self.mode == EditorMode::Document {
            self.toggle_wrap("_", cx);
        }
    }

    fn show_character_palette(
        &mut self,
        _: &ShowCharacterPalette,
        window: &mut Window,
        _: &mut Context<Self>,
    ) {
        window.show_character_palette();
    }

    // -- Mouse ---------------------------------------------------------------

    fn index_for_mouse(&self, position: Point<Pixels>) -> usize {
        self.layout
            .borrow()
            .index_for_point(position)
            .unwrap_or(self.text.len())
    }

    fn on_mouse_down(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        window.focus(&self.focus_handle, cx);
        let index = self.index_for_mouse(event.position);
        if self.mode == EditorMode::Document && event.click_count == 1 && !event.modifiers.shift {
            if event.modifiers.secondary()
                && let Some(link) = text_ops::link_at(&self.text, index)
            {
                cx.emit(EditorEvent::OpenLink(link.href));
                return;
            }
            if self.toggle_task_at(index, cx) {
                return;
            }
        }
        self.goal_x = None;
        let (unit, range) = match event.click_count {
            1 => (DragUnit::Character, index..index),
            2 => (DragUnit::Word, self.word_range(index)),
            _ => {
                let line = line_range(&self.text, index);
                let end = if line.end < self.text.len() {
                    line.end + 1
                } else {
                    line.end
                };
                (DragUnit::Line, line.start..end)
            }
        };
        if event.modifiers.shift {
            self.select_to(index, cx);
        } else {
            self.set_selection(range.clone(), false, cx);
        }
        self.drag = Some((unit, range));
    }

    fn on_mouse_move(&mut self, event: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        let Some((unit, anchor)) = self.drag.clone() else {
            return;
        };
        if event.pressed_button != Some(MouseButton::Left) {
            self.drag = None;
            return;
        }
        let index = self.index_for_mouse(event.position);
        let target = match unit {
            DragUnit::Character => index..index,
            DragUnit::Word => self.word_range(index),
            DragUnit::Line => line_range(&self.text, index),
        };
        if target.start < anchor.start {
            self.set_selection(target.start..anchor.end, true, cx);
        } else {
            self.set_selection(anchor.start..target.end.max(anchor.end), false, cx);
        }
    }

    fn on_mouse_up(&mut self, _: &MouseUpEvent, _: &mut Window, _: &mut Context<Self>) {
        self.drag = None;
    }

    /// Clicking the `[ ]` of a task item toggles it.
    fn toggle_task_at(&mut self, index: usize, cx: &mut Context<Self>) -> bool {
        let line = line_range(&self.text, index);
        let text = &self.text[line.clone()];
        let (indent, kind, _) = block_prefix(text);
        if kind != BlockKind::Todo {
            return false;
        }
        let Some(open) = text[indent..].find('[') else {
            return false;
        };
        let box_start = line.start + indent + open;
        if index < box_start || index > box_start + 3 {
            return false;
        }
        let checked = matches!(&self.text[box_start + 1..box_start + 2], "x" | "X");
        let caret = self.selection.clone();
        self.apply_edit(
            TextEdit {
                range: box_start + 1..box_start + 2,
                text: if checked { " " } else { "x" }.into(),
                selection: caret,
            },
            cx,
        );
        true
    }

    // -- UTF-16 conversions ----------------------------------------------------

    fn offset_from_utf16(&self, offset: usize) -> usize {
        let mut utf8 = 0;
        let mut utf16 = 0;
        for ch in self.text.chars() {
            if utf16 >= offset {
                break;
            }
            utf16 += ch.len_utf16();
            utf8 += ch.len_utf8();
        }
        utf8
    }

    fn offset_to_utf16(&self, offset: usize) -> usize {
        self.text[..offset.min(self.text.len())]
            .chars()
            .map(char::len_utf16)
            .sum()
    }

    fn range_to_utf16(&self, range: &Range<usize>) -> Range<usize> {
        self.offset_to_utf16(range.start)..self.offset_to_utf16(range.end)
    }

    fn range_from_utf16(&self, range: &Range<usize>) -> Range<usize> {
        self.offset_from_utf16(range.start)..self.offset_from_utf16(range.end)
    }
}

pub fn normalize_newlines(text: &str) -> String {
    if text.contains('\r') {
        text.replace("\r\n", "\n").replace('\r', "\n")
    } else {
        text.to_string()
    }
}

impl EntityInputHandler for Editor {
    fn text_for_range(
        &mut self,
        range_utf16: Range<usize>,
        actual_range: &mut Option<Range<usize>>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<String> {
        let range = self.range_from_utf16(&range_utf16);
        actual_range.replace(self.range_to_utf16(&range));
        Some(self.text[range].to_string())
    }

    fn selected_text_range(
        &mut self,
        _ignore_disabled_input: bool,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: self.range_to_utf16(&self.selection),
            reversed: self.reversed,
        })
    }

    fn marked_text_range(
        &self,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Range<usize>> {
        self.marked.as_ref().map(|range| self.range_to_utf16(range))
    }

    fn unmark_text(&mut self, _window: &mut Window, _cx: &mut Context<Self>) {
        self.marked = None;
    }

    fn replace_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range_utf16.as_ref().map(|r| self.range_from_utf16(r));
        self.type_text(range, new_text, cx);
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        new_selected_range_utf16: Option<Range<usize>>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range_utf16
            .as_ref()
            .map(|r| self.range_from_utf16(r))
            .or_else(|| self.marked.clone())
            .unwrap_or_else(|| self.selection.clone());
        // One undo step per composition, taken before its first preedit, so
        // undo never lands on half-composed text.
        let composing = self.marked.is_some();
        if !composing {
            self.push_undo(EditKind::Typing, range.start);
            self.last_edit = None;
        }
        self.splice(range.clone(), new_text);
        self.marked = (!new_text.is_empty()).then(|| range.start..range.start + new_text.len());
        if composing
            && self.marked.is_none()
            && self.undo_stack.last_text() == Some(self.text.as_str())
        {
            // A cancelled composition left the note unchanged.
            self.undo_stack.pop();
        }
        // The new selection is relative to the inserted text, in UTF-16.
        let selection = new_selected_range_utf16
            .map(|relative| {
                let inserted = &self.text[range.start..range.start + new_text.len()];
                let to_utf8 = |utf16: usize| {
                    let mut count = 0;
                    let mut bytes = 0;
                    for ch in inserted.chars() {
                        if count >= utf16 {
                            break;
                        }
                        count += ch.len_utf16();
                        bytes += ch.len_utf8();
                    }
                    range.start + bytes
                };
                to_utf8(relative.start)..to_utf8(relative.end)
            })
            .unwrap_or_else(|| {
                let end = range.start + new_text.len();
                end..end
            });
        self.selection = selection;
        self.reversed = false;
        self.after_edit(cx);
    }

    fn bounds_for_range(
        &mut self,
        range_utf16: Range<usize>,
        _element_bounds: Bounds<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let range = self.range_from_utf16(&range_utf16);
        self.layout.borrow().caret_bounds(range.start)
    }

    fn character_index_for_point(
        &mut self,
        point: Point<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<usize> {
        let index = self.layout.borrow().index_for_point(point)?;
        Some(self.offset_to_utf16(index))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_restores_every_state_from_diffs() {
        let states = [
            "",
            "héllo",
            "héllo wörld",
            "héllo wörld wörld",
            "wörld",
            "日本語 wörld",
            "日本語",
            "aaaa",
            "aa",
        ];
        let mut history = History::default();
        for (index, state) in states.iter().enumerate() {
            history.push(state, index..index);
        }
        // Only the newest entry keeps the whole text.
        let full = history
            .entries
            .iter()
            .filter(|entry| matches!(entry.text, Stored::Full(_)))
            .count();
        assert_eq!(full, 1);
        for (index, expected) in states.iter().enumerate().rev() {
            let snapshot = history.pop().unwrap();
            assert_eq!(snapshot.text, *expected);
            assert_eq!(snapshot.selection, index..index);
        }
        assert!(history.pop().is_none());
    }

    #[test]
    fn history_drops_the_oldest_entries_past_the_limit() {
        let mut history = History::default();
        for index in 0..UNDO_LIMIT + 5 {
            history.push(&format!("text {index}"), 0..0);
        }
        assert_eq!(history.entries.len(), UNDO_LIMIT);
        let mut last = None;
        while let Some(snapshot) = history.pop() {
            last = Some(snapshot.text);
        }
        assert_eq!(last.as_deref(), Some("text 5"));
    }
}
