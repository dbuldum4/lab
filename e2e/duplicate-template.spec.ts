import { expect, test } from "@playwright/test";

test("duplicate creates a new session with the current Markdown", async ({ page }) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "lab local-only Markdown note" });
  await editor.click();
  await editor.fill("copy me exactly");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/duplicate");
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/#session=/);
  await expect(page.getByRole("textbox", { name: "lab local-only Markdown note" })).toContainText("copy me exactly");
});

test("template creates a seeded daily-note session", async ({ page }) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "lab local-only Markdown note" });
  await editor.click();
  await editor.fill("/template");
  await page.keyboard.press("Enter");

  const templates = page.getByTestId("template-list");
  await expect(templates).toBeVisible();
  await expect(templates).toContainText("Daily note");
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/#session=/);
  const seeded = page.getByRole("textbox", { name: "lab local-only Markdown note" });
  await expect(seeded).toContainText("Daily note");
  await expect(seeded).toContainText("Focus");
});
