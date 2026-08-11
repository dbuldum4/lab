import type { Browser, Page } from "@playwright/test";
import {
  afterStablePaint,
  EDITOR_SELECTOR,
  installSnapshotBeforeNavigation,
  LARGE_PAGE_MARKDOWN,
  LARGE_PAGE_SECTIONS,
  waitForDocument,
} from "./browser-workloads";

export type TypingBurstResult = {
  position: "start" | "middle" | "end";
  characters: number;
  insertedCharacters: number;
  synchronousMs: number[];
  keyToPaintMs: number[];
  longTasksMs: number[];
};

export function measureTypingBurst(
  page: Page,
  position: TypingBurstResult["position"],
  characters = 36,
): Promise<TypingBurstResult> {
  return page.evaluate(async ({ selector, position, characters }) => {
    const editor = document.querySelector<HTMLElement>(selector);
    if (!editor) throw new Error("The editor is not available for the typing benchmark.");
    const paragraphs = Array.from(editor.querySelectorAll<HTMLElement>("p"))
      .filter((paragraph) => (paragraph.textContent?.length ?? 0) >= 4);
    if (paragraphs.length < 3) throw new Error("The typing benchmark needs at least three paragraphs.");
    const paragraph = position === "start"
      ? paragraphs[0]!
      : position === "middle"
        ? paragraphs[Math.floor(paragraphs.length / 2)]!
        : paragraphs.at(-1)!;
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode as Text);
    const textNode = position === "end" ? textNodes.at(-1) : textNodes[0];
    if (!textNode) throw new Error("The target paragraph has no text node.");
    const offset = position === "start"
      ? 0
      : position === "middle"
        ? Math.floor(textNode.data.length / 2)
        : textNode.data.length;
    const selection = window.getSelection();
    if (!selection) throw new Error("The browser selection is not available.");
    editor.focus();
    const range = document.createRange();
    range.setStart(textNode, offset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    const synchronousMs: number[] = [];
    const keyToPaintMs: number[] = [];
    const longTasksMs: number[] = [];
    const observer = typeof PerformanceObserver !== "undefined"
      && PerformanceObserver.supportedEntryTypes.includes("longtask")
      ? new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longTasksMs.push(entry.duration);
      })
      : null;
    observer?.observe({ type: "longtask", buffered: false });
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    const previousLength = editor.textContent?.length ?? 0;

    for (let index = 0; index < characters; index += 1) {
      const startedAt = performance.now();
      if (!document.execCommand("insertText", false, alphabet[index % alphabet.length]!)) {
        observer?.disconnect();
        throw new Error("The browser rejected a typing benchmark edit.");
      }
      synchronousMs.push(performance.now() - startedAt);
      const paintedAt = await new Promise<number>((resolve) => {
        requestAnimationFrame(() => setTimeout(() => resolve(performance.now()), 0));
      });
      keyToPaintMs.push(paintedAt - startedAt);
    }

    for (const entry of observer?.takeRecords() ?? []) longTasksMs.push(entry.duration);
    observer?.disconnect();
    const insertedCharacters = (editor.textContent?.length ?? 0) - previousLength;
    const expectedText = alphabet.slice(0, characters);
    if (editor.textContent?.includes(expectedText) !== true) {
      throw new Error(`The ${position} typing benchmark did not retain its ${characters}-character sequence.`);
    }
    return { position, characters, insertedCharacters, synchronousMs, keyToPaintMs, longTasksMs };
  }, { selector: EDITOR_SELECTOR, position, characters });
}

export async function openOutline(page: Page) {
  const editor = page.locator(EDITOR_SELECTOR);
  const startedAt = await page.evaluate(() => performance.now());
  await editor.press("ControlOrMeta+Shift+o");
  await page.getByTestId("document-outline").waitFor({ state: "visible", timeout: 30_000 });
  const elapsed = await page.evaluate(async (start) => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return performance.now() - start;
  }, startedAt);
  const itemCount = await page.getByTestId("document-outline").locator(".outline-item").count();
  if (itemCount !== LARGE_PAGE_SECTIONS * 2) {
    throw new Error(`The large-page outline has ${itemCount} items instead of ${LARGE_PAGE_SECTIONS * 2}.`);
  }
  return elapsed;
}

export async function measureLastOutlineJump(page: Page) {
  const outline = page.getByTestId("document-outline");
  const last = outline.locator(".outline-item").last();
  const startedAt = await page.evaluate(() => performance.now());
  await last.click();
  await page.waitForFunction(() => window.scrollY > document.documentElement.scrollHeight * 0.7, undefined, {
    timeout: 30_000,
    polling: "raf",
  });
  return page.evaluate(async (start) => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return performance.now() - start;
  }, startedAt);
}

