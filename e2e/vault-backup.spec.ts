import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { openEditor, waitForAuthority } from "./helpers";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function pngFile(name = "backup.png") {
  return {
    name,
    mimeType: "image/png",
    buffer: Buffer.from(PNG_BASE64, "base64"),
  };
}

async function saveScopedNote(page: import("@playwright/test").Page, id: string, expectedText: string) {
  await expect.poll(() => page.evaluate((scopedKey) => {
    return JSON.parse(localStorage.getItem(scopedKey) ?? "null")?.markdown ?? null;
  }, `lab.document.v2.${id}`), { timeout: 15000 }).toContain(expectedText);
}

test("backs up every session and restores Markdown plus embedded images", async ({ browser, page }) => {
  const editor = await openEditor(page);
  await editor.fill("Original vault note");
  await page.locator('input[type="file"][accept*="image/*"]').setInputFiles(pngFile("original.png"));
  await expect(editor.locator("img.lab-image")).toBeVisible();
  await waitForAuthority(page, /Original vault note[\s\S]*data:image\/png/);

  await editor.press("End");
  await editor.press("Enter");
  await editor.type("/new");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#session=[a-zA-Z0-9_-]+$/);
  const childId = new URL(page.url()).hash.slice("#session=".length);
  const childEditor = page.getByRole("textbox", { name: "lab local-only Markdown note" });
  await expect(childEditor).toHaveAttribute("contenteditable", "true", { timeout: 15000 });
  await childEditor.fill("Research vault note");
  await page.locator('input[type="file"][accept*="image/*"]').setInputFiles(pngFile("research.png"));
  await expect(childEditor.locator("img.lab-image")).toBeVisible();
  await saveScopedNote(page, childId, "Research vault note");

  await childEditor.press("End");
  await childEditor.press("Enter");
  await childEditor.type("/name");
  await page.keyboard.press("Enter");
  const nameInput = page.getByLabel("Session name");
  await nameInput.fill("Research");
  await nameInput.press("Enter");
  await expect(nameInput).toBeHidden();

  await childEditor.press("End");
  await childEditor.press("Enter");
  await childEditor.type("/backup");
  await expect(page.locator("#slash-command-palette")).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.keyboard.press("Enter");
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("lab-vault-backup.json");
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const payload = JSON.parse(await readFile(downloadPath as string, "utf8")) as {
    sessions: Array<{ id: string; name: string; markdown: string }>;
    assets: Array<{ dataUrl: string }>;
    counts: { sessions: number; assets: number };
  };
  expect(payload.counts.sessions).toBe(2);
  expect(payload.sessions).toHaveLength(2);
  expect(payload.sessions.some((session) => session.name === "Research")).toBe(true);
  expect(payload.counts.assets).toBe(1);
  expect(payload.assets).toHaveLength(1);
  expect(payload.sessions.every((session) => session.markdown.includes("lab-asset://"))).toBe(true);

  const restoredContext = await browser.newContext();
  const restoredPage = await restoredContext.newPage();
  try {
    const restoredEditor = await openEditor(restoredPage);
    restoredPage.on("dialog", (dialog) => void dialog.accept());
    await restoredEditor.type("/restore");
    await expect(restoredPage.locator("#slash-command-palette")).toBeVisible();
    await restoredPage.keyboard.press("Enter");
    await restoredPage.locator('input[type="file"][accept*="application/json"]').setInputFiles({
      name: "lab-vault-backup.json",
      mimeType: "application/json",
      buffer: await readFile(downloadPath as string),
    });
    await expect(restoredPage.getByTestId("confirm-restore-vault")).toBeVisible();
    await restoredPage.getByTestId("confirm-restore-vault").getByRole("button", { name: "Restore backup" }).click();

    await expect.poll(() => restoredPage.getByRole("textbox", { name: "lab local-only Markdown note" }).textContent(), { timeout: 15000 }).toContain("Original vault note");
    await expect(restoredPage.locator("img.lab-image")).toBeVisible();

    const restoredDefault = restoredPage.getByRole("textbox", { name: "lab local-only Markdown note" });
    await restoredDefault.press("End");
    await restoredDefault.press("Enter");
    await restoredDefault.type("/sessions");
    await restoredPage.keyboard.press("Enter");
    const sessionList = restoredPage.getByTestId("session-list");
    await expect(sessionList).toContainText("Research");
    await sessionList.getByText("Research", { exact: true }).click();
    const restoredChild = restoredPage.getByRole("textbox", { name: "lab local-only Markdown note" });
    await expect(restoredChild).toHaveAttribute("contenteditable", "true", { timeout: 15000 });
    await expect(restoredChild).toContainText("Research vault note");
    await expect(restoredChild.locator("img.lab-image")).toBeVisible();
  } finally {
    await restoredContext.close();
  }
});

test("rejects malformed backups and keeps conflicting sessions untouched", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.fill("keep the current vault");
  await waitForAuthority(page, "keep the current vault");

  const malformed = JSON.stringify({
    format: "lab-local-vault",
    version: 1,
    exportedAt: Date.now(),
    counts: { sessions: 1, assets: 0 },
    sessions: [{ id: "default", name: "Untitled", createdAt: 0, updatedAt: 0, markdown: "missing" }],
    assets: [],
  });
  await editor.press("End");
  await editor.press("Enter");
  await editor.type("/restore");
  await page.keyboard.press("Enter");
  await page.locator('input[type="file"][accept*="application/json"]').setInputFiles({
    name: "partial.json",
    mimeType: "application/json",
    buffer: Buffer.from(malformed.slice(0, -5)),
  });
  await expect(page.getByRole("status").filter({ hasText: "Invalid Lab vault backup" })).toBeVisible();
  await expect(editor).toContainText("keep the current vault");

  const conflict = JSON.stringify({
    format: "lab-local-vault",
    version: 1,
    exportedAt: Date.now(),
    counts: { sessions: 1, assets: 0 },
    sessions: [{ id: "default", name: "Untitled", createdAt: 0, updatedAt: 0, markdown: "backup copy" }],
    assets: [],
  });
  await editor.press("End");
  await editor.press("Enter");
  await editor.type("/restore");
  await page.keyboard.press("Enter");
  await page.locator('input[type="file"][accept*="application/json"]').setInputFiles({
    name: "conflict.json",
    mimeType: "application/json",
    buffer: Buffer.from(conflict),
  });
  await expect(page.getByTestId("confirm-restore-vault")).toBeVisible();
  await page.getByTestId("confirm-restore-vault").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("confirm-restore-vault")).toBeHidden();
  await expect(editor).toContainText("keep the current vault");
  await page.locator('input[type="file"][accept*="application/json"]').setInputFiles({
    name: "conflict.json",
    mimeType: "application/json",
    buffer: Buffer.from(conflict),
  });
  await expect(page.getByTestId("confirm-restore-vault")).toBeVisible();
  await page.getByTestId("confirm-restore-vault").getByRole("button", { name: "Restore backup" }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("lab.document.v1") ?? "null")?.markdown ?? null), { timeout: 15000 }).toContain("keep the current vault");
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("lab.session.v1.")).length), { timeout: 15000 }).toBe(2);
});
