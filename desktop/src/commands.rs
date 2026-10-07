//! Slash command registry, context availability, and ranking.
//!
//! Mirrors `lib/command-registry.ts` and `lib/command-availability.ts`.
//! Browser-only commands (recovery drafts for multi-tab conflicts, image
//! metadata dialogs) are omitted: the native app has one writer per vault and
//! edits image alt text directly in the Markdown source.

use crate::search::normalize;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Command {
    pub id: &'static str,
    pub label: &'static str,
    pub detail: &'static str,
    pub terms: &'static str,
}

const fn cmd(
    id: &'static str,
    label: &'static str,
    detail: &'static str,
    terms: &'static str,
) -> Command {
    Command {
        id,
        label,
        detail,
        terms,
    }
}

pub const COMMANDS: &[Command] = &[
    cmd("text", "Text", "Plain paragraph", "paragraph normal"),
    cmd("h1", "Heading 1", "Large section title", "title h1"),
    cmd("h2", "Heading 2", "Medium section title", "subtitle h2"),
    cmd("h3", "Heading 3", "Small section title", "subtitle h3"),
    cmd(
        "outline",
        "Outline",
        "Toggle document headings",
        "toc table of contents navigation sidebar",
    ),
    cmd(
        "bullet",
        "Bulleted list",
        "Create an unordered list",
        "ul list bullets",
    ),
    cmd(
        "number",
        "Numbered list",
        "Create an ordered list",
        "ol list numbers",
    ),
    cmd(
        "todo",
        "To-do list",
        "Create a checklist",
        "task check checkbox",
    ),
    cmd(
        "quote",
        "Quote",
        "Create a block quote",
        "blockquote citation",
    ),
    cmd(
        "code",
        "Code block",
        "Write preformatted code",
        "pre snippet",
    ),
    cmd("divider", "Divider", "Separate sections", "rule hr line"),
    cmd(
        "table",
        "Table",
        "Insert a 3 × 3 Markdown table",
        "grid rows columns",
    ),
    cmd(
        "table-row-before",
        "Table row above",
        "Add a row before the current row",
        "table insert row above",
    ),
    cmd(
        "table-row-after",
        "Table row below",
        "Add a row after the current row",
        "table insert row below",
    ),
    cmd(
        "table-delete-row",
        "Delete table row",
        "Remove the current row",
        "table remove row",
    ),
    cmd(
        "table-column-before",
        "Table column left",
        "Add a column before the current one",
        "table insert column left",
    ),
    cmd(
        "table-column-after",
        "Table column right",
        "Add a column after the current one",
        "table insert column right",
    ),
    cmd(
        "table-delete-column",
        "Delete table column",
        "Remove the current column",
        "table remove column",
    ),
    cmd(
        "table-toggle-header",
        "Toggle table header",
        "Toggle the current row as a header",
        "table heading header row",
    ),
    cmd(
        "table-delete",
        "Delete table",
        "Remove the current table",
        "table remove grid",
    ),
    cmd(
        "language",
        "Code language",
        "Set the current code block language",
        "code block syntax language fence",
    ),
    cmd(
        "callout-note",
        "Note callout",
        "Insert a note callout",
        "alert info block",
    ),
    cmd(
        "callout-tip",
        "Tip callout",
        "Insert a tip callout",
        "alert advice block",
    ),
    cmd(
        "callout-warning",
        "Warning callout",
        "Insert a warning callout",
        "alert caution block",
    ),
    cmd(
        "callout-important",
        "Important callout",
        "Insert an important callout",
        "alert critical block",
    ),
    cmd(
        "details",
        "Collapsible section",
        "Insert a summary with collapsible content",
        "details disclosure toggle fold",
    ),
    cmd(
        "inline-math",
        "Inline equation",
        "Write LaTeX within a line",
        "math latex formula inline equation",
    ),
    cmd(
        "math",
        "Block equation",
        "Write a centered LaTeX equation",
        "math latex formula display equation",
    ),
    cmd(
        "link",
        "Link",
        "Type a URL, then close with )",
        "url href markdown",
    ),
    cmd(
        "link-note",
        "Link to session",
        "Insert a link to another local note",
        "internal wiki note relation",
    ),
    cmd(
        "backlinks",
        "Backlinks",
        "Show sessions linking here",
        "incoming internal links references",
    ),
    cmd(
        "edit-link",
        "Edit link",
        "Edit the selected link label and URL",
        "url href rename unlink",
    ),
    cmd(
        "image",
        "Image",
        "Insert a local image",
        "photo picture upload paste",
    ),
    cmd("undo", "Undo", "Undo the last change", "back history"),
    cmd("redo", "Redo", "Redo the last change", "forward history"),
    cmd(
        "import",
        "Import Markdown",
        "Open a local .md file",
        "open file load",
    ),
    cmd(
        "export",
        "Export Markdown",
        "Save a local .md copy",
        "download file save",
    ),
    cmd(
        "backup",
        "Export vault backup",
        "Save every session and local image",
        "vault backup export all archive",
    ),
    cmd(
        "restore",
        "Restore vault backup",
        "Merge a validated local backup",
        "vault backup restore import merge",
    ),
    cmd(
        "new",
        "New session",
        "Start a separate document",
        "document note create",
    ),
    cmd(
        "name",
        "Name session",
        "Rename this document",
        "document note title rename",
    ),
    cmd(
        "pin",
        "Pin session",
        "Keep this session at the top",
        "favorite important document",
    ),
    cmd(
        "unpin",
        "Unpin session",
        "Return this session to date ordering",
        "favorite document",
    ),
    cmd(
        "archive",
        "Archive session",
        "Hide this session from active lists",
        "hide store document",
    ),
    cmd(
        "unarchive",
        "Unarchive session",
        "Return this session to active lists",
        "restore show document",
    ),
    cmd(
        "sessions",
        "Sessions",
        "Resume another document",
        "documents notes switch open resume",
    ),
    cmd(
        "archives",
        "Archived sessions",
        "Browse locally archived notes",
        "documents hidden stored",
    ),
    cmd(
        "search",
        "Search notes",
        "Find across local sessions",
        "find search notes text content sessions",
    ),
    cmd(
        "stats",
        "Document stats",
        "Words, characters, blocks, and reading time",
        "count reading time metrics",
    ),
    cmd(
        "history",
        "Version history",
        "Restore an earlier local version",
        "revisions snapshots time machine",
    ),
    cmd(
        "shortcuts",
        "Keyboard shortcuts",
        "Show every app shortcut",
        "keys hotkeys help",
    ),
    cmd(
        "theme",
        "Theme",
        "Choose the app colors",
        "appearance light dark dracula nord solarized catppuccin",
    ),
    cmd(
        "delete",
        "Delete session",
        "Remove this document permanently",
        "remove destroy discard session document",
    ),
    cmd(
        "status",
        "Storage status",
        "Inspect the local vault",
        "local-only copies offline folder",
    ),
    cmd(
        "clear",
        "Clear note",
        "Requires a second Enter",
        "delete erase reset",
    ),
];

