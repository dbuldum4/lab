import { expect, test } from "@playwright/test";

test("slash stats summarizes the current local note", async ({ page }) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "lab local-only Markdown note" });
  await editor.click();
  await editor.fill("one two three");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/stats");
  await page.keyboard.press("Enter");

  const stats = page.getByTestId("note-stats");
  await expect(stats).toBeVisible();
  await expect(stats).toContainText("3 words");
  await expect(stats).toContainText("13 characters");
  await expect(stats).toContainText("Estimated reading");
  await expect(stats).toContainText("1 local session");
  await expect(page.getByRole("status", { name: "Note statistics" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(stats).toBeHidden();
});
