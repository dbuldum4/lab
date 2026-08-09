import { expect, test } from "@playwright/test";

test("slash help shows the local command reference", async ({ page }) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "lab local-only Markdown note" });
  await editor.click();
  await editor.fill("/help");
  await page.keyboard.press("Enter");

  const help = page.getByTestId("help-panel");
  await expect(help).toBeVisible();
  await expect(help).toContainText("Keyboard-first local Markdown");
  await expect(help).toContainText("/sessions");
  await expect(help).toContainText("$$…$$");

  await page.keyboard.press("Escape");
  await expect(help).toBeHidden();
});