#[cfg(test)]
pub fn command(id: &str) -> Option<&'static Command> {
    COMMANDS.iter().find(|command| command.id == id)
}

pub struct Shortcut {
    /// GPUI keystroke, where `secondary` is Cmd on macOS and Ctrl elsewhere.
    pub keys: &'static str,
    pub action: &'static str,
    /// The slash command this shortcut runs; tests keep the two in sync.
    #[allow(dead_code)]
    pub command_id: &'static str,
}

pub const SHORTCUTS: &[Shortcut] = &[
    Shortcut {
        keys: "secondary-k",
        action: "Open sessions",
        command_id: "sessions",
    },
    Shortcut {
        keys: "secondary-shift-f",
        action: "Search every note",
        command_id: "search",
    },
    Shortcut {
        keys: "secondary-shift-o",
        action: "Toggle outline",
        command_id: "outline",
    },
    Shortcut {
        keys: "secondary-shift-s",
        action: "Show document stats",
        command_id: "stats",
    },
    Shortcut {
        keys: "secondary-alt-h",
        action: "Open version history",
        command_id: "history",
    },
    Shortcut {
        keys: "secondary-alt-l",
        action: "Choose code-block language",
        command_id: "language",
    },
    Shortcut {
        keys: "secondary-shift-k",
        action: "Edit the current link",
        command_id: "edit-link",
    },
    Shortcut {
        keys: "secondary-shift-n",
        action: "Create a new session",
        command_id: "new",
    },
    Shortcut {
        keys: "secondary-shift-e",
        action: "Insert an equation",
        command_id: "math",
    },
    Shortcut {
        keys: "secondary-s",
        action: "Export the current note",
        command_id: "export",
    },
    Shortcut {
        keys: "secondary-/",
        action: "Show shortcuts",
        command_id: "shortcuts",
    },
];

