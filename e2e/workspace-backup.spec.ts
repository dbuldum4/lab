import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test("backup downloads every local session in a versioned JSON bundle", async ({ page }) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "lab local-only Markdown note" });
  await editor.click();
  await editor.fill("workspace backup content");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/backup");

  const downloadPromise = page.waitForEvent("download");
  await page.keyboard.press("Enter");
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("lab-workspace.json");
  const path = await download.path();
  expect(path).not.toBeNull();
  const bundle = JSON.parse(await readFile(path!, "utf8"));
  expect(bundle.format).toBe("lab-workspace");
  expect(bundle.version).toBe(1);
  expect(bundle.documents.some((document: { markdown: string }) => document.markdown.includes("workspace backup content"))).toBe(true);
});

test("restore merges documents as new local sessions", async ({ page }) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "lab local-only Markdown note" });
  await editor.click();
  await editor.fill("/restore");
  await page.keyboard.press("Enter");

  await page.getByTestId("workspace-restore-input").setInputFiles({
    name: "workspace.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      format: "lab-workspace",
      version: 1,
      exportedAt: Date.now(),
      documents: [{ name: "Imported", createdAt: 1, updatedAt: 2, markdown: "# Restored content" }],
    })),
  });

  await expect(page.getByRole("status")).toContainText("Restored 1 session");
  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/sessions");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("session-list")).toContainText("Restored Imported");
});
