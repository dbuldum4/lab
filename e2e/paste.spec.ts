import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

type Snapshot = {
  markdown: string;
  updatedAt: number;
  checksum: string;
  version: number;
};

type BackendState = {
  local: Snapshot | null;
  authority: { revision: number; snapshot: Snapshot } | null;
  current: Snapshot | null;
  opfs: Snapshot | null;
  opfsSupported: boolean;
};

async function openEditor(page: Page) {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "lab local-only Markdown note" });
  await expect(editor).toBeVisible();
  await expect(editor).toHaveAttribute("contenteditable", "true", { timeout: 15000 });
  return editor;
}

async function backendState(page: Page): Promise<BackendState> {
  return page.evaluate(async () => {
    const parse = (raw: string | null) => (raw ? JSON.parse(raw) as Snapshot : null);
    const local = parse(localStorage.getItem("lab.document.v1"));
    let authority: { revision: number; snapshot: Snapshot } | null = null;
    let current: Snapshot | null = null;
    try {
      const db = await new Promise<IDBDatabase | null>((resolve) => {
        const request = indexedDB.open("lab-private-vault");
        request.onerror = () => resolve(null);
        request.onsuccess = () => resolve(request.result);
      });
      if (db) {
        const state = await new Promise<{ authority: unknown; current: unknown }>((resolve, reject) => {
          const transaction = db.transaction("documents", "readonly");
          const store = transaction.objectStore("documents");
          let authorityRaw: unknown;
          let currentRaw: unknown;
          const authorityRequest = store.get("authority");
          const currentRequest = store.get("current");
          authorityRequest.onsuccess = () => { authorityRaw = authorityRequest.result; };
          currentRequest.onsuccess = () => { currentRaw = currentRequest.result; };
          transaction.oncomplete = () => resolve({ authority: authorityRaw, current: currentRaw });
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
        });
        authority = (state.authority ?? null) as typeof authority;
        current = (state.current ?? null) as Snapshot | null;
        db.close();
      }
    } catch {
      // Test records absence as null.
    }
    let opfs: Snapshot | null = null;
    let opfsSupported = false;
    try {
      const root = await navigator.storage.getDirectory();
      opfsSupported = true;
      const handle = await root.getFileHandle("lab.md.snapshot");
      opfs = JSON.parse(await (await handle.getFile()).text()) as Snapshot;
    } catch {
      // Not-found and unsupported OPFS are both represented as null.
    }
    return { local, authority, current, opfs, opfsSupported };
  });
}

async function waitForAuthority(page: Page, markdown: string) {
  await expect.poll(
    async () => (await backendState(page)).authority?.snapshot.markdown ?? null,
    { timeout: 15000, intervals: [50, 100, 250, 500] },
  ).toBe(markdown);
}

async function paste(page: Page, payload: { text: string; html?: string }) {
  await page.evaluate(({ text, html }) => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", text);
    if (html !== undefined) {
      transfer.setData("text/html", html);
    }
    document.querySelector('[contenteditable="true"]')?.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }));
  }, payload);
}

test("structured Markdown paste becomes real document structure", async ({ page }) => {
  const editor = await openEditor(page);
  const markdown = [
    "# Main Heading",
    "",
    "## Sub Heading",
    "",
    "A paragraph with [a link](https://example.com) and `inline code`.",
    "",
    "> A quoted line.",
  ].join("\n");
  await editor.click();
  await paste(page, { text: markdown });

  await expect(editor.locator("h1")).toHaveText("Main Heading");
  await expect(editor.locator("h2")).toHaveText("Sub Heading");
  await expect(editor.locator('p a[href="https://example.com"]')).toHaveText("a link");
  await expect(editor.locator("p code")).toHaveText("inline code");
  await expect(editor.locator("blockquote")).toHaveText("A quoted line.");
  await expect(editor).not.toContainText("# Main Heading");
  await expect(editor.locator("pre")).toHaveCount(0);
});

