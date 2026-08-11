import { expect, test } from "@playwright/test";
import {
  clearEditor,
  prepareEmptyEditor,
  sampleStructuredPaste,
} from "../perf/browser-workloads";
import { ALTERNATE_DOCUMENT_SHAPES } from "../perf/document-shapes";
import {
  collectMemoryMetrics,
  measureFreshDocumentContextLoad,
} from "../perf/interaction-workloads";
import { recordPerformanceMetric } from "../perf/results";
import { summarizeSamples } from "../perf/statistics";

test("@perf-extended alternate large-document shapes load and paint", async ({ browser, baseURL }) => {
  test.setTimeout(600_000);
  if (!baseURL) throw new Error("The alternate-shape performance test needs a base URL.");
  for (const shape of ALTERNATE_DOCUMENT_SHAPES) {
    const samples: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      samples.push(await measureFreshDocumentContextLoad(browser, baseURL, shape));
    }
    const result = recordPerformanceMetric({
      id: `shape-${shape.id}`,
      label: `load and paint ${shape.label}`,
      samplesMs: samples,
      budgetMs: shape.budgetMs,
      details: {
        sourceBytes: Buffer.byteLength(shape.markdown),
        sourceLines: shape.markdown.split("\n").length,
      },
    });
    if (process.env.LAB_PERF_REPORT_ONLY !== "1") {
      expect(result.valueMs).toBeLessThanOrEqual(shape.budgetMs);
    }
  }
});

test("@perf-extended repeated large pastes do not degrade or retain the old document", async ({ page, baseURL }) => {
  test.setTimeout(600_000);
  if (!baseURL) throw new Error("The endurance performance test needs a base URL.");
  await page.addInitScript(() => {
    (window as Window & { __LAB_E2E_SAVE_DELAY__?: number }).__LAB_E2E_SAVE_DELAY__ = 60_000;
  });
  await prepareEmptyEditor(page, baseURL);
  const before = await collectMemoryMetrics(page);
  const samples: number[] = [];
  for (let index = 0; index < 12; index += 1) samples.push(await sampleStructuredPaste(page));
  await clearEditor(page);
  const after = await collectMemoryMetrics(page);
  const first = summarizeSamples(samples.slice(0, 4));
  const last = summarizeSamples(samples.slice(-4));
  const heapGrowthBytes = after.heapUsedBytes - before.heapUsedBytes;
  const nodeGrowth = after.nodes - before.nodes;
  const result = recordPerformanceMetric({
    id: "paste-endurance",
    label: "12 repeated structured paste and clear cycles",
    samplesMs: samples,
    statistic: "p95",
    budgetMs: 4_000,
    details: {
      firstMedianMs: first.median,
      lastMedianMs: last.median,
      slowdownRatio: last.median / first.median,
      heapGrowthBytes,
      nodeGrowth,
      eventListenerGrowth: after.eventListeners - before.eventListeners,
    },
  });
  if (process.env.LAB_PERF_REPORT_ONLY !== "1") {
    expect(result.valueMs).toBeLessThanOrEqual(4_000);
    expect(last.median).toBeLessThanOrEqual(first.median * 2 + 50);
    expect(heapGrowthBytes).toBeLessThanOrEqual(100 * 1024 * 1024);
    expect(nodeGrowth).toBeLessThanOrEqual(10_000);
  }
});
