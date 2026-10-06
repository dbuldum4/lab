//! The window's root view: the document editor, the slash palette, the
//! outline, and notices. Commands mirror the web app's slash commands.

use std::ops::Range;
use std::rc::Rc;
use std::time::Duration;

use gpui::{
    App, AppContext as _, Context, Entity, FocusHandle, Focusable, KeyBinding, Pixels, Point,
    Subscription, Task, Window, actions, point, px,
};

use crate::backup;
use crate::commands::{self, CODE_LANGUAGES, Command, CommandContext};
use crate::editor::{Editor, EditorMode};
use crate::markdown_info::{DocumentStats, local_session_href};
use crate::search::{self, SearchResult, regex};
use crate::text_ops::{self, TextEdit};
use crate::theme::{Colors, THEMES, ThemeDef, theme_or_default};
use crate::vault::{DEFAULT_DOCUMENT_ID, SessionMeta, Vault, VaultStatus, VersionEntry, now_ms};

actions!(
    lab,
    [
        PaletteUp,
        PaletteDown,
        PaletteConfirm,
        PaletteClose,
        PaletteNextField,
        OpenSessions,
        OpenSearch,
        ToggleOutline,
        OpenStats,
        OpenHistory,
        OpenLanguage,
        EditLink,
        NewSession,
        InsertMath,
        ExportNote,
        OpenShortcuts,
        Quit,
    ]
);

pub fn bind_keys(cx: &mut App) {
    const APP: Option<&str> = Some("LabApp");
    cx.bind_keys([
        KeyBinding::new("up", PaletteUp, Some("Editor && palette")),
        KeyBinding::new("down", PaletteDown, Some("Editor && palette")),
        KeyBinding::new(
            "enter",
            PaletteConfirm,
            Some("Editor && palette && !single_line"),
        ),
        KeyBinding::new(
            "tab",
            PaletteConfirm,
            Some("Editor && palette && !single_line"),
        ),
        KeyBinding::new("up", PaletteUp, Some("Editor && single_line")),
        KeyBinding::new("down", PaletteDown, Some("Editor && single_line")),
        KeyBinding::new("tab", PaletteNextField, Some("Editor && single_line")),
        KeyBinding::new("shift-tab", PaletteNextField, Some("Editor && single_line")),
        KeyBinding::new("escape", PaletteClose, APP),
        KeyBinding::new("secondary-k", OpenSessions, APP),
        KeyBinding::new("secondary-shift-f", OpenSearch, APP),
        KeyBinding::new("secondary-shift-o", ToggleOutline, APP),
        KeyBinding::new("secondary-shift-s", OpenStats, APP),
        KeyBinding::new("secondary-alt-h", OpenHistory, APP),
        KeyBinding::new("secondary-alt-l", OpenLanguage, APP),
        KeyBinding::new("secondary-shift-k", EditLink, APP),
        KeyBinding::new("secondary-shift-n", NewSession, APP),
        KeyBinding::new("secondary-shift-e", InsertMath, APP),
        KeyBinding::new("secondary-s", ExportNote, APP),
        KeyBinding::new("secondary-/", OpenShortcuts, APP),
        KeyBinding::new("secondary-q", Quit, None),
    ]);
}

const SAVE_DELAY: Duration = Duration::from_millis(350);
const NOTICE_DURATION: Duration = Duration::from_secs(4);

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum NoticeKind {
    Info,
    Warning,
    Error,
}

pub struct Notice {
    pub id: u64,
    pub message: String,
    pub kind: NoticeKind,
}

/// Classify a message the same way the web app does.
fn classify_notice(message: &str) -> NoticeKind {
    let lower = message.to_lowercase();
    let warning = [
        "export a copy",
        "conflicting local",
        "note changed while",
        "not fully saved",
        "was deleted",
        "restore cancelled",
        "import was cancelled",
        "another window",
    ];
    let error = [
        "could not",
        "failed",
        "unavailable",
        "invalid",
        "too large",
        "cannot",
        "no longer",
    ];
    if warning.iter().any(|w| lower.contains(w)) {
        NoticeKind::Warning
    } else if error.iter().any(|e| lower.contains(e)) {
        NoticeKind::Error
    } else {
        NoticeKind::Info
    }
}

