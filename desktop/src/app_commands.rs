//! Command execution and event handling for `LabApp`.

use std::path::{Path, PathBuf};

use gpui::{Context, PathPromptOptions, Window};

use super::{Backlink, ConfirmAction, Confirmation, LabApp, Mode, Palette, PickerKind};
use crate::backup::{self, BACKUP_FILENAME};
use crate::commands::{self, CODE_LANGUAGES};
use crate::editor::{Editor, EditorEvent};
use crate::markdown_info::{
    backlink_excerpt, document_id_from_href, document_stats, linked_document_ids,
    markdown_export_filename,
};
use crate::search::{self, SearchDocument};
use crate::text_ops::{self, BlockKind, TableOp, TextEdit};
use crate::theme::{Colors, THEMES, ThemeDef};
use crate::vault::{ArchiveFilter, DEFAULT_DOCUMENT_ID, now_ms, sniff_image_mime};

const MAX_IMPORT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES: u64 = 16 * 1024 * 1024;

fn documents_dir() -> PathBuf {
    dirs::document_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// `dir/name`, or `dir/name (2)` and so on when the file already exists.
fn unused_path(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) => (stem, format!(".{ext}")),
        None => (name, String::new()),
    };
    (2..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|path| !path.exists())
        .expect("an unused name exists")
}

