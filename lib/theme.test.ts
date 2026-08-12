import assert from "node:assert/strict";
import test from "node:test";
import {
  isThemeId,
  storedTheme,
  THEME_STORAGE_KEY,
  themeFromDocument,
} from "./theme.ts";

test("theme ids include the default and licensed palettes", () => {
  assert.equal(isThemeId("dark"), true);
  assert.equal(isThemeId("light"), true);
  assert.equal(isThemeId("dracula"), true);
  assert.equal(isThemeId("nord"), true);
  assert.equal(isThemeId("solarized-dark"), true);
  assert.equal(isThemeId("catppuccin-mocha"), true);
  assert.equal(isThemeId("unknown"), false);
});

test("storedTheme uses dark for missing, invalid, or unavailable storage", () => {
  assert.equal(storedTheme({ getItem: () => null }), "dark");
  assert.equal(storedTheme({ getItem: () => "unknown" }), "dark");
  assert.equal(storedTheme({ getItem: (key) => key === THEME_STORAGE_KEY ? "nord" : null }), "nord");
  assert.equal(storedTheme({ getItem: () => { throw new Error("blocked"); } }), "dark");
});

test("themeFromDocument validates the theme attribute", () => {
  assert.equal(themeFromDocument({ dataset: { theme: "light" } }), "light");
  assert.equal(themeFromDocument({ dataset: { theme: "invalid" } }), "dark");
});