#[derive(Clone)]
pub enum ConfirmAction {
    Clear { text: String },
    Delete,
    RestoreVersion(VersionEntry),
    Import { markdown: String },
}

#[derive(Clone)]
pub struct Confirmation {
    pub title: String,
    pub description: String,
    pub confirm_label: &'static str,
    pub cancel_label: &'static str,
    pub danger: bool,
    pub action: ConfirmAction,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PickerKind {
    Sessions,
    Archives,
    LinkSession,
}

pub struct Backlink {
    pub document_id: String,
    pub name: String,
    pub excerpt: String,
}

pub enum Mode {
    Commands {
        slash: Range<usize>,
        query: String,
    },
    Status(VaultStatus),
    Confirm(Confirmation),
    Name,
    Picker {
        kind: PickerKind,
        sessions: Vec<SessionMeta>,
    },
    Search {
        index: Vec<(SessionMeta, String)>,
        results: Vec<SearchResult>,
    },
    Stats(DocumentStats),
    Shortcuts,
    Language,
    Theme,
    Backlinks(Vec<Backlink>),
    History(Vec<VersionEntry>),
    LinkEditor {
        range: Range<usize>,
        focus_href: bool,
    },
    Licenses,
}

pub struct Palette {
    pub mode: Mode,
    pub selected: usize,
    /// Caret bounds in window coordinates when the palette opened.
    pub anchor: Point<Pixels>,
    pub anchor_bottom: Pixels,
}

pub struct LabApp {
    pub(crate) vault: Vault,
    pub(crate) theme: &'static ThemeDef,
    pub(crate) colors: Colors,
    pub(crate) session: SessionMeta,
    pub(crate) editor: Entity<Editor>,
    /// Reused single-line field for palette search, names, and filters.
    pub(crate) field: Entity<Editor>,
    /// Second field for the link editor's destination.
    pub(crate) field_href: Entity<Editor>,
    pub(crate) palette: Option<Palette>,
    pub(crate) palette_scroll: gpui::ScrollHandle,
    pub(crate) outline_open: bool,
    pub(crate) notice: Option<Notice>,
    notice_counter: u64,
    notice_task: Option<Task<()>>,
    save_task: Option<Task<()>>,
    saved_text: String,
    pending_anchor: Option<(Point<Pixels>, Pixels)>,
    pub(crate) focus_handle: FocusHandle,
    _subscriptions: Vec<Subscription>,
}

impl Focusable for LabApp {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl LabApp {
    pub fn new(mut vault: Vault, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let theme = theme_or_default(vault.theme().unwrap_or(crate::theme::DEFAULT_THEME));
        let colors = Colors::from_theme(theme);
        let document_id = vault.last_session().to_string();
        let session = vault
            .session(&document_id)
            .cloned()
            .unwrap_or_else(|| vault.session(DEFAULT_DOCUMENT_ID).cloned().unwrap());
        let (markdown, load_error) = match vault.load(&session.id) {
            Ok(markdown) => (markdown, None),
            Err(err) => (
                String::new(),
                Some(format!("Could not read this note: {err}")),
            ),
        };
        let _ = vault.set_last_session(&session.id);

        let root = vault.root().to_path_buf();
        let resolver_root = root.clone();
        let resolver: crate::editor::AssetResolver = Rc::new(move |id: &str| {
            crate::vault::MIME_EXTENSIONS
                .iter()
                .map(|(_, ext)| resolver_root.join("assets").join(format!("{id}.{ext}")))
                .find(|path| {
                    id.starts_with("asset-") && !id.contains(['/', '\\', '.']) && path.exists()
                })
        });

        let editor = cx.new(|cx| {
            let mut editor = Editor::new(EditorMode::Document, colors, window, cx);
            editor.asset_resolver = Some(resolver);
            editor.set_text(markdown.clone(), cx);
            editor
        });
        let field = cx.new(|cx| Editor::new(EditorMode::SingleLine, colors, window, cx));
        let field_href = cx.new(|cx| Editor::new(EditorMode::SingleLine, colors, window, cx));

        let subscriptions = vec![
            cx.subscribe_in(&editor, window, Self::on_editor_event),
            cx.subscribe_in(&field, window, Self::on_field_event),
            cx.subscribe_in(&field_href, window, Self::on_field_event),
            cx.on_app_quit(|this, cx| {
                this.save_now(cx);
                async {}
            }),
        ];
        // The view is dropped when its window closes, before any quit hook
        // runs, so flush a pending autosave here too.
        let this = cx.entity().downgrade();
        window.on_window_should_close(cx, move |_, cx| {
            if let Some(this) = this.upgrade() {
                this.update(cx, |this, cx| this.save_now(cx));
            }
            true
        });
        window.focus(&editor.focus_handle(cx), cx);
        window.set_window_title(&format!("{} — lab", session.name));

        let mut app = Self {
            vault,
            theme,
            colors,
            session,
            editor,
            field,
            field_href,
            palette: None,
            palette_scroll: gpui::ScrollHandle::new(),
            outline_open: false,
            notice: None,
            notice_counter: 0,
            notice_task: None,
            save_task: None,
            saved_text: markdown,
            pending_anchor: None,
            focus_handle: cx.focus_handle(),
            _subscriptions: subscriptions,
        };
        if let Some(error) = load_error {
            app.set_notice(error, cx);
        }
        app
    }