test("a bare Markdown link paste becomes a link without page errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`${error.name}: ${error.message}`));
  const editor = await openEditor(page);
  await editor.click();
  await paste(page, { text: "[docs](https://x.com)" });

  await expect(editor.locator('a[href="https://x.com"]')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("a Markdown document ending in a link is parsed without page errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`${error.name}: ${error.message}`));
  const editor = await openEditor(page);
  await editor.click();
  await paste(page, { text: "# Heading\n\nSee [docs](https://x.com)" });

  await expect(editor.locator("h1")).toHaveText("Heading");
  await expect(editor.locator('p a[href="https://x.com"]')).toHaveText("docs");
  expect(errors).toEqual([]);
});

test("a single-line paste ending in a Markdown link keeps its text and link", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`${error.name}: ${error.message}`));
  const editor = await openEditor(page);
  await editor.click();
  await paste(page, { text: "See [docs](https://x.com)" });

  await expect(editor).toContainText("See");
  await expect(editor.locator('a[href="https://x.com"]')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("pasting a URL completes a partially typed Markdown link", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`${error.name}: ${error.message}`));
  const editor = await openEditor(page);
  await editor.click();
  await editor.type("[docs](");
  await paste(page, { text: "https://x.com)" });

  await expect(editor.locator('a[href="https://x.com"]')).toHaveText("docs");
  expect(errors).toEqual([]);
});

test("GFM paste keeps task lists, nested lists, fences, strike, and tables", async ({ page }) => {
  const editor = await openEditor(page);
  const markdown = [
    "- [x] completed task",
    "- [ ] pending task",
    "",
    "- parent item",
    "  - nested child",
    "",
    "```js",
    "const answer = 42;",
    "```",
    "",
    "~~removed~~ text with [link](https://example.org)",
    "",
    "| Name | Value |",
    "| --- | --- |",
    "| alpha | 1 |",
    "| beta | 2 |",
  ].join("\n");
  await editor.click();
  await paste(page, { text: markdown });

  const tasks = editor.locator('ul[data-type="taskList"] li[data-checked]');
  await expect(tasks).toHaveCount(2);
  await expect(tasks.nth(0)).toHaveAttribute("data-checked", "true");
  await expect(tasks.nth(0)).toContainText("completed task");
  await expect(tasks.nth(1)).toHaveAttribute("data-checked", "false");

  await expect(editor.locator('ul:not([data-type="taskList"]) li > ul > li')).toHaveCount(1);
  await expect(editor.locator('ul:not([data-type="taskList"]) li > ul > li')).toContainText("nested child");

  await expect(editor.locator("pre code")).toHaveText("const answer = 42;");
  await expect(editor.locator("s")).toHaveText("removed");
  await expect(editor.locator('p a[href="https://example.org"]')).toHaveText("link");

  await expect(editor.locator("table th")).toHaveCount(2);
  await expect(editor.locator("table th").nth(0)).toHaveText("Name");
  await expect(editor.locator("table th").nth(1)).toHaveText("Value");
  await expect(editor.locator("table td").nth(0)).toHaveText("alpha");
  await expect(editor.locator("table td").nth(2)).toHaveText("beta");
});

test("rich HTML wins over Markdown-lookalike plain text", async ({ page }) => {
  const editor = await openEditor(page);
  const html = [
    "<h1>Rich Title</h1>",
    "<ul><li>one</li><li>two</li></ul>",
    "<p>Some <strong>bold</strong> and <em>italic</em> <a href=\"https://example.com\">link</a> and <code>code</code></p>",
    "<blockquote>quote</blockquote>",
  ].join("");
  const plainText = [
    "# Rich Title",
    "",
    "- one",
    "- two",
    "",
    "Some **bold** and *italic* [link](https://example.com) and `code`",
    "",
    "> quote",
  ].join("\n");
  await editor.click();
  await paste(page, { text: plainText, html });

  await expect(editor.locator("h1")).toHaveText("Rich Title");
  await expect(editor.locator("strong")).toHaveText("bold");
  await expect(editor.locator("em")).toHaveText("italic");
  await expect(editor.locator('a[href="https://example.com"]')).toHaveText("link");
  await expect(editor.locator("code")).toHaveText("code");
  await expect(editor.locator("blockquote")).toHaveText("quote");
  await expect(editor.locator("ul li")).toHaveCount(2);
  await expect(editor).not.toContainText("**bold**");
  await expect(editor).not.toContainText("# Rich Title");
});

