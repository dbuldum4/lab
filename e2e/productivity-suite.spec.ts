import { expect, test, type Locator, type Page } from "@playwright/test";
import { confirmMarkdownImport, openEditor, waitForAuthority } from "./helpers";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function importMarkdown(page: Page, markdown: string, confirm = false) {
  await page.locator('input[type="file"][accept*="markdown"]').setInputFiles({
    name: "productivity-suite.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(markdown),
  });
  if (confirm) await confirmMarkdownImport(page);
}

async function runSlash(page: Page, query: string) {
  await page.getByRole("textbox", { name: "lab local-only Markdown note" }).focus();
  await page.keyboard.type(`/${query}`);
  await expect(page.locator("#slash-command-palette")).toBeVisible();
  await page.keyboard.press("Enter");
}

async function appendSlash(page: Page, editor: Locator, query: string) {
  await editor.press("ControlOrMeta+End");
  await editor.press("Enter");
  await runSlash(page, query);
}

async function waitForScopedAuthority(page: Page, documentId: string, expected: string | RegExp) {
  const authorityKey = `authority:${documentId}`;
  const current = async () => page.evaluate(async (key) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("lab-private-vault");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<string | null>((resolve, reject) => {
        const transaction = database.transaction("documents", "readonly");
        const request = transaction.objectStore("documents").get(key);
        request.onsuccess = () => resolve(request.result?.snapshot?.markdown ?? null);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  }, authorityKey);

  if (typeof expected === "string") {
    await expect.poll(current, { timeout: 15_000, intervals: [50, 100, 250, 500] }).toBe(expected);
  } else {
    await expect.poll(async () => (await current()) ?? "", {
      timeout: 15_000,
      intervals: [50, 100, 250, 500],
    }).toMatch(expected);
  }
}

async function waitForSessionMetadata(
  page: Page,
  documentId: string,
  expected: Record<string, unknown>,
) {
  await expect.poll(() => page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  }, `lab.session.v1.${documentId}`), { timeout: 15_000, intervals: [50, 100, 250, 500] })
    .toEqual(expect.objectContaining(expected));
}

test("keyboard shortcuts open live stats, reading time, and the shortcut reference", async ({ page }) => {
  const editor = await openEditor(page);
  const markdown = `# Pace\n\n${Array.from({ length: 225 }, () => "word").join(" ")}`;
  await importMarkdown(page, markdown);
  await expect(editor.locator("h1")).toHaveText("Pace");

  await editor.press("ControlOrMeta+Shift+s");
  const stats = page.getByRole("region", { name: "Document statistics" });
  await expect(stats).toBeVisible();
  await expect(stats.locator(".stats-panel-item").filter({ hasText: "Words" }).locator("dd")).toHaveText("226");
  await expect(stats.locator(".stats-panel-item").filter({ hasText: "Reading time" }).locator("dd")).toHaveText("2 min");

  await page.keyboard.press("Escape");
  await editor.press("ControlOrMeta+/");
  const shortcuts = page.getByRole("region", { name: "Keyboard shortcuts" });
  await expect(shortcuts).toBeVisible();
  await expect(shortcuts).toContainText("Open sessions");
  await expect(shortcuts).toContainText("Show document stats");
});

test("automatic titles, pinning, and archive views stay in sync", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.press("ControlOrMeta+Shift+n");
  await expect(page).toHaveURL(/#session=[a-zA-Z0-9_-]+$/);

  const documentId = new URL(page.url()).hash.replace("#session=", "");
  const sessionEditor = page.getByRole("textbox", { name: "lab local-only Markdown note" });
  await expect(sessionEditor).toHaveAttribute("contenteditable", "true", { timeout: 15_000 });
  const markdown = "# Project Atlas\n\nA note whose heading supplies its session title.";
  await importMarkdown(page, markdown);
  await waitForScopedAuthority(page, documentId, markdown);
  await waitForSessionMetadata(page, documentId, {
    name: "Project Atlas",
    titleSource: "automatic",
  });

  await appendSlash(page, sessionEditor, "pin");
  await waitForSessionMetadata(page, documentId, { pinned: true });
  await runSlash(page, "archive");
  await waitForSessionMetadata(page, documentId, { pinned: true, archived: true });

  await runSlash(page, "sessions");
  await expect(page.getByTestId("session-list")).not.toContainText("Project Atlas");
  await page.keyboard.press("Escape");

  await runSlash(page, "archives");
  const archived = page.getByTestId("session-list").getByRole("option").filter({ hasText: "Project Atlas" });
  await expect(archived).toContainText("◆ Project Atlas");
});

