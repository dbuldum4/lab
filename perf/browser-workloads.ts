import { createHash } from "node:crypto";
import type { BrowserContext, Page } from "@playwright/test";

export const LARGE_PAGE_SECTIONS = 800;
export const LARGE_STRUCTURED_PASTE_SECTIONS = 600;
export const LARGE_PLAIN_TEXT_PARAGRAPHS = 1_200;
const SNAPSHOT_UPDATED_AT = 1_750_000_000_000;
export const EDITOR_SELECTOR = '[contenteditable="true"]';

export function structuredMarkdown(label: string, sectionCount: number) {
  return Array.from({ length: sectionCount }, (_, index) => [
    `# ${label} section ${index}`,
    "",
    `## ${label} details ${index}`,
    "",
    `Paragraph ${index} with [a reference](https://example.test/${index}), **bold text**, and `
      + "`inline code` to exercise structured Markdown parsing.",
    `- first checklist item for ${index}`,
    `  - nested detail ${index}`,
    `- second checklist item for ${index}`,
    index % 5 === 0 ? `> A quoted detail for ${label} section ${index}.` : "",
    index % 7 === 0 ? [
      "```js",
      `const section = ${index};`,
      "```",
    ].join("\n") : "",
    index % 11 === 0 ? [
      "| Key | Value |",
      "| --- | ---: |",
      `| section | ${index} |`,
    ].join("\n") : "",
    `marker-${label}-${index}`,
  ].filter(Boolean).join("\n")).join("\n\n");
}

export function plainTextCorpus(label: string, paragraphCount: number) {
  return Array.from(
    { length: paragraphCount },
    (_, index) => `${label} paragraph ${index}. This is literal prose with stable words and punctuation. marker-${label}-${index}`,
  ).join("\n\n");
}

export const LARGE_PAGE_MARKDOWN = structuredMarkdown("Large-page", LARGE_PAGE_SECTIONS);
export const LARGE_STRUCTURED_PASTE = structuredMarkdown(
  "Structured-paste",
  LARGE_STRUCTURED_PASTE_SECTIONS,
);
export const LARGE_PLAIN_TEXT_PASTE = plainTextCorpus(
  "Plain-paste",
  LARGE_PLAIN_TEXT_PARAGRAPHS,
);

function snapshotChecksum(markdown: string, updatedAt: number) {
  return createHash("sha256")
    .update(JSON.stringify(["lab.snapshot.v2", updatedAt, markdown]))
    .digest("hex");
}

function snapshotRecord(markdown: string) {
  return {
    markdown,
    updatedAt: SNAPSHOT_UPDATED_AT,
    checksum: snapshotChecksum(markdown, SNAPSHOT_UPDATED_AT),
    version: 2,
  };
}

export async function installSnapshotBeforeNavigation(context: BrowserContext, markdown: string) {
  await context.addInitScript((snapshot) => {
    try {
      localStorage.setItem("lab.document.v1", JSON.stringify(snapshot));
    } catch {
      // The first opaque about:blank document has no local storage. The target origin does.
    }
  }, snapshotRecord(markdown));
}

export async function openEditor(page: Page, baseURL: string) {
  await page.goto(baseURL, { waitUntil: "domcontentloaded" });
  await page.locator(EDITOR_SELECTOR).waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(
    (selector) => document.querySelector(selector)?.getAttribute("contenteditable") === "true",
    EDITOR_SELECTOR,
    { timeout: 30_000 },
  );
}

export async function seedDefaultSnapshot(page: Page, markdown: string) {
  await page.evaluate(async (snapshot) => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem("lab.document.v1", JSON.stringify(snapshot));

    await Promise.all([
      new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase("lab-private-vault");
        request.onsuccess = () => resolve();
        request.onerror = () => resolve();
        request.onblocked = () => resolve();
      }),
      (async () => {
        try {
          const root = await navigator.storage.getDirectory();
          await root.removeEntry("lab.md.snapshot");
        } catch {
          // A missing OPFS snapshot is the required state.
        }
      })(),
    ]);
  }, snapshotRecord(markdown));
}

export async function waitForDocument(page: Page, input: {
  headingCount?: number;
  marker: string;
}) {
  return page.waitForFunction(
    ({ selector, headingCount, marker }) => {
      const editor = document.querySelector<HTMLElement>(selector);
      if (!editor || editor.getAttribute("contenteditable") !== "true") return false;
      if (headingCount !== undefined && editor.querySelectorAll("h1").length !== headingCount) return false;
      return editor.textContent?.includes(marker) === true;
    },
    { selector: EDITOR_SELECTOR, ...input },
    { timeout: 30_000, polling: "raf" },
  );
}