impl LabApp {
    pub(crate) fn execute(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let block = |kind: BlockKind| {
            move |text: &str, selection| Some(text_ops::set_block(text, selection, kind))
        };
        match id {
            "text" => _ = self.edit(block(BlockKind::Paragraph), cx),
            "h1" => _ = self.edit(block(BlockKind::Heading(1)), cx),
            "h2" => _ = self.edit(block(BlockKind::Heading(2)), cx),
            "h3" => _ = self.edit(block(BlockKind::Heading(3)), cx),
            "bullet" => _ = self.edit(block(BlockKind::Bullet), cx),
            "number" => _ = self.edit(block(BlockKind::Number), cx),
            "todo" => _ = self.edit(block(BlockKind::Todo), cx),
            "quote" => _ = self.edit(block(BlockKind::Quote), cx),
            "code" => {
                _ = self.edit(
                    |text, selection| Some(text_ops::toggle_code_block(text, selection)),
                    cx,
                )
            }
            "divider" => {
                _ = self.edit(
                    |text, selection| Some(text_ops::divider(text, selection.start)),
                    cx,
                )
            }
            "table" => {
                _ = self.edit(
                    |text, selection| Some(text_ops::table(text, selection.start)),
                    cx,
                )
            }
            "callout-note" | "callout-tip" | "callout-warning" | "callout-important" => {
                let kind = id.trim_start_matches("callout-").to_string();
                self.edit(
                    move |text, selection| Some(text_ops::callout(text, selection.start, &kind)),
                    cx,
                );
            }
            "details" => {
                _ = self.edit(
                    |text, selection| Some(text_ops::details(text, selection.start)),
                    cx,
                )
            }
            "inline-math" => {
                _ = self.edit(
                    |text, selection| Some(text_ops::insert_inline(text, selection, "$$", "$$")),
                    cx,
                )
            }
            "math" => {
                _ = self.edit(
                    |text, selection| Some(text_ops::block_math(text, selection.start)),
                    cx,
                )
            }
            "link" => {
                self.edit(
                    |text, selection| {
                        let label = if selection.is_empty() {
                            "label".to_string()
                        } else {
                            text[selection.clone()].to_string()
                        };
                        let inserted =
                            format!("[{}](https://", text_ops::escape_link_label(&label));
                        let caret = selection.start + inserted.len();
                        Some(TextEdit {
                            range: selection,
                            text: inserted,
                            selection: caret..caret,
                        })
                    },
                    cx,
                );
            }
            "table-row-before"
            | "table-row-after"
            | "table-delete-row"
            | "table-column-before"
            | "table-column-after"
            | "table-delete-column"
            | "table-toggle-header"
            | "table-delete" => {
                let op = match id {
                    "table-row-before" => TableOp::RowBefore,
                    "table-row-after" => TableOp::RowAfter,
                    "table-delete-row" => TableOp::DeleteRow,
                    "table-column-before" => TableOp::ColumnBefore,
                    "table-column-after" => TableOp::ColumnAfter,
                    "table-delete-column" => TableOp::DeleteColumn,
                    "table-toggle-header" => TableOp::ToggleHeader,
                    _ => TableOp::Delete,
                };
                if !self.edit(
                    move |text, selection| text_ops::table_op(text, selection.start, op),
                    cx,
                ) {
                    self.set_notice("Place the caret inside a table first.", cx);
                }
            }
            "language" => self.open_language(window, cx),
            "outline" => self.toggle_outline(cx),
            "undo" => self.editor.update(cx, |editor, cx| editor.undo(cx)),
            "redo" => self.editor.update(cx, |editor, cx| editor.redo(cx)),
            "edit-link" => self.open_link_editor(window, cx),
            "link-note" => {
                let sessions: Vec<_> = self
                    .vault
                    .sessions(ArchiveFilter::All)
                    .into_iter()
                    .filter(|session| session.id != self.session.id)
                    .collect();
                self.set_field("", false, "Search sessions to link", cx);
                self.open_mode(
                    Mode::Picker {
                        kind: PickerKind::LinkSession,
                        sessions,
                    },
                    0,
                    window,
                    cx,
                );
            }
            "backlinks" => self.open_backlinks(window, cx),
            "image" => self.pick_image(window, cx),
            "import" => self.pick_import(window, cx),
            "export" => self.export_note(window, cx),
            "backup" => self.export_backup(window, cx),
            "restore" => self.pick_restore(window, cx),
            "new" => self.new_session(window, cx),
            "name" => {
                let name = self.session.name.clone();
                self.set_field(&name, true, "Session name", cx);
                self.open_mode(Mode::Name, 0, window, cx);
            }
            "pin" | "unpin" => match self.vault.set_pinned(&self.session.id, id == "pin") {
                Ok(session) => {
                    self.session = session;
                    self.set_notice(
                        if id == "pin" {
                            "Pinned this session."
                        } else {
                            "Unpinned this session."
                        },
                        cx,
                    );
                }
                Err(_) => self.set_notice("This session's pin state could not be saved.", cx),
            },
            "archive" | "unarchive" => {
                match self.vault.set_archived(&self.session.id, id == "archive") {
                    Ok(session) => {
                        self.session = session;
                        self.set_notice(
                            if id == "archive" {
                                "Archived this session. Use /archives to find it."
                            } else {
                                "Returned this session to the active list."
                            },
                            cx,
                        );
                    }
                    Err(err) => self.set_notice(err.to_string(), cx),
                }
            }
            "sessions" | "archives" => {
                let (kind, filter, placeholder) = if id == "sessions" {
                    (
                        PickerKind::Sessions,
                        ArchiveFilter::Active,
                        "Search sessions",
                    )
                } else {
                    (
                        PickerKind::Archives,
                        ArchiveFilter::Archived,
                        "Search archived sessions",
                    )
                };
                let sessions = self.vault.sessions(filter);
                let selected = sessions
                    .iter()
                    .position(|s| s.id == self.session.id)
                    .unwrap_or(0);
                self.set_field("", false, placeholder, cx);
                self.open_mode(Mode::Picker { kind, sessions }, selected, window, cx);
            }
            "search" => {
                self.save_now(cx);
                let index = self
                    .vault
                    .all_documents()
                    .into_iter()
                    .map(|(session, markdown)| (session, search::searchable_markdown(&markdown)))
                    .collect();
                self.set_field("", false, "Search sessions and note text", cx);
                self.open_mode(
                    Mode::Search {
                        index,
                        results: Vec::new(),
                    },
                    0,
                    window,
                    cx,
                );
            }
            "stats" => {
                let stats = document_stats(self.editor.read(cx).text());
                self.open_mode(Mode::Stats(stats), 0, window, cx);
            }
            "history" => {
                self.save_now(cx);
                let versions = self.vault.versions(&self.session.id);
                self.set_field("", false, "Search version history", cx);
                self.open_mode(Mode::History(versions), 0, window, cx);
            }
            "shortcuts" => self.open_mode(Mode::Shortcuts, 0, window, cx),
            "theme" => {
                let selected = THEMES
                    .iter()
                    .position(|t| t.id == self.theme.id)
                    .unwrap_or(0);
                self.set_field("", false, "Search themes", cx);
                self.open_mode(Mode::Theme, selected, window, cx);
            }
            "delete" => {
                if self.session.id == DEFAULT_DOCUMENT_ID {
                    self.set_notice(
                        "The original session cannot be deleted. Use /clear to empty it.",
                        cx,
                    );
                    return;
                }
                self.confirm(
                    Confirmation {
                        title: "Delete this session permanently?".into(),
                        description: "This session and its version history will be removed.".into(),
                        confirm_label: "Delete session",
                        cancel_label: "Keep session",
                        danger: true,
                        action: ConfirmAction::Delete,
                    },
                    window,
                    cx,
                );
            }
            "status" => {
                self.save_now(cx);
                let status = self.vault.status();
                self.open_mode(Mode::Status(status), 0, window, cx);
            }
            "clear" => {
                let text = self.editor.read(cx).text().to_string();
                self.confirm(
                    Confirmation {
                        title: "Clear the note?".into(),
                        description: "The current note will be kept in version history.".into(),
                        confirm_label: "Clear note",
                        cancel_label: "Keep note",
                        danger: true,
                        action: ConfirmAction::Clear { text },
                    },
                    window,
                    cx,
                );
            }
            _ => self.set_notice(format!("Unknown command /{id}."), cx),
        }
    }

