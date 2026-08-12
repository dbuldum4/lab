import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { backendState, openEditor } from "./helpers";

const BROWSER_SMOKE_TAG = "@browser-smoke";

async function waitForDurableMarkdown(page: Parameters<typeof openEditor>[0], markdown: string) {
  await expect.poll(async () => {
    const state = await backendState(page);
    // Browser engines differ in optional OPFS support. The smoke contract only
    // requires one verified durable path, just as the app's fallback model does.
    return state.authority?.snapshot.markdown
      ?? state.current?.markdown
      ?? state.local?.markdown
      ?? state.opfs?.markdown
      ?? null;
  }, { timeout: 15_000, intervals: [50, 100, 250, 500] }).toBe(markdown);
}

test(`${BROWSER_SMOKE_TAG} starts and accepts editor typing`, async ({ page }) => {
  const editor = await openEditor(page);
  await editor.pressSequentially("Cross-browser typing smoke");
  await expect(editor).toHaveText("Cross-browser typing smoke");
});

test(`${BROWSER_SMOKE_TAG} hydrates while persistent-storage permission is pending`, async ({ page }) => {
  await page.addInitScript(() => {
    const state = window as typeof window & { persistencePermissionMocked?: boolean };
    const storage = navigator.storage;
    if (!storage || typeof storage.persist !== "function") return;

    try {
      // Patch the prototype because an engine may return a fresh StorageManager
      // wrapper for each navigator.storage access.
      Object.defineProperty(Object.getPrototypeOf(storage), "persist", {
        configurable: true,
        value: () => new Promise<boolean>(() => undefined),
      });
      state.persistencePermissionMocked = true;
    } catch {
      // Persistent storage is optional; the test is skipped below when an
      // engine does not expose a patchable implementation.
    }
  });

  const editor = await openEditor(page);
  const permissionMocked = await page.evaluate(() => Boolean(
    (window as typeof window & { persistencePermissionMocked?: boolean })
      .persistencePermissionMocked,
  ));
  test.skip(!permissionMocked, "Persistent-storage permission is unavailable in this browser");
  await editor.fill("Permission-independent hydration");
  await expect(editor).toHaveText("Permission-independent hydration");
});

test(`${BROWSER_SMOKE_TAG} keeps a note after a durable reload`, async ({ page }) => {
  const editor = await openEditor(page);
  const markdown = "Cross-browser persistence smoke";
  await editor.fill(markdown);
  await waitForDurableMarkdown(page, markdown);

  await page.reload();
  const reloaded = await openEditor(page);
  await expect(reloaded).toHaveText(markdown);
});

test(`${BROWSER_SMOKE_TAG} imports and exports Markdown`, async ({ page }) => {
  const editor = await openEditor(page);
  const markdown = "# Cross-browser Markdown\n\nPortable content.";
  await page.locator('input[type="file"][accept*="markdown"]').setInputFiles({
    name: "browser-smoke.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(markdown),
  });
  await expect(editor.locator("h1")).toHaveText("Cross-browser Markdown");
  await waitForDurableMarkdown(page, markdown);

  await editor.focus();
  await editor.press("ControlOrMeta+End");
  await editor.press("Enter");
  await editor.type("/export");
  await expect(page.locator("#slash-command-palette")).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.keyboard.press("Enter");
  const download = await downloadPromise;
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const exported = await readFile(downloadPath as string, "utf8");
  expect(exported).toContain("# Cross-browser Markdown");
  expect(exported).toContain("Portable content.");
});

test(`${BROWSER_SMOKE_TAG} persists a selected theme`, async ({ page }) => {
  const editor = await openEditor(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await editor.type("/theme");
  await page.keyboard.press("Enter");
  const themes = page.getByTestId("theme-list");
  await expect(themes).toBeVisible();
  await themes.getByRole("option", { name: "Light Warm neutral light theme", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("lab.theme.v1"))).toBe("light");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});