test("hydration refreshes an existing automatic Untitled session title", async ({ page }) => {
  const markdown = "# Legacy hydration title\n\nText";
  await page.addInitScript(({ markdown: seededMarkdown, checksum }) => {
    localStorage.setItem("lab.session.v1.default", JSON.stringify({
      id: "default",
      name: "Untitled",
      titleSource: "automatic",
      pinned: false,
      archived: false,
      createdAt: 1,
      updatedAt: 1,
    }));
    // v1 snapshots authenticate Markdown only and are still accepted by the
    // migration path used by legacy local notes.
    localStorage.setItem("lab.document.v1", JSON.stringify({
      markdown: seededMarkdown,
      updatedAt: 1,
      checksum,
      version: 1,
    }));
  }, {
    markdown,
    checksum: "0e89692f0d0348386d43f104aefc25055ae79ed9df74fe82979a60ffc4945b95",
  });

  const editor = await openEditor(page);
  await expect(editor.locator("h1")).toHaveText("Legacy hydration title");
  await appendSlash(page, editor, "sessions");
  await expect(page.getByTestId("session-list")).toContainText("Legacy hydration title");
  await page.keyboard.press("Escape");
});

test("callouts and collapsible sections survive Markdown persistence and reload", async ({ page }) => {
  const editor = await openEditor(page);
  const markdown = [
    "> [!TIP]",
    "> **Keep** this portable callout.",
    "",
    "<details open>",
    "<summary>Read **more**</summary>",
    "",
    "Hidden body with a [link](https://example.com).",
    "",
    "</details>",
  ].join("\n");

  await importMarkdown(page, markdown);
  const callout = editor.locator('aside[data-type="callout"][data-callout-type="tip"]');
  const details = editor.locator('details[data-type="collapsible-section"]');
  await expect(callout).toContainText("Keep this portable callout.");
  await expect(details).toHaveAttribute("open", "");
  await waitForAuthority(page, /^> \[!TIP\][\s\S]*<details open>/);

  await page.reload();
  const reloaded = await openEditor(page);
  await expect(reloaded.locator('aside[data-type="callout"][data-callout-type="tip"]')).toContainText("Keep this portable callout.");
  const reloadedDetails = reloaded.locator('details[data-type="collapsible-section"]');
  await expect(reloadedDetails.getByText("Read more", { exact: true })).toBeVisible();
  await expect(reloadedDetails).toHaveAttribute("open", "");

  await reloadedDetails.locator("summary").click();
  await expect(reloadedDetails).not.toHaveAttribute("open", "");
  await waitForAuthority(page, /<details>\n<summary>Read \*\*more\*\*<\/summary>/);
  await page.reload();
  const closed = await openEditor(page);
  await expect(closed.locator('details[data-type="collapsible-section"]')).not.toHaveAttribute("open", "");
  await expect(closed.locator('aside[data-type="callout"]')).toHaveAttribute("data-callout-type", "tip");
});

test("table row and column commands work in place and code language round-trips", async ({ page }) => {
  const editor = await openEditor(page);
  await runSlash(page, "table");
  const table = editor.locator("table");
  await expect(table.locator("tr")).toHaveCount(3);
  await expect(table.locator("tr").first().locator("th, td")).toHaveCount(3);

  const firstCell = table.locator("tr").first().locator("th, td").first();
  await firstCell.click();
  await runSlash(page, "table-row-after");
  await expect(table.locator("tr")).toHaveCount(4);

  await table.locator("tr").first().locator("th, td").first().click();
  await runSlash(page, "table-column-after");
  await expect(table.locator("tr").first().locator("th, td")).toHaveCount(4);

  await importMarkdown(page, "```\nconst answer = 42;\n```", true);
  const code = editor.locator("pre code");
  await expect(code).toHaveText("const answer = 42;");
  await code.click();
  await editor.press("ControlOrMeta+Alt+l");
  const languages = page.getByRole("listbox", { name: "Code block language" });
  await expect(languages).toBeVisible();
  await languages.getByRole("option").filter({ hasText: "TypeScript" }).click();
  await expect(code).toHaveClass(/language-typescript/);
  await waitForAuthority(page, /^```typescript\nconst answer = 42;\n```/);

  await page.reload();
  const restored = await openEditor(page);
  await expect(restored.locator("pre code")).toHaveClass(/language-typescript/);
});

