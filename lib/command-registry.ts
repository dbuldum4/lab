export type CommandExecutionPath =
  | "editor.command"
  | "editor.math"
  | "editor.outline"
  | "editor.undo"
  | "editor.redo"
  | "palette.status"
  | "palette.search"
  | "palette.stats"
  | "palette.shortcuts"
  | "palette.theme"
  | "palette.history"
  | "palette.backlinks"
  | "palette.link-session"
  | "palette.language"
  | "palette.confirm-clear"
  | "palette.confirm-delete"
  | "palette.name"
  | "palette.sessions"
  | "palette.archives"
  | "dialog.link-editor"
  | "dialog.image-metadata"
  | "file-input.restore"
  | "file-input.image"
  | "file-input.import"
  | "async.backup"
  | "async.recover"
  | "async.new-session"
  | "async.pin"
  | "async.archive";

export type Command = {
  id: string;
  label: string;
  detail: string;
  terms: string;
  executionPath: CommandExecutionPath;
};

export type ShortcutDescription = {
  keys: string;
  action: string;
  commandId: string;
};

export type CommandVariantPair = {
  enabled: string;
  disabled: string;
  state: "pinned" | "archived";
};

export const KEYBOARD_SHORTCUTS: readonly ShortcutDescription[] = [
  { keys: "⌘/Ctrl K", action: "Open sessions", commandId: "sessions" },
  { keys: "⌘/Ctrl ⇧ F", action: "Search every note", commandId: "search" },
  { keys: "⌘/Ctrl ⇧ O", action: "Toggle outline", commandId: "outline" },
  { keys: "⌘/Ctrl ⇧ S", action: "Show document stats", commandId: "stats" },
  { keys: "⌘/Ctrl ⌥ H", action: "Open version history", commandId: "history" },
  { keys: "⌘/Ctrl ⌥ L", action: "Choose code-block language", commandId: "language" },
  { keys: "⌘/Ctrl ⇧ K", action: "Edit the current link", commandId: "edit-link" },
  { keys: "⌘/Ctrl ⇧ N", action: "Create a new session", commandId: "new" },
  { keys: "⌘/Ctrl ⇧ E", action: "Insert an equation", commandId: "math" },
  { keys: "⌘/Ctrl S", action: "Export the current note", commandId: "export" },
  { keys: "⌘/Ctrl /", action: "Show shortcuts", commandId: "shortcuts" },
];

