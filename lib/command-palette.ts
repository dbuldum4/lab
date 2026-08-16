import { THEMES, type ThemeId } from "./theme.ts";
import { rankCommands, type CommandContext } from "./command-availability.ts";
import {
  COMMANDS,
  KEYBOARD_SHORTCUTS,
  isDynamicCommandVisible,
  type Command,
  type ShortcutDescription,
} from "./command-registry.ts";
import { normalizeSearchText } from "./search-normalization.ts";

export { COMMANDS, KEYBOARD_SHORTCUTS };
export type { Command, ShortcutDescription };

export type PaletteMode =
  | "commands"
  | "status"
  | "confirm"
  | "confirm-import"
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

export const PALETTE_ID = "slash-command-palette";

export function filterCommands(
  palette: PaletteState | null,
  sessionPinned: boolean,
  sessionArchived: boolean,
  context: CommandContext = { inTable: false, inCodeBlock: false, inLink: false, selectedImage: false },
): Command[] {
  return rankCommandOptions(palette, sessionPinned, sessionArchived, context)
    .filter(({ availability }) => availability.available)
    .map(({ command }) => command);
}

export function rankCommandOptions(
  palette: PaletteState | null,
  sessionPinned: boolean,
  sessionArchived: boolean,
  context: CommandContext = { inTable: false, inCodeBlock: false, inLink: false, selectedImage: false },
) {
  if (!palette || palette.mode !== "commands") return [];
  const commands = COMMANDS.filter((command) => isDynamicCommandVisible(command.id, {
    pinned: sessionPinned,
    archived: sessionArchived,
  }));
  return rankCommands(commands, palette.query, context);
}

export function filterThemes(palette: PaletteState | null) {
  if (!palette || palette.mode !== "theme") return [] as typeof THEMES[number][];
  const query = normalizeSearchText(palette.query);
  if (!query) return [...THEMES];
  return THEMES.filter((theme) => normalizeSearchText(`${theme.label} ${theme.detail}`).includes(query));
}

export function paletteRole(mode: PaletteMode): "listbox" | "dialog" | "alertdialog" | "status" {
  if (mode === "confirm" || mode === "confirm-import") return "alertdialog";
  if (["commands", "language"].includes(mode)) return "listbox";
  if (["name", "search", "theme", "link-editor", "sessions", "archives", "link-session", "backlinks", "history"].includes(mode)) {
    return "dialog";
  }
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
    case "confirm-import": return "Confirm Markdown import";
    case "confirm": return "Confirm action";
    default: return "Slash commands";
  }
}

export type { ThemeId };