    // -- Outline, language, links ------------------------------------------

    pub(crate) fn toggle_outline(&mut self, cx: &mut Context<Self>) {
        self.outline_open = !self.outline_open;
        cx.notify();
    }

    fn open_language(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (text, cursor) = {
            let editor = self.editor.read(cx);
            (editor.text().to_string(), editor.cursor())
        };
        if text_ops::code_block_at(&text, cursor).is_none() {
            self.edit(
                |text, selection| Some(text_ops::toggle_code_block(text, selection)),
                cx,
            );
        }
        let editor = self.editor.read(cx);
        let current = text_ops::code_language(editor.text(), editor.cursor()).unwrap_or_default();
        let selected = CODE_LANGUAGES
            .iter()
            .position(|(id, _)| *id == current)
            .unwrap_or(0);
        self.open_mode(Mode::Language, selected, window, cx);
    }

    pub(crate) fn choose_language(
        &mut self,
        language: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.close_palette(window, cx);
        let language = language.to_string();
        let applied = self.edit(
            move |text, selection| text_ops::set_code_language(text, selection.start, &language),
            cx,
        );
        if !applied {
            self.set_notice("The code block is no longer selected.", cx);
        }
    }

    fn open_link_editor(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (text, cursor) = {
            let editor = self.editor.read(cx);
            (editor.text().to_string(), editor.cursor())
        };
        let Some(link) = text_ops::link_at(&text, cursor) else {
            self.set_notice("Place the caret inside a link first.", cx);
            return;
        };
        self.set_field(&link.label, true, "Link text", cx);
        self.field_href.update(cx, |field, cx| {
            field.set_placeholder("https://");
            field.set_text(link.href.clone(), cx);
        });
        self.open_mode(
            Mode::LinkEditor {
                range: link.range,
                focus_href: false,
            },
            0,
            window,
            cx,
        );
    }

    pub(crate) fn save_link(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(Palette {
            mode: Mode::LinkEditor { range, .. },
            ..
        }) = &self.palette
        else {
            return;
        };
        let range = range.clone();
        let label = self.field_text(cx);
        let href = self.field_href.read(cx).text().to_string();
        if label.trim().is_empty() || href.trim().is_empty() {
            self.set_notice("A link needs both text and a destination.", cx);
            return;
        }
        self.close_palette(window, cx);
        let link = text_ops::markdown_link(label.trim(), &href);
        let caret = range.start + link.len();
        self.editor.update(cx, |editor, cx| {
            editor.apply_edit(
                TextEdit {
                    range,
                    text: link,
                    selection: caret..caret,
                },
                cx,
            );
        });
    }

    pub(crate) fn remove_link(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(Palette {
            mode: Mode::LinkEditor { range, .. },
            ..
        }) = &self.palette
        else {
            return;
        };
        let range = range.clone();
        let label = self.field_text(cx);
        self.close_palette(window, cx);
        let caret = range.start + label.len();
        self.editor.update(cx, |editor, cx| {
            editor.apply_edit(
                TextEdit {
                    range,
                    text: label,
                    selection: caret..caret,
                },
                cx,
            );
        });
    }