export const COMMANDS: readonly Command[] = [
  { id: "text", label: "Text", detail: "Plain paragraph", terms: "paragraph normal", executionPath: "editor.command" },
  { id: "h1", label: "Heading 1", detail: "Large section title", terms: "title h1", executionPath: "editor.command" },
  { id: "h2", label: "Heading 2", detail: "Medium section title", terms: "subtitle h2", executionPath: "editor.command" },
  { id: "h3", label: "Heading 3", detail: "Small section title", terms: "subtitle h3", executionPath: "editor.command" },
  { id: "outline", label: "Outline", detail: "Toggle document headings", terms: "toc table of contents navigation sidebar", executionPath: "editor.outline" },
  { id: "bullet", label: "Bulleted list", detail: "Create an unordered list", terms: "ul list bullets", executionPath: "editor.command" },
  { id: "number", label: "Numbered list", detail: "Create an ordered list", terms: "ol list numbers", executionPath: "editor.command" },
  { id: "todo", label: "To-do list", detail: "Create a checklist", terms: "task check checkbox", executionPath: "editor.command" },
  { id: "quote", label: "Quote", detail: "Create a block quote", terms: "blockquote citation", executionPath: "editor.command" },
  { id: "code", label: "Code block", detail: "Write preformatted code", terms: "pre snippet", executionPath: "editor.command" },
  { id: "divider", label: "Divider", detail: "Separate sections", terms: "rule hr line", executionPath: "editor.command" },
  { id: "table", label: "Table", detail: "Insert a 3 × 3 Markdown table", terms: "grid rows columns", executionPath: "editor.command" },
  { id: "table-row-before", label: "Table row above", detail: "Add a row before the current row", terms: "table insert row above", executionPath: "editor.command" },
  { id: "table-row-after", label: "Table row below", detail: "Add a row after the current row", terms: "table insert row below", executionPath: "editor.command" },
  { id: "table-delete-row", label: "Delete table row", detail: "Remove the current row", terms: "table remove row", executionPath: "editor.command" },
  { id: "table-column-before", label: "Table column left", detail: "Add a column before the current one", terms: "table insert column left", executionPath: "editor.command" },
  { id: "table-column-after", label: "Table column right", detail: "Add a column after the current one", terms: "table insert column right", executionPath: "editor.command" },
  { id: "table-delete-column", label: "Delete table column", detail: "Remove the current column", terms: "table remove column", executionPath: "editor.command" },
  { id: "table-toggle-header", label: "Toggle table header", detail: "Toggle the current row as a header", terms: "table heading header row", executionPath: "editor.command" },
  { id: "table-delete", label: "Delete table", detail: "Remove the current table", terms: "table remove grid", executionPath: "editor.command" },
  { id: "language", label: "Code language", detail: "Set the current code block language", terms: "code block syntax language fence", executionPath: "palette.language" },
  { id: "callout-note", label: "Note callout", detail: "Insert a note callout", terms: "alert info block", executionPath: "editor.command" },
  { id: "callout-tip", label: "Tip callout", detail: "Insert a tip callout", terms: "alert advice block", executionPath: "editor.command" },
  { id: "callout-warning", label: "Warning callout", detail: "Insert a warning callout", terms: "alert caution block", executionPath: "editor.command" },
  { id: "callout-important", label: "Important callout", detail: "Insert an important callout", terms: "alert critical block", executionPath: "editor.command" },
  { id: "details", label: "Collapsible section", detail: "Insert a summary with collapsible content", terms: "details disclosure toggle fold", executionPath: "editor.command" },
  { id: "inline-math", label: "Inline equation", detail: "Write LaTeX within a line", terms: "math latex formula inline equation", executionPath: "editor.math" },
  { id: "math", label: "Block equation", detail: "Write a centered LaTeX equation", terms: "math latex formula display equation", executionPath: "editor.math" },
  { id: "link", label: "Link", detail: "Type a URL, then close with )", terms: "url href markdown", executionPath: "editor.command" },
  { id: "link-note", label: "Link to session", detail: "Insert a link to another local note", terms: "internal wiki note relation", executionPath: "palette.link-session" },
  { id: "backlinks", label: "Backlinks", detail: "Show sessions linking here", terms: "incoming internal links references", executionPath: "palette.backlinks" },
  { id: "edit-link", label: "Edit link", detail: "Edit the selected link label and URL", terms: "url href rename unlink", executionPath: "dialog.link-editor" },
  { id: "image", label: "Image", detail: "Insert a local image", terms: "photo picture upload paste", executionPath: "file-input.image" },
  { id: "image-metadata", label: "Image metadata", detail: "Edit alt text and title", terms: "photo accessibility caption alt title", executionPath: "dialog.image-metadata" },
  { id: "undo", label: "Undo", detail: "Undo the last change", terms: "back history", executionPath: "editor.undo" },
  { id: "redo", label: "Redo", detail: "Redo the last change", terms: "forward history", executionPath: "editor.redo" },
  { id: "import", label: "Import Markdown", detail: "Open a local .md file", terms: "open file load", executionPath: "file-input.import" },
  { id: "export", label: "Export Markdown", detail: "Save a local .md copy", terms: "download file save", executionPath: "editor.command" },
  { id: "backup", label: "Export vault backup", detail: "Save every session and local image", terms: "vault backup export all archive", executionPath: "async.backup" },
  { id: "restore", label: "Restore vault backup", detail: "Merge a validated local backup", terms: "vault backup restore import merge", executionPath: "file-input.restore" },
  { id: "recover", label: "Export recovery drafts", detail: "Download conflicting local drafts", terms: "conflict restore backup", executionPath: "async.recover" },
  { id: "new", label: "New session", detail: "Start a separate document", terms: "document note create", executionPath: "async.new-session" },
  { id: "name", label: "Name session", detail: "Rename this document", terms: "document note title rename", executionPath: "palette.name" },
  { id: "pin", label: "Pin session", detail: "Keep this session at the top", terms: "favorite important document", executionPath: "async.pin" },
  { id: "unpin", label: "Unpin session", detail: "Return this session to date ordering", terms: "favorite document", executionPath: "async.pin" },
  { id: "archive", label: "Archive session", detail: "Hide this session from active lists", terms: "hide store document", executionPath: "async.archive" },
  { id: "unarchive", label: "Unarchive session", detail: "Return this session to active lists", terms: "restore show document", executionPath: "async.archive" },
  { id: "sessions", label: "Sessions", detail: "Resume another document", terms: "documents notes switch open resume", executionPath: "palette.sessions" },
  { id: "archives", label: "Archived sessions", detail: "Browse locally archived notes", terms: "documents hidden stored", executionPath: "palette.archives" },
  { id: "search", label: "Search notes", detail: "Find across local sessions", terms: "find search notes text content sessions", executionPath: "palette.search" },
  { id: "stats", label: "Document stats", detail: "Words, characters, blocks, and reading time", terms: "count reading time metrics", executionPath: "palette.stats" },
  { id: "history", label: "Version history", detail: "Restore an earlier local version", terms: "revisions snapshots time machine", executionPath: "palette.history" },
  { id: "shortcuts", label: "Keyboard shortcuts", detail: "Show every app shortcut", terms: "keys hotkeys help", executionPath: "palette.shortcuts" },
  { id: "theme", label: "Theme", detail: "Choose the app colors", terms: "appearance light dark dracula nord solarized catppuccin", executionPath: "palette.theme" },
  { id: "delete", label: "Delete session", detail: "Remove this document permanently", terms: "remove destroy discard session document", executionPath: "palette.confirm-delete" },
  { id: "status", label: "Storage status", detail: "Inspect local redundancy", terms: "local-only copies offline", executionPath: "palette.status" },
  { id: "clear", label: "Clear note", detail: "Requires a second Enter", terms: "delete erase reset", executionPath: "palette.confirm-clear" },
];

export const COMMAND_VARIANT_PAIRS: readonly CommandVariantPair[] = [
  { enabled: "pin", disabled: "unpin", state: "pinned" },
  { enabled: "archive", disabled: "unarchive", state: "archived" },
];

export function isDynamicCommandVisible(
  commandId: string,
  state: { pinned: boolean; archived: boolean },
) {
  return COMMAND_VARIANT_PAIRS.every((pair) => {
    const enabled = pair.state === "pinned" ? state.pinned : state.archived;
    return commandId !== (enabled ? pair.enabled : pair.disabled);
  });
}
