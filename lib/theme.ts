export const THEME_STORAGE_KEY = "lab.theme.v1";

export const THEMES = [
  {
    id: "dark",
    label: "Dark",
    detail: "Original lab theme",
    colorScheme: "dark",
    swatches: ["#000000", "#252523", "#f2f2f0"],
  },
  {
    id: "light",
    label: "Light",
    detail: "Warm neutral light theme",
    colorScheme: "light",
    swatches: ["#fbfbfa", "#dddcd7", "#242422"],
  },
  {
    id: "dracula",
    label: "Dracula",
    detail: "Purple and high contrast",
    colorScheme: "dark",
    swatches: ["#282a36", "#bd93f9", "#f8f8f2"],
  },
  {
    id: "nord",
    label: "Nord",
    detail: "Arctic blue palette",
    colorScheme: "dark",
    swatches: ["#2e3440", "#88c0d0", "#eceff4"],
  },
  {
    id: "solarized-dark",
    label: "Solarized Dark",
    detail: "Low-contrast blue-green",
    colorScheme: "dark",
    swatches: ["#002b36", "#268bd2", "#eee8d5"],
  },
  {
    id: "catppuccin-mocha",
    label: "Catppuccin Mocha",
    detail: "Warm pastel dark theme",
    colorScheme: "dark",
    swatches: ["#1e1e2e", "#cba6f7", "#cdd6f4"],
  },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

const THEME_IDS = new Set<string>(THEMES.map((theme) => theme.id));

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && THEME_IDS.has(value);
}

export function storedTheme(storage: Pick<Storage, "getItem">): ThemeId {
  try {
    const value = storage.getItem(THEME_STORAGE_KEY);
    return isThemeId(value) ? value : "dark";
  } catch {
    return "dark";
  }
}

export function themeFromDocument(root: Pick<HTMLElement, "dataset">): ThemeId {
  return isThemeId(root.dataset.theme) ? root.dataset.theme : "dark";
}
