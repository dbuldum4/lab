import { expect, test } from "@playwright/test";

test("history restores an earlier local checkpoint and persists the restore", async ({ page }) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "lab local-only Markdown note" });

  await editor.click();
  await editor.fill("first saved version");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/history");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("history-list")).toContainText("first saved version");
  await page.keyboard.press("Escape");

  await editor.fill("second saved version");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/history");
  await page.keyboard.press("Enter");
  const history = page.getByTestId("history-list");
  await expect(history).toContainText("second saved version");
  await expect(history).toContainText("first saved version");

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(editor).toContainText("first saved version");
  await expect(page.getByRole("status")).toContainText("Restored a local history checkpoint");

  await page.waitForTimeout(300);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "lab local-only Markdown note" })).toContainText("first saved version");
});

test("clear removes history before erasing the note", async ({ page }) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "lab local-only Markdown note" });
  await editor.click();
  await editor.fill("private checkpoint");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/history");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("history-list")).toContainText("private checkpoint");
  await page.keyboard.press("Escape");

  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/clear");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(editor).toHaveText("");

  await editor.click();
  await editor.fill("/history");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("history-list")).not.toContainText("private checkpoint");
});