/// Human-readable keys for the current platform, e.g. `⌘ ⇧ F` or `Ctrl Shift F`.
pub fn display_keys(keys: &str) -> String {
    keys.split('-')
        .map(|part| match part {
            "secondary" => if cfg!(target_os = "macos") {
                "⌘"
            } else {
                "Ctrl"
            }
            .to_string(),
            "shift" => if cfg!(target_os = "macos") {
                "⇧"
            } else {
                "Shift"
            }
            .to_string(),
            "alt" => if cfg!(target_os = "macos") {
                "⌥"
            } else {
                "Alt"
            }
            .to_string(),
            other => other.to_uppercase(),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CommandContext {
    pub in_table: bool,
    pub in_code_block: bool,
    pub in_link: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Availability {
    pub available: bool,
    pub reason: Option<&'static str>,
}

const TABLE_COMMANDS: &[&str] = &[
    "table-row-before",
    "table-row-after",
    "table-delete-row",
    "table-column-before",
    "table-column-after",
    "table-delete-column",
    "table-toggle-header",
    "table-delete",
];

pub fn availability(command_id: &str, context: CommandContext) -> Availability {
    let unavailable = |reason| Availability {
        available: false,
        reason: Some(reason),
    };
    if TABLE_COMMANDS.contains(&command_id) && !context.in_table {
        return unavailable("Place the caret inside a table first.");
    }
    if command_id == "table" && context.in_table {
        return unavailable("Nested tables are not portable.");
    }
    if command_id == "edit-link" && !context.in_link {
        return unavailable("Place the caret inside a link first.");
    }
    Availability {
        available: true,
        reason: None,
    }
}

/// Hide the half of each pin/archive pair that does not apply.
pub fn is_dynamic_command_visible(command_id: &str, pinned: bool, archived: bool) -> bool {
    !matches!(
        (command_id, pinned, archived),
        ("pin", true, _) | ("unpin", false, _) | ("archive", _, true) | ("unarchive", _, false)
    )
}

fn match_score(command: &Command, query: &str) -> u8 {
    if query.is_empty() || normalize(command.id) == query {
        0
    } else if normalize(command.label).starts_with(query) {
        1
    } else {
        2
    }
}

pub struct Ranked {
    pub command: &'static Command,
    pub availability: Availability,
}

/// Commands matching the query: available first, then by match quality.
pub fn rank(query: &str, context: CommandContext, pinned: bool, archived: bool) -> Vec<Ranked> {
    let query = normalize(query);
    let mut ranked: Vec<(usize, Ranked)> = COMMANDS
        .iter()
        .filter(|command| is_dynamic_command_visible(command.id, pinned, archived))
        .filter(|command| {
            normalize(&format!(
                "{} {} {}",
                command.id, command.label, command.terms
            ))
            .contains(&query)
        })
        .enumerate()
        .map(|(index, command)| {
            (
                index,
                Ranked {
                    command,
                    availability: availability(command.id, context),
                },
            )
        })
        .collect();
    ranked.sort_by_key(|(index, item)| {
        (
            !item.availability.available,
            match_score(item.command, &query),
            *index,
        )
    });
    ranked.into_iter().map(|(_, item)| item).collect()
}

pub const CODE_LANGUAGES: &[(&str, &str)] = &[
    ("", "Plain text"),
    ("typescript", "TypeScript"),
    ("javascript", "JavaScript"),
    ("tsx", "TSX"),
    ("jsx", "JSX"),
    ("python", "Python"),
    ("bash", "Shell"),
    ("json", "JSON"),
    ("html", "HTML"),
    ("css", "CSS"),
    ("sql", "SQL"),
    ("rust", "Rust"),
    ("go", "Go"),
    ("java", "Java"),
    ("c", "C"),
    ("cpp", "C++"),
    ("yaml", "YAML"),
    ("markdown", "Markdown"),
];

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(query: &str, context: CommandContext) -> Vec<&'static str> {
        rank(query, context, false, false)
            .iter()
            .map(|r| r.command.id)
            .collect()
    }

    #[test]
    fn command_ids_are_unique() {
        let mut seen = std::collections::HashSet::new();
        assert!(COMMANDS.iter().all(|command| seen.insert(command.id)));
        assert!(
            SHORTCUTS
                .iter()
                .all(|shortcut| command(shortcut.command_id).is_some())
        );
    }

    #[test]
    fn exact_ids_rank_first() {
        assert_eq!(ids("h2", CommandContext::default())[0], "h2");
        assert_eq!(ids("theme", CommandContext::default())[0], "theme");
        assert_eq!(ids("find", CommandContext::default()), vec!["search"]);
    }

    #[test]
    fn unavailable_commands_sort_last_with_reasons() {
        let ranked = rank("table", CommandContext::default(), false, false);
        assert_eq!(ranked[0].command.id, "table");
        let first_unavailable = ranked
            .iter()
            .position(|r| !r.availability.available)
            .unwrap();
        assert!(
            ranked[first_unavailable..]
                .iter()
                .all(|r| !r.availability.available)
        );
        assert!(ranked[first_unavailable].availability.reason.is_some());
        let in_table = rank(
            "table",
            CommandContext {
                in_table: true,
                ..Default::default()
            },
            false,
            false,
        );
        assert_eq!(in_table.last().unwrap().command.id, "table");
        assert_eq!(
            in_table.last().unwrap().availability.reason,
            Some("Nested tables are not portable.")
        );
    }

    #[test]
    fn pin_and_archive_variants_follow_state() {
        let visible = |pinned, archived| -> Vec<&str> {
            rank("", CommandContext::default(), pinned, archived)
                .iter()
                .map(|r| r.command.id)
                .filter(|id| ["pin", "unpin", "archive", "unarchive"].contains(id))
                .collect()
        };
        assert_eq!(visible(false, false), vec!["pin", "archive"]);
        assert_eq!(visible(true, true), vec!["unpin", "unarchive"]);
    }

    #[test]
    fn display_keys_are_platform_aware() {
        let keys = display_keys("secondary-shift-f");
        assert!(keys.ends_with('F'));
        assert_eq!(keys.split(' ').count(), 3);
    }
}