test("Markdown wrapped in a <pre> parses as Markdown, not one code block", async ({ page }) => {
  const editor = await openEditor(page);
  const markdown = "# Wrapped Heading\n\nWrapped paragraph text.";
  const html = `<pre>${markdown}</pre>`;
  await editor.click();
  await paste(page, { text: markdown, html });

  await expect(editor.locator("h1")).toHaveText("Wrapped Heading");
  await expect(editor.locator("p")).toContainText("Wrapped paragraph text.");
  await expect(editor.locator("pre")).toHaveCount(0);
});

test("mixed Markdown and LaTeX paste normalizes delimiters and leaves fenced content alone", async ({ page }) => {
  const editor = await openEditor(page);
  const markdown = [
    "# Equations",
    "",
    "Inline \\(a^2 + b^2\\) and display:",
    "",
    "\\[",
    "\\int_0^1 x\\,dx",
    "\\]",
    "",
    "Legacy $$x^2$$ stays.",
    "",
    "```md",
    "\\(not math\\)",
    "$$",
    "not math",
    "$$",
    "```",
  ].join("\n");
  await editor.click();
  await paste(page, { text: markdown });

  const inline = editor.locator('[data-type="inline-math"]');
  await expect(inline).toHaveCount(2);
  await expect(inline.nth(0)).toHaveAttribute("data-latex", "a^2 + b^2");
  await expect(inline.nth(1)).toHaveAttribute("data-latex", "x^2");
  await expect(editor.locator('[data-type="block-math"]')).toHaveAttribute("data-latex", "\\int_0^1 x\\,dx");
  await expect(editor.locator("pre code")).toHaveText("\\(not math\\)\n$$\nnot math\n$$");
  await expect(editor.locator('[data-type="inline-math"], [data-type="block-math"]')).toHaveCount(3);
});

test("standalone LaTeX pastes become editable math; junk stays text", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.click();
  await paste(page, { text: "\\frac{a}{b}" });
  await expect(editor.locator('[data-type="inline-math"]')).toHaveAttribute("data-latex", "\\frac{a}{b}");

  await editor.press("ArrowRight");
  await editor.press("Enter");
  const equation = "\\begin{equation}\n\\int_0^1 x\\,dx\n\\end{equation}";
  await paste(page, { text: equation });
  await expect(editor.locator('[data-type="block-math"]')).toHaveAttribute("data-latex", equation);

  await editor.press("ArrowRight");
  await editor.press("Enter");
  await paste(page, { text: "\\notacommand" });
  await expect(editor.locator('[data-type="inline-math"], [data-type="block-math"]')).toHaveCount(2);
  await expect(editor).toContainText("\\notacommand");
});

test("ambiguous prose stays plain text", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.click();

  const ambiguous = [
    "$5",
    "$20.00",
    "The price is $5",
    "#hashtag",
    "-3",
    "1.2",
    "v1.2.3",
    "file_name",
    "file_name.txt",
    "_identifier_",
    "-",
    "*",
    "multi\nline_with\nunderscores",
  ];
  for (const text of ambiguous) {
    // A lone "-" or "*" followed by Enter is how users create lists, so those
    // two pastes must not be preceded by Enter or the assertion below would
    // observe a legitimately-created list.
    if (text !== "-" && text !== "*") {
      await editor.press("Enter");
    }
    await paste(page, { text });
    await expect(editor.locator("h1, h2, h3, blockquote, ul, ol, pre, [data-type=\"inline-math\"], [data-type=\"block-math\"], a")).toHaveCount(0, { timeout: 5000 });
    // The textbox's textContent concatenates paragraphs without separators,
    // so multiline expected strings must be asserted line by line.
    const lines = text.split("\n");
    for (const line of lines) {
      await expect(editor).toContainText(line);
    }
  }
});

