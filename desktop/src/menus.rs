//! The application menu bar. Items dispatch the same actions as the keyboard
//! shortcuts, so the menu shows each shortcut next to its command.

use gpui::{Action, App, KeyBinding, Menu, MenuItem, OsAction, SystemMenuType, actions};

use crate::app::{
    EditLink, ExportNote, InsertMath, NewSession, OpenHistory, OpenLanguage, OpenSearch,
    OpenSessions, OpenShortcuts, OpenStats, Quit, ToggleOutline,
};
use crate::editor;

actions!(
    lab,
    [
        CloseWindow,
        MinimizeWindow,
        ZoomWindow,
        Hide,
        HideOthers,
        ShowAll
    ]
);

/// Runs a slash command by id, as if it were picked from the palette.
#[derive(Clone, Debug, PartialEq, Eq, Action)]
#[action(namespace = lab, no_json)]
pub struct RunCommand(pub &'static str);

/// The parts of the app state that change menu labels or check marks.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MenuState {
    pub pinned: bool,
    pub archived: bool,
    pub outline_open: bool,
}

pub fn bind_keys(cx: &mut App) {
    if cfg!(target_os = "macos") {
        cx.bind_keys([
            KeyBinding::new("cmd-w", CloseWindow, Some("LabApp")),
            KeyBinding::new("cmd-m", MinimizeWindow, Some("LabApp")),
            KeyBinding::new("cmd-h", Hide, None),
        ]);
    }
}

/// App-wide menu actions that work even when no window is focused.
pub fn register_global_actions(cx: &mut App) {
    cx.on_action(|_: &Quit, cx| cx.quit());
    cx.on_action(|_: &Hide, cx| cx.hide());
    cx.on_action(|_: &HideOthers, cx| cx.hide_other_apps());
    cx.on_action(|_: &ShowAll, cx| cx.unhide_other_apps());
}

fn command(name: &'static str, id: &'static str) -> MenuItem {
    MenuItem::action(name, RunCommand(id))
}

pub fn app_menus(state: MenuState) -> Vec<Menu> {
    vec![
        Menu::new("lab").items([
            MenuItem::action("Theme…", RunCommand("theme")),
            MenuItem::separator(),
            MenuItem::os_submenu("Services", SystemMenuType::Services),
            MenuItem::separator(),
            MenuItem::action("Hide lab", Hide),
            MenuItem::action("Hide Others", HideOthers),
            MenuItem::action("Show All", ShowAll),
            MenuItem::separator(),
            MenuItem::action("Quit lab", Quit),
        ]),
        Menu::new("File").items([
            MenuItem::action("New Session", NewSession),
            MenuItem::action("Open Session…", OpenSessions),
            command("Archived Sessions…", "archives"),
            MenuItem::separator(),
            command("Import Markdown…", "import"),
            MenuItem::action("Export Markdown…", ExportNote),
            MenuItem::separator(),
            command("Export Vault Backup…", "backup"),
            command("Restore Vault Backup…", "restore"),
            MenuItem::separator(),
            MenuItem::action("Close Window", CloseWindow),
        ]),
        Menu::new("Edit").items([
            MenuItem::os_action("Undo", editor::Undo, OsAction::Undo),
            MenuItem::os_action("Redo", editor::Redo, OsAction::Redo),
            MenuItem::separator(),
            MenuItem::os_action("Cut", editor::Cut, OsAction::Cut),
            MenuItem::os_action("Copy", editor::Copy, OsAction::Copy),
            MenuItem::os_action("Paste", editor::Paste, OsAction::Paste),
            MenuItem::os_action("Select All", editor::SelectAll, OsAction::SelectAll),
            MenuItem::separator(),
            MenuItem::action("Search Notes…", OpenSearch),
        ]),
        Menu::new("Format").items([
            MenuItem::action("Bold", editor::ToggleBold),
            MenuItem::action("Italic", editor::ToggleItalic),
            MenuItem::separator(),
            command("Text", "text"),
            command("Heading 1", "h1"),
            command("Heading 2", "h2"),
            command("Heading 3", "h3"),
            MenuItem::separator(),
            command("Bulleted List", "bullet"),
            command("Numbered List", "number"),
            command("To-do List", "todo"),
            command("Quote", "quote"),
            command("Code Block", "code"),
            MenuItem::action("Code Language…", OpenLanguage),
            MenuItem::separator(),
            MenuItem::action("Edit Link…", EditLink),
            MenuItem::submenu(Menu::new("Table").items([
                command("Insert Row Above", "table-row-before"),
                command("Insert Row Below", "table-row-after"),
                command("Delete Row", "table-delete-row"),
                MenuItem::separator(),
                command("Insert Column Left", "table-column-before"),
                command("Insert Column Right", "table-column-after"),
                command("Delete Column", "table-delete-column"),
                MenuItem::separator(),
                command("Toggle Header Row", "table-toggle-header"),
                command("Delete Table", "table-delete"),
            ])),
        ]),
        Menu::new("Insert").items([
            command("Link", "link"),
            command("Link to Session…", "link-note"),
            command("Image…", "image"),
            MenuItem::separator(),
            command("Table", "table"),
            command("Divider", "divider"),
            command("Collapsible Section", "details"),
            MenuItem::submenu(Menu::new("Callout").items([
                command("Note", "callout-note"),
                command("Tip", "callout-tip"),
                command("Warning", "callout-warning"),
                command("Important", "callout-important"),
            ])),
            MenuItem::separator(),
            command("Inline Equation", "inline-math"),
            MenuItem::action("Block Equation", InsertMath),
        ]),
        Menu::new("View").items([
            MenuItem::action("Outline", ToggleOutline).checked(state.outline_open),
            MenuItem::action("Document Stats", OpenStats),
            command("Backlinks", "backlinks"),
        ]),
        Menu::new("Session").items([
            command("Rename…", "name"),
            if state.pinned {
                command("Unpin", "unpin")
            } else {
                command("Pin", "pin")
            },
            if state.archived {
                command("Unarchive", "unarchive")
            } else {
                command("Archive", "archive")
            },
            MenuItem::separator(),
            MenuItem::action("Version History…", OpenHistory),
            command("Storage Status", "status"),
            MenuItem::separator(),
            command("Clear Note…", "clear"),
            command("Delete Session…", "delete"),
        ]),
        // AppKit adds its window list and tiling items to a menu named "Window".
        Menu::new("Window").items([
            MenuItem::action("Minimize", MinimizeWindow),
            MenuItem::action("Zoom", ZoomWindow),
        ]),
        Menu::new("Help").items([MenuItem::action("Keyboard Shortcuts", OpenShortcuts)]),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::COMMANDS;

    fn command_ids(items: &[MenuItem], ids: &mut Vec<&'static str>) {
        for item in items {
            match item {
                MenuItem::Submenu(menu) => command_ids(&menu.items, ids),
                MenuItem::Action { action, .. } => {
                    if let Some(RunCommand(id)) = action.as_any().downcast_ref::<RunCommand>() {
                        ids.push(id);
                    }
                }
                _ => {}
            }
        }
    }

    #[test]
    fn menu_commands_exist() {
        for state in [
            MenuState::default(),
            MenuState {
                pinned: true,
                archived: true,
                outline_open: true,
            },
        ] {
            let mut ids = Vec::new();
            for menu in app_menus(state) {
                command_ids(&menu.items, &mut ids);
            }
            for id in ids {
                assert!(
                    COMMANDS.iter().any(|command| command.id == id),
                    "/{id} is not a command"
                );
            }
        }
    }
}
