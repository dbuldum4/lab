import { expect, test, type Page } from "@playwright/test";
import { markdownImportDialog, openEditor, waitForAuthority } from "./helpers";

async function openImport(page: Page) {
  const editor = page.getByRole("textbox", { name: "lab local-only Markdown note" });
  await editor.focus();
  await editor.press("ControlOrMeta+End");
  await editor.press("Enter");
  await editor.type("/import");
  await expect(page.locator("#slash-command-palette")).toBeVisible();
  await page.keyboard.press("Enter");
  return page.locator('input[type="file"][accept*="markdown"]');
}

async function selectMarkdown(page: Page, name: string, markdown: string) {
  const input = page.locator('input[type="file"][accept*="markdown"]');
  await input.setInputFiles({ name, mimeType: "text/markdown", buffer: Buffer.from(markdown) });
}

async function historyMarkdown(page: Page) {
  return page.evaluate(() => Object.keys(localStorage)
    .filter((key) => key.startsWith("lab.version-history.v1.entry.default."))
    .map((key) => {
      try {
        const value = JSON.parse(localStorage.getItem(key) ?? "null") as { entry?: { markdown?: unknown } };
        return typeof value.entry?.markdown === "string" ? value.entry.markdown : null;
      } catch {
        return null;
      }
    })
    .filter((markdown): markdown is string => markdown !== null)
    .sort());
}

test("nonempty Markdown import uses an accessible confirmation and cancel preserves history", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.fill("Original note");
  await waitForAuthority(page, "Original note");

  await openImport(page);
  await expect.poll(() => historyMarkdown(page)).toContain("Original note\n\n");
  const before = await historyMarkdown(page);
  await selectMarkdown(page, "replacement.md", "Replacement note");
  const dialog = markdownImportDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleName(/replacement\.md/);
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(dialog).toContainText("replacement.md");
  await expect(dialog.getByRole("button", { name: "Import file" })).toBeFocused();
  await expect(editor).toHaveAttribute("contenteditable", "false");

  const cancelButton = dialog.getByRole("button", { name: "Cancel" });
  await page.keyboard.press("Tab");
  await expect(cancelButton).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(editor).toHaveText("Original note");
  await expect(page.locator(".editor-notice-message")).toHaveText("Markdown import cancelled.");
  await expect.poll(() => historyMarkdown(page)).toEqual(before);

  // The input value is reset immediately after each selection, so selecting
  // the same path again still opens the confirmation flow.
  await selectMarkdown(page, "replacement.md", "Replacement note");
  await expect(markdownImportDialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(markdownImportDialog(page)).toBeHidden();
  await expect(editor).toHaveText("Original note");
  await expect.poll(() => historyMarkdown(page)).toEqual(before);
});

test("confirming import keeps the current note in history and focuses the editor", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.fill("Saved note");
  await waitForAuthority(page, "Saved note");
  await editor.fill("Unsaved note before import");

  await openImport(page);
  await selectMarkdown(page, "new-note.md", "Imported note");
  const dialog = markdownImportDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Import file" }).click();

  await expect(editor).toBeFocused();
  await expect(editor).toHaveText("Imported note");
  await expect(page.locator(".editor-notice-message")).toHaveText("Imported “new-note.md”.");
  await waitForAuthority(page, "Imported note");
  await expect.poll(async () => (await historyMarkdown(page))
    .some((markdown) => markdown.includes("Unsaved note before import"))).toBe(true);
});

test("import confirm ignores local session link clicks", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.press("ControlOrMeta+Shift+n");
  await expect(page).toHaveURL(/#session=[a-zA-Z0-9_-]+$/);
  const extraId = new URL(page.url()).hash.replace("#session=", "");

  await page.goto("/");
  const defaultEditor = await openEditor(page);
  await page.locator('input[type="file"][accept*="markdown"]').setInputFiles({
    name: "with-link.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(`See [extra](#session=${extraId})`),
  });
  const localLink = defaultEditor.locator(`a[href="#session=${extraId}"]`);
  await expect(localLink).toBeVisible();
  await waitForAuthority(page, new RegExp(`#session=${extraId}`));

  await openImport(page);
  await selectMarkdown(page, "replacement.md", "Imported instead");
  const dialog = markdownImportDialog(page);
  await expect(dialog).toBeVisible();
  const urlBefore = page.url();
  await localLink.click();
  await expect(dialog).toBeVisible();
  expect(page.url()).toBe(urlBefore);
  await expect(defaultEditor).toHaveAttribute("contenteditable", "false");
});

test("Markdown import is cancelled when the note changes while the file loads", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.fill("Before load");
  await waitForAuthority(page, "Before load");
  await page.evaluate(() => {
    const originalText = File.prototype.text;
    let release: (() => void) | null = null;
    (window as Window & { __releaseLabImport?: () => void }).__releaseLabImport = () => {
      release?.();
      release = null;
    };
    File.prototype.text = function delayedText(this: File) {
      return new Promise<string>((resolve, reject) => {
        release = () => {
          void originalText.call(this).then(resolve, reject);
        };
      });
    };
  });
  await openImport(page);
  await selectMarkdown(page, "delayed.md", "Should not replace the edited note");

  await editor.fill("Changed while loading");
  await page.evaluate(() => (window as Window & { __releaseLabImport?: () => void }).__releaseLabImport?.());

  await expect(editor).toHaveText("Changed while loading");
  await expect(page.locator(".editor-notice-message")).toHaveText("The note changed while the file was loading. Import was cancelled.");
  await expect(markdownImportDialog(page)).toBeHidden();
});
