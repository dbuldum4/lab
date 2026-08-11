import { expect, test } from "@playwright/test";
import {
  EDITOR_SELECTOR,
  LARGE_PAGE_SECTIONS,
  prepareLargeLoad,
} from "../perf/browser-workloads";
import {
  measureFreshContextLoad,
  measureFullDocumentScroll,
  measureLargeSelectionHistory,
  measureLastOutlineJump,
  measureTypingBurst,
  openOutline,
} from "../perf/interaction-workloads";
import { recordPerformanceMetric } from "../perf/results";
import { backendState } from "./helpers";

const PERF_SAMPLES = Number.parseInt(process.env.LAB_PERF_SAMPLES ?? "7", 10);

test("@perf-score sustained typing stays responsive across a large page", async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  if (!baseURL) throw new Error("The typing performance test needs a base URL.");
  await page.addInitScript(() => {
    (window as Window & { __LAB_E2E_SAVE_DELAY__?: number }).__LAB_E2E_SAVE_DELAY__ = 60_000;
  });
  await prepareLargeLoad(page, baseURL);

  const positions = ["start", "middle", "end"] as const;
  const closed = [];
  for (const position of positions) closed.push(await measureTypingBurst(page, position));
  const closedPaint = closed.flatMap((result) => result.keyToPaintMs);
  const closedSync = closed.flatMap((result) => result.synchronousMs);
  const closedLongTasks = closed.flatMap((result) => result.longTasksMs);
  const closedResult = recordPerformanceMetric({
    id: "typing-closed",
    label: "large-page typing from key input through paint",
    samplesMs: closedPaint,
    statistic: "p95",
    budgetMs: 100,
    details: {
      positions: positions.length,
      characters: closed.reduce((total, result) => total + result.characters, 0),
      longTasks: closedLongTasks.length,
      longestLongTaskMs: Math.max(0, ...closedLongTasks),
    },
  });
  const syncResult = recordPerformanceMetric({
    id: "typing-synchronous",
    label: "large-page synchronous typing handler work",
    samplesMs: closedSync,
    statistic: "p95",
    budgetMs: 50,
  });

  const outlineOpenMs = await openOutline(page);
  const outlineOpenResult = recordPerformanceMetric({
    id: "outline-open",
    label: "open and paint a 1,600-item outline",
    samplesMs: [outlineOpenMs],
    budgetMs: 1_500,
  });
  const withOutline = [];
  for (const position of positions) withOutline.push(await measureTypingBurst(page, position));
  const outlinePaint = withOutline.flatMap((result) => result.keyToPaintMs);
  const outlineLongTasks = withOutline.flatMap((result) => result.longTasksMs);
  const outlineTypingResult = recordPerformanceMetric({
    id: "typing-outline",
    label: "large-page typing through paint with the outline open",
    samplesMs: outlinePaint,
    statistic: "p95",
    budgetMs: 150,
    details: {
      positions: positions.length,
      characters: withOutline.reduce((total, result) => total + result.characters, 0),
      longTasks: outlineLongTasks.length,
      longestLongTaskMs: Math.max(0, ...outlineLongTasks),
    },
  });
  const outlineJumpResult = recordPerformanceMetric({
    id: "outline-jump",
    label: "jump from the outline to the last large-page heading",
    samplesMs: [await measureLastOutlineJump(page)],
    budgetMs: 750,
  });

  if (process.env.LAB_PERF_REPORT_ONLY !== "1") {
    expect(closedResult.valueMs).toBeLessThanOrEqual(100);
    expect(syncResult.valueMs).toBeLessThanOrEqual(50);
    expect(outlineOpenResult.valueMs).toBeLessThanOrEqual(1_500);
    expect(outlineTypingResult.valueMs).toBeLessThanOrEqual(150);
    expect(outlineJumpResult.valueMs).toBeLessThanOrEqual(750);
  }
});

test("@perf-score large-page scrolling keeps a stable frame cadence", async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  if (!baseURL) throw new Error("The scroll performance test needs a base URL.");
  await page.addInitScript(() => {
    (window as Window & { __LAB_E2E_SAVE_DELAY__?: number }).__LAB_E2E_SAVE_DELAY__ = 60_000;
  });
  await prepareLargeLoad(page, baseURL);
  const result = await measureFullDocumentScroll(page);
  const metric = recordPerformanceMetric({
    id: "scroll-frame",
    label: "large-page scrolling frame interval",
    samplesMs: result.frameTimesMs,
    statistic: "p95",
    budgetMs: 50,
    details: {
      frames: result.frameTimesMs.length,
      framesOver20Ms: result.framesOver20Ms,
      framesOver32Ms: result.framesOver32Ms,
      scrollDistance: result.scrollDistance,
    },
  });
  if (process.env.LAB_PERF_REPORT_ONLY !== "1") {
    expect(metric.valueMs).toBeLessThanOrEqual(50);
    expect(result.framesOver32Ms).toBeLessThanOrEqual(Math.ceil(result.frameTimesMs.length * 0.2));
  }
});