test("code language creates a code block from a paragraph", async ({ page }) => {
  const editor = await openEditor(page);
  await runSlash(page, "language");

  const code = editor.locator("pre code");
  await expect(code).toHaveCount(1);
  await expect(page.getByRole("listbox", { name: "Code block language" })).toBeVisible();
});

test("contextual slash commands explain when the selection is unavailable", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.focus();
  await page.keyboard.type("/table-row-after");

  const palette = page.getByRole("listbox", { name: "Slash commands" });
  const option = palette.getByRole("option", { name: /Table row below/ });
  await expect(option).toBeVisible();
  await expect(option).toHaveAttribute("aria-disabled", "true");
  await expect(option).toHaveAccessibleDescription("Place the caret inside a table first.");
  await expect(option).not.toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("Enter");
  await expect(palette).toBeVisible();
  await expect(editor.locator("table")).toHaveCount(0);
});

test("local session links expose backlinks and navigate in both directions", async ({ page }) => {
  const targetEditor = await openEditor(page);
  const targetMarkdown = "# Target Note\n\nThis is the link destination.";
  await importMarkdown(page, targetMarkdown);
  await waitForAuthority(page, targetMarkdown);
  await waitForSessionMetadata(page, "default", { name: "Target Note", titleSource: "automatic" });

  await targetEditor.press("ControlOrMeta+Shift+n");
  await expect(page).toHaveURL(/#session=[a-zA-Z0-9_-]+$/);
  const sourceUrl = page.url();
  const sourceId = new URL(sourceUrl).hash.replace("#session=", "");
  const sourceEditor = page.getByRole("textbox", { name: "lab local-only Markdown note" });
  await expect(sourceEditor).toHaveAttribute("contenteditable", "true", { timeout: 15_000 });
  const sourceMarkdown = "# Source Note\n\nRelated:";
  await importMarkdown(page, sourceMarkdown);
  await waitForScopedAuthority(page, sourceId, sourceMarkdown);
  await waitForSessionMetadata(page, sourceId, { name: "Source Note", titleSource: "automatic" });

  await sourceEditor.evaluate((element) => {
    const text = element.querySelector("p:last-child")?.firstChild;
    if (!text || text.nodeType !== Node.TEXT_NODE) throw new Error("Expected the Related paragraph.");
    const range = document.createRange();
    range.setStart(text, text.textContent?.length ?? 0);
    range.collapse(true);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    (element as HTMLElement).focus();
    document.dispatchEvent(new Event("selectionchange"));
  });
  await page.keyboard.type(" ");
  await runSlash(page, "link-note");
  const targetOption = page.getByRole("listbox", { name: "Choose a session to link" })
    .getByRole("option")
    .filter({ hasText: "Target Note" });
  await expect(targetOption).toBeVisible();
  await targetOption.click();

  const localLink = sourceEditor.locator('a[href="#session=default"]');
  await expect(localLink).toHaveText("Target Note");
  await waitForScopedAuthority(page, sourceId, /\[Target Note\]\(#session=default\)/);

  await localLink.click();
  await expect(page).toHaveURL(/#session=default$/);
  const destination = page.getByRole("textbox", { name: "lab local-only Markdown note" });
  await expect(destination).toHaveAttribute("contenteditable", "true", { timeout: 15_000 });
  await expect(destination).toContainText("This is the link destination.");

  await appendSlash(page, destination, "backlinks");
  const backlink = page.getByTestId("backlinks-panel").getByRole("option").filter({ hasText: "Source Note" });
  await expect(backlink).toContainText("Related: Target Note");
  await backlink.click();
  await expect(page).toHaveURL(sourceUrl);
  const returned = page.getByRole("textbox", { name: "lab local-only Markdown note" });
  await expect(returned).toHaveAttribute("contenteditable", "true", { timeout: 15_000 });
  await expect(returned).toContainText("Source Note");
});

test("version history restores an earlier snapshot and keeps the displaced draft", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.fill("Old snapshot");
  await waitForAuthority(page, "Old snapshot");
  await editor.fill("Current draft has five words");
  await waitForAuthority(page, "Current draft has five words");

  await editor.press("ControlOrMeta+Alt+h");
  const history = page.getByTestId("version-history-panel");
  await expect(history).toBeVisible();
  const oldVersion = history.getByRole("option").filter({ hasText: "2 words" });
  await expect(oldVersion).toBeVisible();
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("The current note will be kept in version history");
    await dialog.accept();
  });
  await oldVersion.click();
  await expect(editor).toHaveText("Old snapshot");
  await waitForAuthority(page, "Old snapshot");

  await editor.press("ControlOrMeta+Alt+h");
  await expect(page.getByTestId("version-history-panel").getByRole("option").filter({ hasText: "5 words" })).toBeVisible();
});

test("the external link editor updates both label and destination", async ({ page }) => {
  const editor = await openEditor(page);
  await importMarkdown(page, "Before [Old label](https://example.com/old) after");
  const link = editor.locator("a");
  await expect(link).toHaveText("Old label");
  await editor.evaluate((element) => {
    const text = element.querySelector("a")?.firstChild;
    if (!text || text.nodeType !== Node.TEXT_NODE) throw new Error("Expected link text.");
    const range = document.createRange();
    range.setStart(text, 2);
    range.collapse(true);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    (element as HTMLElement).focus();
    document.dispatchEvent(new Event("selectionchange"));
  });

  await editor.press("ControlOrMeta+Shift+k");
  const dialog = page.getByRole("dialog", { name: "Edit link" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Link text").fill("New label");
  await dialog.getByLabel("Destination").fill("https://openai.com/docs");
  await dialog.getByRole("button", { name: "Save link" }).click();

  await expect(editor.locator("a")).toHaveText("New label");
  await expect(editor.locator("a")).toHaveAttribute("href", "https://openai.com/docs");
  await waitForAuthority(page, /\[New label\]\(https:\/\/openai\.com\/docs\)/);

  await page.reload();
  const restored = await openEditor(page);
  await expect(restored.locator('a[href="https://openai.com/docs"]')).toHaveText("New label");
});

test("link editor maps its range when the note changes before the link", async ({ page }) => {
  const editor = await openEditor(page);
  await importMarkdown(page, "Before [Old label](https://example.com/old) after");
  await editor.evaluate((element) => {
    const text = element.querySelector("a")?.firstChild;
    if (!text || text.nodeType !== Node.TEXT_NODE) throw new Error("Expected link text.");
    const range = document.createRange();
    range.setStart(text, 2);
    range.collapse(true);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    (element as HTMLElement).focus();
    document.dispatchEvent(new Event("selectionchange"));
  });

  await editor.press("ControlOrMeta+Shift+k");
  const dialog = page.getByRole("dialog", { name: "Edit link" });
  await expect(dialog).toBeVisible();

  // Move the editor caret out of the link and to the document start while the
  // panel remains open. This keeps the editor editable and forces the stored
  // link range to move. Arrow keys use ProseMirror's live selection, unlike a
  // DOM-only selection change while the panel owns focus.
  for (let index = 0; index < 32; index += 1) await editor.press("ArrowLeft");
  await page.keyboard.type("Prefix ");
  await dialog.getByLabel("Link text").fill("New label");
  await dialog.getByRole("button", { name: "Save link" }).click();

  await expect(editor).toContainText("Prefix Before New label after");
  await expect(editor.locator("a")).toHaveText("New label");
  await expect(editor.locator("a")).toHaveAttribute("href", "https://example.com/old");
});

test("image alt text and title round-trip through the metadata dialog", async ({ page }) => {
  const editor = await openEditor(page);
  await page.locator('input[type="file"][accept*="image/*"]').setInputFiles({
    name: "diagram.png",
    mimeType: "image/png",
    buffer: Buffer.from(PNG_BASE64, "base64"),
  });

  const image = editor.locator("img.lab-image");
  await expect(image).toHaveAttribute("alt", "diagram");
  await image.click();
  await page.getByRole("button", { name: "Details image" }).click();

  const dialog = page.getByRole("dialog", { name: "Image metadata" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Alternative text").fill("Architecture diagram");
  await dialog.getByLabel("Title").fill("Diagram tooltip");
  await dialog.getByRole("button", { name: "Save metadata" }).click();

  await expect(image).toHaveAttribute("alt", "Architecture diagram");
  await expect(image).toHaveAttribute("title", "Diagram tooltip");
  await waitForAuthority(page, /!\[Architecture diagram\]\(data:image\/png;base64,[^)]+ "Diagram tooltip"\)/);

  await page.reload();
  const restored = await openEditor(page);
  const restoredImage = restored.locator("img.lab-image");
  await expect(restoredImage).toHaveAttribute("alt", "Architecture diagram");
  await expect(restoredImage).toHaveAttribute("title", "Diagram tooltip");
});