test("code blocks receive pasted content verbatim", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.click();
  await editor.type("/code");
  await expect(page.locator("#slash-command-palette")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(editor.locator("pre")).toBeVisible();

  const payload = [
    "# Heading",
    "",
    "- item one",
    "- item two",
    "",
    "$$\nx^2\n$$",
  ].join("\n");
  await paste(page, { text: payload });
  await expect(editor.locator("pre code")).toHaveText(payload);
  await expect(editor.locator("h1, [data-type=\"inline-math\"], [data-type=\"block-math\"], ul")).toHaveCount(0);
});

test("pasting over a selection replaces only the selection", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.click();
  await editor.fill("alpha beta gamma");
  await editor.evaluate((element) => {
    const text = element.querySelector("p")?.firstChild as Text | null;
    if (!text) {
      throw new Error("expected a paragraph text node");
    }
    const range = document.createRange();
    range.setStart(text, 6);
    range.setEnd(text, 10);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    (element as HTMLElement).focus();
    document.dispatchEvent(new Event("selectionchange"));
  });
  await paste(page, { text: "# Replaced\n\nnew content" });

  await expect(editor.locator("h1")).toHaveText("Replaced");
  await expect(editor).toContainText("alpha");
  await expect(editor).toContainText("new content");
  await expect(editor).toContainText("gamma");
  await expect(editor).not.toContainText("beta");
});

test("a pasted structure undoes as a single step", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.click();
  await editor.type("original note");
  await page.waitForTimeout(600);
  await editor.press("ControlOrMeta+End");

  const markdown = "# Pasted\n\nstuff\n\n- one\n- two";
  await paste(page, { text: markdown });
  await expect(editor.locator("h1")).toHaveText("Pasted");
  await expect(editor.locator("ul li")).toHaveCount(2);

  await editor.press("ControlOrMeta+z");
  await expect(editor).toHaveText("original note");
  await expect(editor.locator("h1, ul, li")).toHaveCount(0);
});

test("pasted structure survives persistence, reload, and Markdown export", async ({ page }) => {
  const editor = await openEditor(page);
  const pasted = [
    "# Persisted Heading",
    "",
    "Text with $$e^{i\\pi}+1=0$$ inline.",
    "",
    "\\[",
    "\\int_0^1 x\\,dx",
    "\\]",
    "",
    "And a [link](https://example.com).",
  ].join("\n");
  const persisted = pasted
    .replace("\\[\n", () => "$$\n")
    .replace("\n\\]", () => "\n$$");
  await editor.click();
  await paste(page, { text: pasted });

  await expect(editor.locator("h1")).toHaveText("Persisted Heading");
  await expect(editor.locator('[data-type="inline-math"]')).toHaveAttribute("data-latex", "e^{i\\pi}+1=0");
  await expect(editor.locator('[data-type="block-math"]')).toHaveAttribute("data-latex", "\\int_0^1 x\\,dx");
  await expect(editor.locator('a[href="https://example.com"]')).toHaveText("link");

  await waitForAuthority(page, persisted);

  await page.reload();
  await openEditor(page);
  await expect(editor.locator("h1")).toHaveText("Persisted Heading");
  await expect(page.locator('[data-type="inline-math"]')).toHaveAttribute("data-latex", "e^{i\\pi}+1=0");
  await expect(page.locator('[data-type="block-math"]')).toHaveAttribute("data-latex", "\\int_0^1 x\\,dx");

  // Position the caret with End + Enter instead of clicking: a click on the
  // editor's center can land on the block-math node and open its edit dialog.
  await editor.focus();
  await editor.press("End");
  await editor.press("Enter");
  await editor.type("/export");
  await expect(page.locator("#slash-command-palette")).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.keyboard.press("Enter");
  const download = await downloadPromise;
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const exported = await readFile(downloadPath as string, "utf8");
  expect(exported).toContain("# Persisted Heading");
  expect(exported).toContain("$$e^{i\\pi}+1=0$$");
  expect(exported).toContain("$$");
});