    fn open_backlinks(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.save_now(cx);
        let target = self.session.id.clone();
        let mut links: Vec<(i64, Backlink)> = self
            .vault
            .all_documents()
            .into_iter()
            .filter(|(session, markdown)| {
                session.id != target && linked_document_ids(markdown).contains(&target)
            })
            .map(|(session, markdown)| {
                (
                    session.updated_at,
                    Backlink {
                        excerpt: backlink_excerpt(&markdown, &target),
                        document_id: session.id,
                        name: session.name,
                    },
                )
            })
            .collect();
        links.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.name.cmp(&b.1.name)));
        self.set_field("", false, "Search backlinks", cx);
        self.open_mode(
            Mode::Backlinks(links.into_iter().map(|(_, link)| link).collect()),
            0,
            window,
            cx,
        );
    }

    // -- Name, theme, sessions ---------------------------------------------

    pub(crate) fn submit_name(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let name = self.field_text(cx);
        match self.vault.rename(&self.session.id, &name) {
            Ok(session) => {
                self.session = session;
                self.close_palette(window, cx);
                self.update_title(window);
                self.set_notice(format!("Named this session “{}”.", self.session.name), cx);
            }
            Err(err) => self.set_notice(format!("Could not rename this session: {err}"), cx),
        }
    }

    pub(crate) fn choose_theme(
        &mut self,
        theme: &'static ThemeDef,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.theme = theme;
        self.colors = Colors::from_theme(theme);
        let colors = self.colors;
        for editor in [&self.editor, &self.field, &self.field_href] {
            editor.update(cx, |editor: &mut Editor, cx| editor.set_colors(colors, cx));
        }
        if let Err(err) = self.vault.set_theme(theme.id.0) {
            self.set_notice(format!("The theme could not be saved: {err}"), cx);
        }
        self.close_palette(window, cx);
        cx.notify();
    }

    fn new_session(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.save_now(cx) {
            return;
        }
        match self.vault.create_session() {
            Ok(session) => self.open_session(&session.id, window, cx),
            Err(err) => self.set_notice(format!("A new session could not be created: {err}"), cx),
        }
    }

    pub(crate) fn delete_session(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let id = self.session.id.clone();
        // Pending edits belong to the session being deleted.
        self.save_task = None;
        if let Err(err) = self.vault.delete(&id) {
            self.set_notice(format!("Could not delete this session: {err}"), cx);
            return;
        }
        let next = self
            .vault
            .sessions(ArchiveFilter::Active)
            .first()
            .map(|session| session.id.clone())
            .unwrap_or_else(|| DEFAULT_DOCUMENT_ID.to_string());
        self.saved_text = self.editor.read(cx).text().to_string();
        let name = self.session.name.clone();
        self.open_session(&next, window, cx);
        self.set_notice(format!("Deleted “{name}”."), cx);
    }

    // -- Files ---------------------------------------------------------------

    fn export_note(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        let markdown = backup::inline_assets(self.editor.read(cx).text(), &self.vault);
        let name = markdown_export_filename(&self.session.name);
        self.save_file(
            name,
            markdown,
            |_| "Exported this note as Markdown.".to_string(),
            cx,
        );
    }

    fn export_backup(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        if !self.save_now(cx) {
            self.set_notice(
                "The vault could not be backed up because this note was not fully saved.",
                cx,
            );
            return;
        }
        let documents = self.vault.all_documents();
        match backup::build_backup(&self.vault, &documents, now_ms()) {
            Ok(summary) => {
                let message = format!(
                    "Exported {} {} and {} embedded {}.",
                    summary.sessions,
                    if summary.sessions == 1 {
                        "session"
                    } else {
                        "sessions"
                    },
                    summary.assets,
                    if summary.assets == 1 {
                        "image"
                    } else {
                        "images"
                    }
                );
                self.save_file(
                    BACKUP_FILENAME.into(),
                    summary.json,
                    move |_| message.clone(),
                    cx,
                );
            }
            Err(err) => self.set_notice(
                format!("The local vault backup could not be created: {err}"),
                cx,
            ),
        }
    }

    /// Ask where to save `contents`, then write it atomically.
    fn save_file(
        &mut self,
        suggested: String,
        contents: String,
        message: impl Fn(&str) -> String + 'static,
        cx: &mut Context<Self>,
    ) {
        let receiver = cx.prompt_for_new_path(&documents_dir(), Some(&suggested));
        cx.spawn(async move |this, cx| {
            let result = receiver.await;
            let _ = this.update(cx, |this, cx| {
                let path = match result {
                    Ok(Ok(Some(path))) => path,
                    Ok(Ok(None)) => return,
                    // Without a system save dialog (for example a Linux
                    // session with no desktop portal), save next to the
                    // user's documents instead of failing.
                    Ok(Err(_)) | Err(_) => unused_path(&documents_dir(), &suggested),
                };
                match crate::vault::write_atomic(&path, contents.as_bytes()) {
                    Ok(()) => {
                        this.set_notice(format!("{} Saved to {}.", message(""), path.display()), cx)
                    }
                    Err(err) => {
                        this.set_notice(format!("Could not write {}: {err}", path.display()), cx)
                    }
                }
            });
        })
        .detach();
    }

    fn pick_file(
        &mut self,
        prompt: &str,
        multiple: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
        then: impl FnOnce(&mut Self, Vec<PathBuf>, &mut Window, &mut Context<Self>) + 'static,
    ) {
        let receiver = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple,
            prompt: Some(prompt.to_string().into()),
        });
        cx.spawn_in(window, async move |this, cx| {
            let result = receiver.await;
            let _ = this.update_in(cx, |this, window, cx| match result {
                Ok(Ok(Some(paths))) if !paths.is_empty() => then(this, paths, window, cx),
                Ok(Err(err)) => {
                    this.set_notice(format!("The file dialog is unavailable: {err}"), cx)
                }
                _ => {}
            });
        })
        .detach();
    }

    fn read_limited(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
        let size = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
        if size > limit {
            return Err("the file is too large".into());
        }
        std::fs::read(path).map_err(|e| e.to_string())
    }

    fn pick_import(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.pick_file("Import", false, window, cx, |this, paths, window, cx| {
            let path = &paths[0];
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            match Self::read_limited(path, MAX_IMPORT_BYTES).and_then(|bytes| {
                String::from_utf8(bytes).map_err(|_| "it is not UTF-8 text".into())
            }) {
                Ok(markdown) => {
                    let markdown = crate::editor::normalize_newlines(&markdown);
                    this.confirm(
                        Confirmation {
                            title: format!("Replace this note with “{name}”?"),
                            description: "The current note will be kept in version history.".into(),
                            confirm_label: "Import file",
                            cancel_label: "Cancel",
                            danger: false,
                            action: ConfirmAction::Import { markdown },
                        },
                        window,
                        cx,
                    );
                }
                Err(err) => this.set_notice(format!("Could not import “{name}”: {err}."), cx),
            }
        });
    }

    fn pick_image(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.pick_file("Insert", true, window, cx, |this, paths, _window, cx| {
            let mut inserted = Vec::new();
            for path in &paths {
                let name = path
                    .file_stem()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "image".into());
                match Self::read_limited(path, MAX_IMAGE_BYTES) {
                    Ok(bytes) => match sniff_image_mime(&bytes) {
                        Some(mime) => match this.vault.add_asset(&bytes, mime) {
                            Ok(id) => inserted.push(format!(
                                "![{}](lab-asset://{id})",
                                text_ops::escape_link_label(&name)
                            )),
                            Err(err) => {
                                this.set_notice(format!("Could not store “{name}”: {err}"), cx)
                            }
                        },
                        None => this.set_notice(format!("“{name}” is not a supported image."), cx),
                    },
                    Err(err) => this.set_notice(format!("Could not read “{name}”: {err}."), cx),
                }
            }
            if !inserted.is_empty() {
                let block = inserted.join("\n\n");
                let len = block.len();
                this.edit(
                    move |text, selection| {
                        Some(text_ops::insert_block(
                            text,
                            selection.start,
                            &block,
                            len..len,
                        ))
                    },
                    cx,
                );
            }
        });
    }

    pub(crate) fn insert_image_bytes(
        &mut self,
        bytes: Vec<u8>,
        mime: &str,
        cx: &mut Context<Self>,
    ) {
        let mime = sniff_image_mime(&bytes).unwrap_or(mime);
        match self.vault.add_asset(&bytes, mime) {
            Ok(id) => {
                let block = format!("![image](lab-asset://{id})");
                let len = block.len();
                self.edit(
                    move |text, selection| {
                        Some(text_ops::insert_block(
                            text,
                            selection.start,
                            &block,
                            len..len,
                        ))
                    },
                    cx,
                );
            }
            Err(err) => self.set_notice(format!("Could not store the pasted image: {err}"), cx),
        }
    }

    fn pick_restore(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.pick_file("Restore", false, window, cx, |this, paths, window, cx| {
            if !this.save_now(cx) {
                this.set_notice(
                    "Restore cancelled because this note was not fully saved.",
                    cx,
                );
                return;
            }
            let text = match Self::read_limited(&paths[0], backup::MAX_BACKUP_BYTES as u64)
                .and_then(|bytes| {
                    String::from_utf8(bytes).map_err(|_| "it is not UTF-8 text".into())
                }) {
                Ok(text) => text,
                Err(err) => {
                    this.set_notice(format!("Could not read the backup: {err}."), cx);
                    return;
                }
            };
            let parsed = match backup::parse_backup(&text) {
                Ok(parsed) => parsed,
                Err(err) => {
                    this.set_notice(err.to_string(), cx);
                    return;
                }
            };
            let active = this.session.id.clone();
            match backup::restore_backup(&mut this.vault, parsed, &active) {
                Ok(result) => {
                    if result.active_document_updated {
                        let id = this.session.id.clone();
                        // The editor still shows the pre-restore text; mark it
                        // saved so reopening reloads instead of overwriting.
                        this.saved_text = this.editor.read(cx).text().to_string();
                        this.open_session(&id, window, cx);
                    } else if let Some(session) = this.vault.session(&active).cloned() {
                        this.session = session;
                    }
                    this.set_notice(
                        format!(
                            "Restored {} {} ({} skipped, {} imported under new ids).",
                            result.imported,
                            if result.imported == 1 {
                                "session"
                            } else {
                                "sessions"
                            },
                            result.skipped,
                            result.renamed
                        ),
                        cx,
                    );
                }
                Err(err) => this.set_notice(err.to_string(), cx),
            }
        });
    }

    // -- Events --------------------------------------------------------------

    pub(crate) fn on_editor_event(
        &mut self,
        _editor: &gpui::Entity<Editor>,
        event: &EditorEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            EditorEvent::Edited => {
                self.schedule_save(cx);
                self.update_slash(window, cx);
                cx.notify();
            }
            EditorEvent::SelectionChanged => {
                self.update_slash(window, cx);
                if self.outline_open {
                    cx.notify();
                }
            }
            EditorEvent::OpenLink(href) => self.open_link(href, window, cx),
            EditorEvent::PasteImage(bytes, mime) => {
                self.insert_image_bytes(bytes.clone(), mime, cx)
            }
            EditorEvent::Submit => {}
        }
    }

    pub(crate) fn on_field_event(
        &mut self,
        field: &gpui::Entity<Editor>,
        event: &EditorEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            EditorEvent::Submit => self.confirm_selected(window, cx),
            EditorEvent::Edited if *field == self.field => {
                let query = self.field_text(cx);
                if let Some(palette) = &mut self.palette {
                    palette.selected = 0;
                    if let Mode::Search { index, results } = &mut palette.mode {
                        let documents: Vec<SearchDocument<'_>> = index
                            .iter()
                            .map(|(session, text)| SearchDocument {
                                id: &session.id,
                                name: &session.name,
                                searchable_text: text,
                                updated_at: session.updated_at,
                            })
                            .collect();
                        *results = search::search_documents(&documents, &query);
                    }
                }
                cx.notify();
            }
            _ => {}
        }
    }

    fn open_link(&mut self, href: &str, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(id) = document_id_from_href(href) {
            if self.vault.session(&id).is_some() {
                self.open_or_focus(&id, window, cx);
            } else {
                self.set_notice("That linked session is no longer available.", cx);
            }
        } else if href.starts_with("https://")
            || href.starts_with("http://")
            || href.starts_with("mailto:")
        {
            cx.open_url(href);
        } else {
            self.set_notice(format!("Cannot open “{href}”."), cx);
        }
    }

    // -- Global shortcut actions ----------------------------------------------

    pub(crate) fn shortcut(&mut self, command: &str, window: &mut Window, cx: &mut Context<Self>) {
        let availability = commands::availability(command, self.command_context(cx));
        if !availability.available {
            self.set_notice(
                availability
                    .reason
                    .unwrap_or("This command is not available here."),
                cx,
            );
            return;
        }
        if self.palette.is_some() {
            if let Some(Palette {
                mode: Mode::Commands { .. },
                ..
            }) = &self.palette
            {
                self.remove_slash(cx);
            }
            self.close_palette(window, cx);
        }
        self.run_command(command, window, cx);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unused_path_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(unused_path(dir.path(), "a.md"), dir.path().join("a.md"));
        std::fs::write(dir.path().join("a.md"), "x").unwrap();
        std::fs::write(dir.path().join("a (2).md"), "x").unwrap();
        assert_eq!(unused_path(dir.path(), "a.md"), dir.path().join("a (3).md"));
    }

    #[test]
    fn time_format_is_human_readable() {
        assert!(super::super::format_time(0).contains("19"));
    }
}