export function measureFullDocumentScroll(page: Page, frameCount = 120) {
  return page.evaluate(async ({ frames, selector }) => {
    const editor = document.querySelector(selector);
    if (!editor) throw new Error("The editor is not available for the scroll benchmark.");
    window.scrollTo(0, 0);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const maximum = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    if (maximum < window.innerHeight) throw new Error("The scroll benchmark document is not long enough.");
    const frameTimes: number[] = [];
    let previous = performance.now();
    for (let index = 1; index <= frames; index += 1) {
      const timestamp = await new Promise<number>((resolve) => requestAnimationFrame(resolve));
      frameTimes.push(timestamp - previous);
      previous = timestamp;
      window.scrollTo(0, maximum * (index / frames));
      // Read one layout value so the result includes scroll-linked editor work.
      void editor.getBoundingClientRect().top;
    }
    return {
      frameTimesMs: frameTimes.slice(1),
      framesOver20Ms: frameTimes.slice(1).filter((duration) => duration > 20).length,
      framesOver32Ms: frameTimes.slice(1).filter((duration) => duration > 32).length,
      scrollDistance: maximum,
    };
  }, { frames: frameCount, selector: EDITOR_SELECTOR });
}

async function finishKeyboardAction(page: Page, startedAt: number, input: {
  markerPresent: boolean;
  headingCount?: number;
}) {
  await page.waitForFunction(
    ({ selector, markerPresent, headingCount }) => {
      const editor = document.querySelector<HTMLElement>(selector);
      if (!editor) return false;
      const hasMarker = editor.textContent?.includes("large-replacement-marker") === true;
      return hasMarker === markerPresent
        && (headingCount === undefined || editor.querySelectorAll("h1").length === headingCount);
    },
    { selector: EDITOR_SELECTOR, ...input },
    { timeout: 30_000, polling: "raf" },
  );
  return page.evaluate(async (start) => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return performance.now() - start;
  }, startedAt);
}

async function replaceLargeSelection(page: Page) {
  return page.evaluate(async ({ selector, marker }) => {
    const editor = document.querySelector<HTMLElement>(selector);
    if (!editor) throw new Error("The editor is not available for the selection benchmark.");
    const blocks = Array.from(editor.children);
    if (blocks.length < 100) throw new Error("The selection benchmark document is too small.");
    const selection = window.getSelection();
    if (!selection) throw new Error("The browser selection is not available.");
    const range = document.createRange();
    range.setStartBefore(blocks[0]!);
    range.setEndAfter(blocks[Math.floor(blocks.length / 4)]!);
    selection.removeAllRanges();
    selection.addRange(range);
    editor.focus();
    const startedAt = performance.now();
    if (!document.execCommand("insertText", false, marker)) {
      throw new Error("The browser rejected the large selection replacement.");
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return performance.now() - startedAt;
  }, { selector: EDITOR_SELECTOR, marker: "large-replacement-marker" });
}

export async function measureLargeSelectionHistory(page: Page, cycles = 3) {
  const replacementMs: number[] = [];
  const undoMs: number[] = [];
  const redoMs: number[] = [];
  for (let index = 0; index < cycles; index += 1) {
    replacementMs.push(await replaceLargeSelection(page));

    let startedAt = await page.evaluate(() => performance.now());
    await page.keyboard.press("ControlOrMeta+z");
    undoMs.push(await finishKeyboardAction(page, startedAt, {
      markerPresent: false,
      headingCount: LARGE_PAGE_SECTIONS,
    }));

    startedAt = await page.evaluate(() => performance.now());
    await page.keyboard.press("ControlOrMeta+Shift+z");
    redoMs.push(await finishKeyboardAction(page, startedAt, { markerPresent: true }));

    startedAt = await page.evaluate(() => performance.now());
    await page.keyboard.press("ControlOrMeta+z");
    await finishKeyboardAction(page, startedAt, {
      markerPresent: false,
      headingCount: LARGE_PAGE_SECTIONS,
    });
  }
  return { replacementMs, undoMs, redoMs };
}

export async function measureFreshDocumentContextLoad(browser: Browser, baseURL: string, input: {
  markdown: string;
  headingCount?: number;
  marker: string;
}) {
  const context = await browser.newContext({
    colorScheme: "light",
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { width: 1280, height: 720 },
  });
  try {
    await context.addInitScript(() => {
      (window as Window & { __LAB_E2E_SAVE_DELAY__?: number }).__LAB_E2E_SAVE_DELAY__ = 60_000;
    });
    await installSnapshotBeforeNavigation(context, input.markdown);
    const page = await context.newPage();
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.goto(baseURL, { waitUntil: "domcontentloaded" });
    await waitForDocument(page, {
      headingCount: input.headingCount,
      marker: input.marker,
    });
    return await afterStablePaint(page);
  } finally {
    await context.close();
  }
}

export function measureFreshContextLoad(browser: Browser, baseURL: string) {
  return measureFreshDocumentContextLoad(browser, baseURL, {
    markdown: LARGE_PAGE_MARKDOWN,
    headingCount: LARGE_PAGE_SECTIONS,
    marker: `marker-Large-page-${LARGE_PAGE_SECTIONS - 1}`,
  });
}

export async function collectMemoryMetrics(page: Page) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("HeapProfiler.collectGarbage");
    const [heap, dom] = await Promise.all([
      session.send("Runtime.getHeapUsage"),
      session.send("Memory.getDOMCounters"),
    ]);
    return {
      heapUsedBytes: heap.usedSize,
      heapAllocatedBytes: heap.totalSize,
      documents: dom.documents,
      nodes: dom.nodes,
      eventListeners: dom.jsEventListeners,
    };
  } finally {
    await session.detach();
  }
}
