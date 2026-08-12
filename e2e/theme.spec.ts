import { expect, test } from "@playwright/test";
import { openEditor } from "./helpers";

test("the theme submenu keeps dark as the default and saves a new choice", async ({ page }) => {
  const editor = await openEditor(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await editor.type("/theme");
  await page.keyboard.press("Enter");

  const themes = page.getByTestId("theme-list");
  await expect(themes).toBeVisible();
  await expect(themes.getByRole("option")).toHaveCount(6);
  await expect(themes.getByRole("option", { name: /Dark.*Current/ })).toHaveAttribute("aria-current", "true");

  await themes.getByRole("option", { name: /Light/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("lab.theme.v1"))).toBe("light");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(251, 251, 250)");
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