export async function afterStablePaint(page: Page) {
  return page.evaluate((selector) => new Promise<number>((resolve, reject) => {
    const editor = document.querySelector(selector);
    if (!editor) {
      reject(new Error("The editor is not available."));
      return;
    }
    let mutationVersion = 0;
    let observedVersion = -1;
    let quietFrames = 0;
    const observer = new MutationObserver(() => { mutationVersion += 1; });
    observer.observe(editor, { subtree: true, childList: true, characterData: true, attributes: true });
    const deadline = performance.now() + 30_000;
    const tick = () => {
      if (mutationVersion === observedVersion) quietFrames += 1;
      else quietFrames = 0;
      observedVersion = mutationVersion;
      if (quietFrames >= 2) {
        observer.disconnect();
        resolve(performance.now());
        return;
      }
      if (performance.now() >= deadline) {
        observer.disconnect();
        reject(new Error("The editor did not become stable after paint."));
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), EDITOR_SELECTOR);
}

export async function preparePersistedDocument(page: Page, baseURL: string, input: {
  markdown: string;
  headingCount?: number;
  marker: string;
}) {
  await openEditor(page, baseURL);
  await seedDefaultSnapshot(page, input.markdown);
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForDocument(page, {
    headingCount: input.headingCount,
    marker: input.marker,
  });
  await afterStablePaint(page);
}

export async function prepareLargeLoad(page: Page, baseURL: string) {
  await preparePersistedDocument(page, baseURL, {
    markdown: LARGE_PAGE_MARKDOWN,
    headingCount: LARGE_PAGE_SECTIONS,
    marker: `marker-Large-page-${LARGE_PAGE_SECTIONS - 1}`,
  });
}

/** Returns navigation-start through a stable painted editor, in milliseconds. */
export async function sampleLargeLoad(page: Page) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForDocument(page, {
    headingCount: LARGE_PAGE_SECTIONS,
    marker: `marker-Large-page-${LARGE_PAGE_SECTIONS - 1}`,
  });
  return afterStablePaint(page);
}

export async function prepareEmptyEditor(page: Page, baseURL: string) {
  await openEditor(page, baseURL);
  await page.locator(EDITOR_SELECTOR).fill("");
  await page.waitForFunction(
    (selector) => (document.querySelector(selector)?.textContent ?? "").trim() === "",
    EDITOR_SELECTOR,
    { timeout: 30_000 },
  );
  await afterStablePaint(page);
}

export async function clearEditor(page: Page) {
  const editor = page.locator(EDITOR_SELECTOR);
  await editor.focus();
  await editor.press("ControlOrMeta+A");
  await editor.press("Backspace");
  await page.waitForFunction(
    (selector) => {
      const editor = document.querySelector(selector);
      return editor !== null
        && (editor.textContent ?? "").trim() === ""
        && editor.querySelectorAll("h1, h2, table, blockquote, pre").length === 0;
    },
    EDITOR_SELECTOR,
    { timeout: 30_000, polling: "raf" },
  );
  await afterStablePaint(page);
}

async function pasteAndWait(page: Page, input: {
  text: string;
  expectedHeadingCount?: number;
  expectedParagraphCount?: number;
  marker: string;
}) {
  await clearEditor(page);
  return page.evaluate(async ({ selector, text, expectedHeadingCount, expectedParagraphCount, marker }) => {
    const editor = document.querySelector<HTMLElement>(selector);
    if (!editor) throw new Error("The editor is not available for the performance paste.");
    editor.focus();
    const transfer = new DataTransfer();
    transfer.setData("text/plain", text);
    let mutationVersion = 0;
    let observedVersion = -1;
    let quietFrames = 0;
    const observer = new MutationObserver(() => { mutationVersion += 1; });
    observer.observe(editor, { subtree: true, childList: true, characterData: true, attributes: true });
    const startedAt = performance.now();
    const dispatched = editor.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }));
    if (dispatched) {
      observer.disconnect();
      throw new Error("The editor did not handle the synthetic paste event.");
    }

    return new Promise<number>((resolve, reject) => {
      const deadline = startedAt + 30_000;
      const tick = () => {
        const contentReady = editor.textContent?.includes(marker) === true
          && (expectedHeadingCount === undefined
            || editor.querySelectorAll("h1").length === expectedHeadingCount)
          && (expectedParagraphCount === undefined
            || editor.querySelectorAll("p").length === expectedParagraphCount);
        if (contentReady && mutationVersion === observedVersion) quietFrames += 1;
        else quietFrames = 0;
        observedVersion = mutationVersion;
        if (quietFrames >= 2) {
          observer.disconnect();
          resolve(performance.now() - startedAt);
          return;
        }
        if (performance.now() >= deadline) {
          observer.disconnect();
          reject(new Error("The pasted document did not become complete and stable."));
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }, { selector: EDITOR_SELECTOR, ...input });
}

export function sampleStructuredPaste(page: Page) {
  return pasteAndWait(page, {
    text: LARGE_STRUCTURED_PASTE,
    expectedHeadingCount: LARGE_STRUCTURED_PASTE_SECTIONS,
    marker: `marker-Structured-paste-${LARGE_STRUCTURED_PASTE_SECTIONS - 1}`,
  });
}

export function samplePlainTextPaste(page: Page) {
  return pasteAndWait(page, {
    text: LARGE_PLAIN_TEXT_PASTE,
    expectedParagraphCount: LARGE_PLAIN_TEXT_PARAGRAPHS,
    marker: `marker-Plain-paste-${LARGE_PLAIN_TEXT_PARAGRAPHS - 1}`,
  });
}

export async function prepareLargeEdit(page: Page, baseURL: string) {
  await prepareLargeLoad(page, baseURL);
}

export function sampleIncrementalEdit(page: Page) {
  return page.evaluate(async ({ selector, headingCount, marker }) => {
    const editor = document.querySelector<HTMLElement>(selector);
    if (!editor) throw new Error("The editor is not available for the performance edit.");
    editor.focus();
    const selection = window.getSelection();
    if (!selection) throw new Error("The browser selection is not available.");
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);

    let mutationVersion = 0;
    let observedVersion = -1;
    let quietFrames = 0;
    const observer = new MutationObserver(() => { mutationVersion += 1; });
    observer.observe(editor, { subtree: true, childList: true, characterData: true, attributes: true });
    const previousLength = editor.textContent?.length ?? 0;
    const startedAt = performance.now();
    if (!document.execCommand("insertText", false, ".")) {
      observer.disconnect();
      throw new Error("The browser rejected the incremental edit.");
    }

    return new Promise<number>((resolve, reject) => {
      const deadline = startedAt + 10_000;
      const tick = () => {
        const contentReady = (editor.textContent?.length ?? 0) > previousLength
          && editor.querySelectorAll("h1").length === headingCount
          && editor.textContent?.includes(marker) === true;
        if (contentReady && mutationVersion === observedVersion) quietFrames += 1;
        else quietFrames = 0;
        observedVersion = mutationVersion;
        if (quietFrames >= 2) {
          observer.disconnect();
          resolve(performance.now() - startedAt);
          return;
        }
        if (performance.now() >= deadline) {
          observer.disconnect();
          reject(new Error("The incremental edit did not become stable."));
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }, {
    selector: EDITOR_SELECTOR,
    headingCount: LARGE_PAGE_SECTIONS,
    marker: `marker-Large-page-${LARGE_PAGE_SECTIONS - 1}`,
  });
}

export type BrowserScenario = {
  id: string;
  label: string;
  budgetMs: number;
  prepare: (page: Page, baseURL: string) => Promise<void>;
  sample: (page: Page) => Promise<number>;
};

export const BROWSER_SCENARIOS: BrowserScenario[] = [
  {
    id: "large-load",
    label: "load and paint an 800-section persisted page",
    budgetMs: 4_000,
    prepare: prepareLargeLoad,
    sample: sampleLargeLoad,
  },
  {
    id: "structured-paste",
    label: "paste and paint 600 structured Markdown sections",
    budgetMs: 3_500,
    prepare: prepareEmptyEditor,
    sample: sampleStructuredPaste,
  },
  {
    id: "plain-text-paste",
    label: "paste and paint 1,200 plain-text paragraphs",
    budgetMs: 2_500,
    prepare: prepareEmptyEditor,
    sample: samplePlainTextPaste,
  },
  {
    id: "incremental-edit",
    label: "edit and paint at the end of an 800-section page",
    budgetMs: 750,
    prepare: prepareLargeEdit,
    sample: sampleIncrementalEdit,
  },
];
