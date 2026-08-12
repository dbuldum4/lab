import { THEMES, type ThemeId } from "./theme.ts";

export type PaletteMode =
  | "commands"
  | "status"
  | "confirm-clear"
  | "confirm-delete"
  | "name"
  | "sessions"
  | "archives"
  | "link-session"
  | "search"
  | "stats"
  | "shortcuts"
  | "language"
  | "theme"
  | "backlinks"
  | "history"
  | "link-editor";

export type SlashRange = { from: number; to: number };
export type PaletteAnchor = { left: number; top: number; bottom: number };
export type PaletteState = {
  query: string;
  range: SlashRange;
  left: number;
  top: number;
  mode: PaletteMode;
  anchor: PaletteAnchor;
};

export type Command = {
  id: string;
  label: string;
  detail: string;
  terms: string;
};

export type ShortcutDescription = {
  keys: string;
  action: string;
};

export const CODE_LANGUAGES = [
  { id: "", label: "Plain text" },
  { id: "typescript", label: "TypeScript" },
  { id: "javascript", label: "JavaScript" },
  { id: "tsx", label: "TSX" },
  { id: "jsx", label: "JSX" },
  { id: "python", label: "Python" },
  { id: "bash", label: "Shell" },
  { id: "json", label: "JSON" },
  { id: "html", label: "HTML" },
  { id: "css", label: "CSS" },
  { id: "sql", label: "SQL" },
  { id: "rust", label: "Rust" },
  { id: "go", label: "Go" },
  { id: "java", label: "Java" },
  { id: "c", label: "C" },
  { id: "cpp", label: "C++" },
  { id: "yaml", label: "YAML" },
  { id: "markdown", label: "Markdown" },
] as const;

export const KEYBOARD_SHORTCUTS: ShortcutDescription[] = [
  { keys: "⌘/Ctrl K", action: "Open sessions" },
  { keys: "⌘/Ctrl ⇧ F", action: "Search every note" },
  { keys: "⌘/Ctrl ⇧ O", action: "Toggle outline" },
  { keys: "⌘/Ctrl ⇧ S", action: "Show document stats" },
  { keys: "⌘/Ctrl ⌥ H", action: "Open version history" },
  { keys: "⌘/Ctrl ⌥ L", action: "Choose code-block language" },
  { keys: "⌘/Ctrl ⇧ K", action: "Edit the current link" },
  { keys: "⌘/Ctrl ⇧ N", action: "Create a new session" },
  { keys: "⌘/Ctrl ⇧ E", action: "Insert an equation" },
  { keys: "⌘/Ctrl S", action: "Export the current note" },
  { keys: "⌘/Ctrl /", action: "Show shortcuts" },
];