    // -- Notices -------------------------------------------------------------

    pub fn set_notice(&mut self, message: impl Into<String>, cx: &mut Context<Self>) {
        let message = message.into();
        self.notice_counter += 1;
        let id = self.notice_counter;
        let kind = classify_notice(&message);
        self.notice = Some(Notice { id, message, kind });
        // Warnings and errors stay until dismissed, like the web app.
        self.notice_task = (kind == NoticeKind::Info).then(|| {
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(NOTICE_DURATION).await;
                let _ = this.update(cx, |this, cx| {
                    if this.notice.as_ref().is_some_and(|notice| notice.id == id) {
                        this.notice = None;
                        cx.notify();
                    }
                });
            })
        });
        cx.notify();
    }

    pub fn dismiss_notice(&mut self, cx: &mut Context<Self>) {
        self.notice = None;
        self.notice_task = None;
        cx.notify();
    }

    // -- Persistence ---------------------------------------------------------

    pub(crate) fn schedule_save(&mut self, cx: &mut Context<Self>) {
        self.save_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(SAVE_DELAY).await;
            let _ = this.update(cx, |this, cx| this.save_now(cx));
        }));
    }

    /// Write the note if it changed. Returns false when the write failed.
    pub fn save_now(&mut self, cx: &mut Context<Self>) -> bool {
        self.save_task = None;
        let text = self.editor.read(cx).text().to_string();
        if text == self.saved_text {
            return true;
        }
        match self.vault.save(&self.session.id, &text) {
            Ok(session) => {
                self.session = session;
                self.saved_text = text;
                true
            }
            Err(err) => {
                self.set_notice(
                    format!("Could not save this note: {err}. Export a copy to keep your changes."),
                    cx,
                );
                false
            }
        }
    }

    pub(crate) fn update_title(&self, window: &mut Window) {
        window.set_window_title(&format!("{} — lab", self.session.name));
    }

    // -- Sessions ------------------------------------------------------------

    pub(crate) fn open_session(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if !self.save_now(cx) {
            return;
        }
        let Some(session) = self.vault.session(id).cloned() else {
            self.set_notice("That session is no longer available.", cx);
            return;
        };
        let markdown = match self.vault.load(id) {
            Ok(markdown) => markdown,
            Err(err) => {
                self.set_notice(format!("Could not open “{}”: {err}", session.name), cx);
                return;
            }
        };
        self.session = session;
        self.saved_text = markdown.clone();
        let _ = self.vault.set_last_session(id);
        self.close_palette(window, cx);
        self.editor
            .update(cx, |editor, cx| editor.set_text(markdown, cx));
        self.update_title(window);
        cx.notify();
    }

    fn session_flags(&self) -> (bool, bool) {
        (self.session.pinned, self.session.archived)
    }

    // -- Palette -------------------------------------------------------------

    fn anchor(&self, cx: &App) -> (Point<Pixels>, Pixels) {
        let editor = self.editor.read(cx);
        match editor.caret_bounds() {
            Some(bounds) => (bounds.origin, bounds.bottom()),
            None => {
                let viewport = editor.viewport();
                (
                    point(viewport.center().x - px(192.), viewport.top() + px(120.)),
                    viewport.top() + px(150.),
                )
            }
        }
    }

    pub(crate) fn open_mode(
        &mut self,
        mode: Mode,
        selected: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (anchor, anchor_bottom) = match (&self.palette, self.pending_anchor) {
            (Some(palette), _) => (palette.anchor, palette.anchor_bottom),
            (None, Some(anchor)) => anchor,
            (None, None) => self.anchor(cx),
        };
        let uses_field = matches!(
            mode,
            Mode::Name
                | Mode::Picker { .. }
                | Mode::Search { .. }
                | Mode::Theme
                | Mode::Backlinks(_)
                | Mode::History(_)
                | Mode::LinkEditor { .. }
        );
        self.palette = Some(Palette {
            mode,
            selected,
            anchor,
            anchor_bottom,
        });
        let commands_mode = matches!(
            self.palette.as_ref().map(|p| &p.mode),
            Some(Mode::Commands { .. })
        );
        let doc_owns_keys = !uses_field;
        self.editor
            .update(cx, |editor, cx| editor.set_palette_open(doc_owns_keys, cx));
        if uses_field {
            window.focus(&self.field.focus_handle(cx), cx);
        } else if !commands_mode {
            window.focus(&self.editor.focus_handle(cx), cx);
        }
        cx.notify();
    }

    pub(crate) fn close_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.palette.take().is_some() {
            self.editor
                .update(cx, |editor, cx| editor.set_palette_open(false, cx));
            window.focus(&self.editor.focus_handle(cx), cx);
            cx.notify();
        }
    }

    pub(crate) fn set_field(
        &self,
        text: &str,
        select_all: bool,
        placeholder: &str,
        cx: &mut Context<Self>,
    ) {
        self.field.update(cx, |field, cx| {
            field.set_placeholder(placeholder.to_string());
            field.set_text(text.to_string(), cx);
            if select_all {
                field.select_all_text(cx);
            }
        });
    }

    pub(crate) fn field_text(&self, cx: &App) -> String {
        self.field.read(cx).text().to_string()
    }

    /// Detect `/query` before the caret and open, update, or close the palette.
    pub(crate) fn update_slash(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let editor = self.editor.read(cx);
        let text = editor.text();
        let selection = editor.selection();
        let in_commands = matches!(
            self.palette.as_ref().map(|p| &p.mode),
            Some(Mode::Commands { .. })
        );
        if self.palette.is_some() && !in_commands {
            return;
        }
        let found =
            if selection.is_empty() && text_ops::code_block_at(text, selection.start).is_none() {
                let start = text_ops::line_start(text, selection.start);
                regex!(r"(?:^|\s)/([\p{L}\p{M}\p{N}_-]*)$")
                    .captures(&text[start..selection.start])
                    .map(|captures| {
                        let query = captures[1].to_string();
                        (selection.start - query.len() - 1..selection.start, query)
                    })
            } else {
                None
            };
        match (found, in_commands) {
            (Some((slash, query)), true) => {
                if let Some(Palette {
                    mode: Mode::Commands { slash: s, query: q },
                    selected,
                    ..
                }) = &mut self.palette
                {
                    if *q != query {
                        *selected = 0;
                    }
                    *s = slash;
                    *q = query;
                }
                cx.notify();
            }
            (Some((slash, query)), false) => {
                let (anchor, anchor_bottom) = self.anchor(cx);
                self.palette = Some(Palette {
                    mode: Mode::Commands { slash, query },
                    selected: 0,
                    anchor,
                    anchor_bottom,
                });
                self.editor
                    .update(cx, |editor, cx| editor.set_palette_open(true, cx));
                cx.notify();
            }
            (None, true) => self.close_palette(window, cx),
            (None, false) => {}
        }
    }

    pub(crate) fn command_context(&self, cx: &App) -> CommandContext {
        let editor = self.editor.read(cx);
        let text = editor.text();
        let cursor = editor.cursor();
        CommandContext {
            in_table: text_ops::table_at(text, cursor).is_some(),
            in_code_block: text_ops::code_block_at(text, cursor).is_some(),
            in_link: text_ops::link_at(text, cursor).is_some(),
        }
    }

    pub(crate) fn ranked_commands(&self, query: &str, cx: &App) -> Vec<commands::Ranked> {
        let (pinned, archived) = self.session_flags();
        commands::rank(query, self.command_context(cx), pinned, archived)
    }

    /// Indices of the visible items in pickers that filter by the field.
    pub(crate) fn picker_matches(&self, cx: &App) -> Vec<usize> {
        let query = self.field_text(cx);
        let Some(palette) = &self.palette else {
            return Vec::new();
        };
        match &palette.mode {
            Mode::Picker { sessions, .. } => {
                search::filter_by_terms(sessions, &query, |s| s.name.clone())
            }
            Mode::Backlinks(links) => {
                search::filter_by_terms(links, &query, |l| format!("{} {}", l.name, l.excerpt))
            }
            Mode::History(versions) => {
                search::filter_by_terms(versions, &query, |v| v.markdown.clone())
            }
            Mode::Theme => {
                search::filter_by_terms(THEMES, &query, |t| format!("{} {}", t.label, t.detail))
            }
            _ => Vec::new(),
        }
    }

    pub(crate) fn option_count(&self, cx: &App) -> usize {
        let Some(palette) = &self.palette else {
            return 0;
        };
        match &palette.mode {
            Mode::Commands { query, .. } => self
                .ranked_commands(query, cx)
                .iter()
                .filter(|r| r.availability.available)
                .count(),
            Mode::Search { results, .. } => results.len(),
            Mode::Language => CODE_LANGUAGES.len(),
            Mode::Picker { .. } | Mode::Backlinks(_) | Mode::History(_) | Mode::Theme => {
                self.picker_matches(cx).len()
            }
            _ => 0,
        }
    }

    fn move_selection(&mut self, delta: isize, cx: &mut Context<Self>) {
        let count = self.option_count(cx);
        if let Some(palette) = &mut self.palette
            && count > 0
        {
            palette.selected =
                ((palette.selected as isize + delta).rem_euclid(count as isize)) as usize;
            cx.notify();
        }
    }

    pub(crate) fn palette_up(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        self.move_selection(-1, cx);
    }

    pub(crate) fn palette_down(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        self.move_selection(1, cx);
    }

    pub(crate) fn palette_close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.palette.is_some() {
            self.close_palette(window, cx);
        } else if self.outline_open {
            self.outline_open = false;
            cx.notify();
        } else if self.notice.is_some() {
            self.dismiss_notice(cx);
        } else {
            cx.propagate();
        }
    }

    pub(crate) fn palette_next_field(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(Palette {
            mode: Mode::LinkEditor { focus_href, .. },
            ..
        }) = &mut self.palette
        {
            *focus_href = !*focus_href;
            let target = if *focus_href {
                self.field_href.focus_handle(cx)
            } else {
                self.field.focus_handle(cx)
            };
            window.focus(&target, cx);
            cx.notify();
        }
    }

    pub(crate) fn confirm_selected(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(palette) = &self.palette else { return };
        let selected = palette.selected;
        match &palette.mode {
            Mode::Commands { query, .. } => {
                let available: Vec<&'static Command> = self
                    .ranked_commands(query, cx)
                    .into_iter()
                    .filter(|r| r.availability.available)
                    .map(|r| r.command)
                    .collect();
                if let Some(command) = available.get(selected) {
                    self.run_command(command.id, window, cx);
                }
            }
            Mode::Search { results, .. } => {
                if let Some(result) = results.get(selected) {
                    let id = result.document_id.clone();
                    self.open_or_focus(&id, window, cx);
                }
            }
            Mode::Language => {
                let language = CODE_LANGUAGES
                    .get(selected)
                    .map(|(id, _)| *id)
                    .unwrap_or("");
                self.choose_language(language, window, cx);
            }
            Mode::Picker { .. } | Mode::Backlinks(_) | Mode::History(_) | Mode::Theme => {
                if let Some(&index) = self.picker_matches(cx).get(selected) {
                    self.choose_picker_item(index, window, cx);
                }
            }
            Mode::Confirm(_) => self.settle_confirmation(true, window, cx),
            Mode::Name => self.submit_name(window, cx),
            Mode::LinkEditor { .. } => self.save_link(window, cx),
            Mode::Status(_) => {
                let root = self.vault.root().to_path_buf();
                cx.reveal_path(&root);
                self.close_palette(window, cx);
            }
            Mode::Stats(_) | Mode::Shortcuts | Mode::Licenses => self.close_palette(window, cx),
        }
    }

    pub(crate) fn choose_picker_item(
        &mut self,
        index: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(palette) = &self.palette else { return };
        match &palette.mode {
            Mode::Picker { kind, sessions } => {
                let Some(session) = sessions.get(index).cloned() else {
                    return;
                };
                if *kind == PickerKind::LinkSession {
                    self.close_palette(window, cx);
                    let link =
                        text_ops::markdown_link(&session.name, &local_session_href(&session.id));
                    self.editor
                        .update(cx, |editor, cx| editor.insert_text(&link, cx));
                    self.set_notice(format!("Linked to “{}”.", session.name), cx);
                } else {
                    self.open_or_focus(&session.id, window, cx);
                }
            }
            Mode::Backlinks(links) => {
                if let Some(link) = links.get(index) {
                    let id = link.document_id.clone();
                    self.open_or_focus(&id, window, cx);
                }
            }
            Mode::History(versions) => {
                let Some(version) = versions.get(index).cloned() else {
                    return;
                };
                let when = format_time(version.created_at);
                self.confirm(
                    Confirmation {
                        title: "Restore this version?".into(),
                        description: format!("Restore the version from {when}? The current note will be kept in version history."),
                        confirm_label: "Restore version",
                        cancel_label: "Cancel",
                        danger: false,
                        action: ConfirmAction::RestoreVersion(version),
                    },
                    window,
                    cx,
                );
            }
            Mode::Theme => {
                if let Some(theme) = THEMES.get(index) {
                    self.choose_theme(theme, window, cx);
                }
            }
            _ => {}
        }
    }

    pub(crate) fn open_or_focus(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if id == self.session.id {
            self.close_palette(window, cx);
        } else {
            self.open_session(id, window, cx);
        }
    }

    pub(crate) fn confirm(
        &mut self,
        confirmation: Confirmation,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.open_mode(Mode::Confirm(confirmation), 0, window, cx);
    }

    pub(crate) fn settle_confirmation(
        &mut self,
        confirmed: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(Palette {
            mode: Mode::Confirm(confirmation),
            ..
        }) = &self.palette
        else {
            return;
        };
        let action = confirmation.action.clone();
        self.close_palette(window, cx);
        if !confirmed {
            return;
        }
        let current = self.editor.read(cx).text().to_string();
        match action {
            ConfirmAction::Clear { text } => {
                if text != current {
                    self.set_notice(
                        "The note changed while clear was waiting. Clear was cancelled.",
                        cx,
                    );
                    return;
                }
                self.snapshot(&current, cx);
                self.editor
                    .update(cx, |editor, cx| editor.replace_all("", cx));
            }
            ConfirmAction::Delete => self.delete_session(window, cx),
            ConfirmAction::RestoreVersion(version) => {
                self.snapshot(&current, cx);
                self.editor
                    .update(cx, |editor, cx| editor.replace_all(&version.markdown, cx));
                self.set_notice(
                    format!(
                        "Restored the version from {}.",
                        format_time(version.created_at)
                    ),
                    cx,
                );
            }
            ConfirmAction::Import { markdown } => {
                self.snapshot(&current, cx);
                let markdown = backup::externalize_data_images(&markdown, &self.vault);
                self.editor
                    .update(cx, |editor, cx| editor.replace_all(&markdown, cx));
                self.set_notice("Imported the Markdown file.", cx);
            }
        }
    }

    pub(crate) fn snapshot(&mut self, markdown: &str, cx: &mut Context<Self>) {
        if !markdown.is_empty()
            && let Err(err) = self
                .vault
                .record_version(&self.session.id, markdown, now_ms())
        {
            self.set_notice(format!("Could not keep a version of this note: {err}"), cx);
        }
    }

    // -- Commands ------------------------------------------------------------

    pub(crate) fn remove_slash(&mut self, cx: &mut Context<Self>) {
        if let Some(Palette {
            mode: Mode::Commands { slash, .. },
            ..
        }) = &self.palette
        {
            let slash = slash.clone();
            self.editor
                .update(cx, |editor, cx| editor.remove_without_undo(slash, cx));
        }
    }

    pub(crate) fn edit(
        &mut self,
        f: impl FnOnce(&str, Range<usize>) -> Option<TextEdit>,
        cx: &mut Context<Self>,
    ) -> bool {
        let (text, selection) = {
            let editor = self.editor.read(cx);
            (editor.text().to_string(), editor.selection())
        };
        match f(&text, selection) {
            Some(edit) => {
                self.editor
                    .update(cx, |editor, cx| editor.apply_edit(edit, cx));
                true
            }
            None => false,
        }
    }

    pub fn run_command(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let availability = commands::availability(id, self.command_context(cx));
        if !availability.available {
            self.remove_slash(cx);
            self.close_palette(window, cx);
            self.set_notice(
                availability
                    .reason
                    .unwrap_or("This command is not available here."),
                cx,
            );
            return;
        }
        // The slash token is palette chrome, not an edit to undo. Follow-up
        // panels open where the slash was.
        self.remove_slash(cx);
        self.pending_anchor = self.palette.take().map(|p| (p.anchor, p.anchor_bottom));
        self.editor
            .update(cx, |editor, cx| editor.set_palette_open(false, cx));
        window.focus(&self.editor.focus_handle(cx), cx);
        self.execute(id, window, cx);
        self.pending_anchor = None;
        cx.notify();
    }
}

// Command implementations live in a child module to keep this file navigable.
#[path = "app_commands.rs"]
mod app_commands;

pub fn format_time(ms: i64) -> String {
    use chrono::{Local, TimeZone};
    match Local.timestamp_millis_opt(ms).single() {
        Some(time) => time.format("%b %-d, %Y, %-I:%M %p").to_string(),
        None => "an unknown time".into(),
    }
}
