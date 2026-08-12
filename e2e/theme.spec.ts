import { expect, test } from "@playwright/test";
import { openEditor } from "./helpers";

test("the theme submenu keeps dark as the default and saves a new choice", async ({ page }) => {
  const editor = await openEditor(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await editor.type("/theme");
  await page.keyboard.press("Enter");

  const themes = page.getByTestId("theme-list");
  await expect(themes).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Search themes" })).toBeFocused();
  await expect(themes.getByRole("option")).toHaveCount(21);
  await expect(themes.getByRole("option", { name: /Dark.*Current/ })).toHaveAttribute("aria-current", "true");

  await themes.getByRole("option", { name: "Light Warm neutral light theme", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("lab.theme.v1"))).toBe("light");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(251, 251, 250)");
});

test("the theme submenu filters themes while keeping keyboard selection", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.type("/theme");
  await page.keyboard.press("Enter");

  const search = page.getByRole("combobox", { name: "Search themes" });
  await search.fill("gruvbox");
  const themes = page.getByTestId("theme-list");
  await expect(themes.getByRole("option")).toHaveCount(2);
  await expect(themes.getByRole("option", { name: /Gruvbox Dark/ })).toBeVisible();
  await expect(themes.getByRole("option", { name: /Gruvbox Light/ })).toBeVisible();

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "gruvbox-light");
});

test("theme search ignores accents", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.type("/theme");
  await page.keyboard.press("Enter");

  await page.getByRole("combobox", { name: "Search themes" }).fill("rose");
  const options = page.getByTestId("theme-list").getByRole("option");
  await expect(options).toHaveCount(1);
  await expect(options.first()).toHaveAccessibleName(/Rosé Pine Dawn/);
});

test("the deployed notice page contains attribution and a non-endorsement statement", async ({ page }) => {
  await page.goto("/third-party-notices/");
  await expect(page.getByRole("heading", { name: "Third-party theme notices" })).toBeVisible();
  await expect(page.getByText("Copyright (c) 2023 Steph Ango", { exact: false })).toBeVisible();
  await expect(page.getByText("not affiliated with or endorsed", { exact: false })).toBeVisible();
});

test("the theme submenu supports keyboard selection", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.type("/theme");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("theme-list")).toBeVisible();

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");

  await expect(page.locator("html")).toHaveAttribute("data-theme", "dracula");
  await expect(editor).toBeFocused();
});