test("@perf-score large selection replacement, undo, and redo stay responsive", async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  if (!baseURL) throw new Error("The edit-operation performance test needs a base URL.");
  await page.addInitScript(() => {
    (window as Window & { __LAB_E2E_SAVE_DELAY__?: number }).__LAB_E2E_SAVE_DELAY__ = 60_000;
  });
  await prepareLargeLoad(page, baseURL);
  const result = await measureLargeSelectionHistory(page);
  const replacement = recordPerformanceMetric({
    id: "large-selection-replace",
    label: "replace one quarter of a large document",
    samplesMs: result.replacementMs,
    statistic: "p95",
    budgetMs: 3_000,
  });
  const undo = recordPerformanceMetric({
    id: "large-selection-undo",
    label: "undo a large selection replacement",
    samplesMs: result.undoMs,
    statistic: "p95",
    budgetMs: 1_500,
  });
  const redo = recordPerformanceMetric({
    id: "large-selection-redo",
    label: "redo a large selection replacement",
    samplesMs: result.redoMs,
    statistic: "p95",
    budgetMs: 1_500,
  });
  if (process.env.LAB_PERF_REPORT_ONLY !== "1") {
    expect(replacement.valueMs).toBeLessThanOrEqual(3_000);
    expect(undo.valueMs).toBeLessThanOrEqual(1_500);
    expect(redo.valueMs).toBeLessThanOrEqual(1_500);
  }
});

test("@perf-score a large page loads in fresh browser contexts", async ({ browser, baseURL }) => {
  test.setTimeout(240_000);
  if (!baseURL) throw new Error("The fresh-context performance test needs a base URL.");
  const samples: number[] = [];
  const sampleCount = Math.max(3, Math.min(PERF_SAMPLES, 5));
  for (let index = 0; index < sampleCount; index += 1) {
    samples.push(await measureFreshContextLoad(browser, baseURL));
  }
  const result = recordPerformanceMetric({
    id: "fresh-context-load",
    label: "load and paint a large page in a fresh browser context",
    samplesMs: samples,
    budgetMs: 5_000,
  });
  if (process.env.LAB_PERF_REPORT_ONLY !== "1") expect(result.valueMs).toBeLessThanOrEqual(5_000);
});

test("@perf-score a large-page edit reaches every durable replica", async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  if (!baseURL) throw new Error("The durable-save performance test needs a base URL.");
  await page.addInitScript(() => {
    (window as Window & { __LAB_E2E_SAVE_DELAY__?: number }).__LAB_E2E_SAVE_DELAY__ = 0;
  });
  await prepareLargeLoad(page, baseURL);
  const samples: number[] = [];
  for (let index = 0; index < 3; index += 1) {
    const marker = `durable-perf-${index}`;
    const startedAt = await page.evaluate(({ selector, text }) => {
      const editor = document.querySelector<HTMLElement>(selector);
      if (!editor) throw new Error("The editor is not available for the durable-save test.");
      editor.focus();
      const selection = window.getSelection();
      if (!selection) throw new Error("The browser selection is not available.");
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      const start = performance.now();
      if (!document.execCommand("insertText", false, text)) throw new Error("The durable-save edit failed.");
      return start;
    }, { selector: EDITOR_SELECTOR, text: marker });
    await expect.poll(async () => {
      const state = await backendState(page);
      return [state.local, state.authority?.snapshot, state.current, state.opfs]
        .every((snapshot) => snapshot?.markdown.includes(marker) === true);
    }, { timeout: 30_000, intervals: [10, 20, 50] }).toBe(true);
    samples.push(await page.evaluate((start) => performance.now() - start, startedAt));
  }
  const result = recordPerformanceMetric({
    id: "durable-save",
    label: "large-page edit through localStorage, IndexedDB, and OPFS",
    samplesMs: samples,
    budgetMs: 1_500,
  });
  await expect(page.locator(EDITOR_SELECTOR).locator("h1")).toHaveCount(LARGE_PAGE_SECTIONS);
  if (process.env.LAB_PERF_REPORT_ONLY !== "1") expect(result.valueMs).toBeLessThanOrEqual(1_500);
});