export const COMMANDS: Command[] = [
  { id: "text", label: "Text", detail: "Plain paragraph", terms: "paragraph normal" },
  { id: "h1", label: "Heading 1", detail: "Large section title", terms: "title h1" },
  { id: "h2", label: "Heading 2", detail: "Medium section title", terms: "subtitle h2" },
  { id: "h3", label: "Heading 3", detail: "Small section title", terms: "subtitle h3" },
  { id: "outline", label: "Outline", detail: "Toggle document headings", terms: "toc table of contents navigation sidebar" },
  { id: "bullet", label: "Bulleted list", detail: "Create an unordered list", terms: "ul list bullets" },
  { id: "number", label: "Numbered list", detail: "Create an ordered list", terms: "ol list numbers" },
  { id: "todo", label: "To-do list", detail: "Create a checklist", terms: "task check checkbox" },
  { id: "quote", label: "Quote", detail: "Create a block quote", terms: "blockquote citation" },
  { id: "code", label: "Code block", detail: "Write preformatted code", terms: "pre snippet" },
  { id: "divider", label: "Divider", detail: "Separate sections", terms: "rule hr line" },
  { id: "table", label: "Table", detail: "Insert a 3 × 3 Markdown table", terms: "grid rows columns" },
  { id: "table-row-before", label: "Table row above", detail: "Add a row before the current row", terms: "table insert row above" },
  { id: "table-row-after", label: "Table row below", detail: "Add a row after the current row", terms: "table insert row below" },
  { id: "table-delete-row", label: "Delete table row", detail: "Remove the current row", terms: "table remove row" },
  { id: "table-column-before", label: "Table column left", detail: "Add a column before the current one", terms: "table insert column left" },
  { id: "table-column-after", label: "Table column right", detail: "Add a column after the current one", terms: "table insert column right" },
  { id: "table-delete-column", label: "Delete table column", detail: "Remove the current column", terms: "table remove column" },
  { id: "table-toggle-header", label: "Toggle table header", detail: "Toggle the current row as a header", terms: "table heading header row" },
  { id: "table-delete", label: "Delete table", detail: "Remove the current table", terms: "table remove grid" },
  { id: "language", label: "Code language", detail: "Set the current code block language", terms: "code block syntax language fence" },
  { id: "callout-note", label: "Note callout", detail: "Insert a note callout", terms: "alert info block" },
  { id: "callout-tip", label: "Tip callout", detail: "Insert a tip callout", terms: "alert advice block" },
  { id: "callout-warning", label: "Warning callout", detail: "Insert a warning callout", terms: "alert caution block" },
  { id: "callout-important", label: "Important callout", detail: "Insert an important callout", terms: "alert critical block" },
  { id: "details", label: "Collapsible section", detail: "Insert a summary with collapsible content", terms: "details disclosure toggle fold" },
  { id: "inline-math", label: "Inline equation", detail: "Write LaTeX within a line", terms: "math latex formula inline equation" },
  { id: "math", label: "Block equation", detail: "Write a centered LaTeX equation", terms: "math latex formula display equation" },
  { id: "link", label: "Link", detail: "Type a URL, then close with )", terms: "url href markdown" },
  { id: "link-note", label: "Link to session", detail: "Insert a link to another local note", terms: "internal wiki note relation" },
  { id: "backlinks", label: "Backlinks", detail: "Show sessions linking here", terms: "incoming internal links references" },
  { id: "edit-link", label: "Edit link", detail: "Edit the selected link label and URL", terms: "url href rename unlink" },
  { id: "image", label: "Image", detail: "Insert a local image", terms: "photo picture upload paste" },
  { id: "image-metadata", label: "Image metadata", detail: "Edit alt text and title", terms: "photo accessibility caption alt title" },
  { id: "undo", label: "Undo", detail: "Undo the last change", terms: "back history" },
  { id: "redo", label: "Redo", detail: "Redo the last change", terms: "forward history" },
  { id: "import", label: "Import Markdown", detail: "Open a local .md file", terms: "open file load" },
  { id: "export", label: "Export Markdown", detail: "Save a local .md copy", terms: "download file save" },
  { id: "backup", label: "Export vault backup", detail: "Save every session and local image", terms: "vault backup export all archive" },
  { id: "restore", label: "Restore vault backup", detail: "Merge a validated local backup", terms: "vault backup restore import merge" },
  { id: "recover", label: "Export recovery drafts", detail: "Download conflicting local drafts", terms: "conflict restore backup" },
  { id: "new", label: "New session", detail: "Start a separate document", terms: "document note create" },
  { id: "name", label: "Name session", detail: "Rename this document", terms: "document note title rename" },
  { id: "pin", label: "Pin session", detail: "Keep this session at the top", terms: "favorite important document" },
  { id: "unpin", label: "Unpin session", detail: "Return this session to date ordering", terms: "favorite document" },
  { id: "archive", label: "Archive session", detail: "Hide this session from active lists", terms: "hide store document" },
  { id: "unarchive", label: "Unarchive session", detail: "Return this session to active lists", terms: "restore show document" },
  { id: "sessions", label: "Sessions", detail: "Resume another document", terms: "documents notes switch open resume" },
  { id: "archives", label: "Archived sessions", detail: "Browse locally archived notes", terms: "documents hidden stored" },
  { id: "search", label: "Search notes", detail: "Find across local sessions", terms: "find search notes text content sessions" },
  { id: "stats", label: "Document stats", detail: "Words, characters, blocks, and reading time", terms: "count reading time metrics" },
  { id: "history", label: "Version history", detail: "Restore an earlier local version", terms: "revisions snapshots time machine" },
  { id: "shortcuts", label: "Keyboard shortcuts", detail: "Show every app shortcut", terms: "keys hotkeys help" },
  { id: "theme", label: "Theme", detail: "Choose the app colors", terms: "appearance light dark dracula nord solarized catppuccin" },
  { id: "delete", label: "Delete session", detail: "Remove this document permanently", terms: "remove destroy discard session document" },
  { id: "status", label: "Storage status", detail: "Inspect local redundancy", terms: "local-only copies offline" },
  { id: "clear", label: "Clear note", detail: "Requires a second Enter", terms: "delete erase reset" },
];

export const PALETTE_ID = "slash-command-palette";

export function filterCommands(
  palette: PaletteState | null,
  sessionPinned: boolean,
  sessionArchived: boolean,
): Command[] {
  if (!palette || palette.mode !== "commands") return [];
  const query = palette.query.toLowerCase();
  return COMMANDS
    .filter((command) => command.id !== (sessionPinned ? "pin" : "unpin"))
    .filter((command) => command.id !== (sessionArchived ? "archive" : "unarchive"))
    .filter((command) => `${command.id} ${command.label} ${command.terms}`.toLowerCase().includes(query))
    .sort((left, right) => {
      const score = (command: Command) => command.id === query
        ? 0
        : command.label.toLowerCase().startsWith(query)
          ? 1
          : 2;
      return score(left) - score(right);
    });
}

function normalizeThemeQuery(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export function filterThemes(palette: PaletteState | null) {
  if (!palette || palette.mode !== "theme") return [] as typeof THEMES[number][];
  const query = normalizeThemeQuery(palette.query.trim());
  if (!query) return [...THEMES];
  return THEMES.filter((theme) => normalizeThemeQuery(`${theme.label} ${theme.detail}`).includes(query));
}

export function paletteRole(mode: PaletteMode): "listbox" | "dialog" | "status" {
  if (["commands", "sessions", "archives", "link-session", "language", "backlinks", "history"].includes(mode)) {
    return "listbox";
  }
  if (["name", "search", "theme", "link-editor"].includes(mode)) return "dialog";
  return "status";
}

export function paletteLabel(mode: PaletteMode) {
  switch (mode) {
    case "sessions": return "Document sessions";
    case "archives": return "Archived sessions";
    case "link-session": return "Choose a session to link";
    case "search": return "Search local notes";
    case "language": return "Code block language";
    case "theme": return "Choose a theme";
    case "backlinks": return "Backlinks";
    case "history": return "Version history";
    case "link-editor": return "Edit link";
    default: return "Slash commands";
  }
}

export type { ThemeId };
