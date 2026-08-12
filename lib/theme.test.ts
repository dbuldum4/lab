import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  isThemeId,
  storedTheme,
  THEMES,
  THEME_STORAGE_KEY,
  themeFromDocument,
} from "./theme.ts";

type CssRule = {
  selector: string;
  body: string;
};

function parseTopLevelCssRules(source: string): CssRule[] {
  const rules: CssRule[] = [];
  let ruleStart = 0;
  let openingBrace = -1;
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let comment = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const nextCharacter = source[index + 1];

    if (comment) {
      if (character === "*" && nextCharacter === "/") {
        comment = false;
        index += 1;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === "/" && nextCharacter === "*") {
      comment = true;
      index += 1;
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }

    if (character === ";" && depth === 0) {
      ruleStart = index + 1;
      continue;
    }

    if (character === "{") {
      if (depth === 0) openingBrace = index;
      depth += 1;
      continue;
    }

    if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && openingBrace >= 0) {
        rules.push({
          selector: source.slice(ruleStart, openingBrace).trim(),
          body: source.slice(openingBrace + 1, index),
        });
        ruleStart = index + 1;
        openingBrace = -1;
      }
    }
  }

  return rules;
}

function themeSelectorId(selector: string): string | null {
  const match = /^html\s*\[\s*data-theme\s*=\s*(["'])([^"']+)\1\s*\]$/.exec(selector);
  return match?.[2] ?? null;
}

function themeRuleId(selector: string): string | null {
  return selector === ":root" ? "dark" : themeSelectorId(selector);
}

const GLOBALS_CSS = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const GLOBALS_CSS_RULES = parseTopLevelCssRules(GLOBALS_CSS);
const THEME_CSS_RULES = GLOBALS_CSS_RULES.filter((rule) => (
  rule.selector === ":root" || themeSelectorId(rule.selector) !== null
));

test("declared theme ids are recognized and unique", () => {
  const themeIds = THEMES.map((theme) => theme.id);

  assert.equal(new Set(themeIds).size, themeIds.length);
  for (const theme of THEMES) {
    assert.equal(isThemeId(theme.id), true);
  }
  assert.equal(isThemeId("unknown"), false);
});

test("theme metadata has usable labels, details, and swatches", () => {
  const labels = THEMES.map((theme) => theme.label);
  const details = THEMES.map((theme) => theme.detail);
  const isSingleLineCopy = (value: string) => (
    value.length > 0 && value === value.trim() && !/[\r\n]/.test(value)
  );

  assert.equal(new Set(labels).size, labels.length);
  assert.equal(new Set(details).size, details.length);

  for (const theme of THEMES) {
    assert.match(theme.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.equal(isSingleLineCopy(theme.label), true);
    assert.equal(isSingleLineCopy(theme.detail), true);
    assert.ok(theme.swatches.length > 0, `${theme.id} should have at least one swatch`);
    for (const swatch of theme.swatches) {
      assert.match(swatch, /^#[0-9a-f]{6}$/i, `${theme.id} has an invalid swatch: ${swatch}`);
    }
  }
});

test("each declared theme has one CSS token block and CSS has no orphaned theme blocks", () => {
  const expectedIds = THEMES.map((theme) => theme.id);
  const actualIds = THEME_CSS_RULES.map((rule) => themeRuleId(rule.selector));

  assert.ok(actualIds.every((id): id is string => id !== null));
  assert.equal(new Set(actualIds).size, actualIds.length);
  assert.deepEqual([...actualIds].sort(), [...expectedIds].sort());

  for (const theme of THEMES) {
    const rules = THEME_CSS_RULES.filter((candidate) => themeRuleId(candidate.selector) === theme.id);
    assert.equal(rules.length, 1, `${theme.id} should have exactly one CSS block`);
    assert.match(rules[0].body, /(?:^|\n)\s*--[a-z0-9-]+\s*:/, `${theme.id} should define CSS custom properties`);
  }

  for (const rule of GLOBALS_CSS_RULES) {
    const id = themeSelectorId(rule.selector);
    if (id !== null) assert.ok(isThemeId(id), `${rule.selector} does not correspond to a declared theme`);
  }
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
