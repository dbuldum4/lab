import { expect, test } from "@playwright/test";
import { BROWSER_SCENARIOS } from "../perf/browser-workloads";
import { recordPerformanceMetric } from "../perf/results";

const PERF_SAMPLES = Number.parseInt(process.env.LAB_PERF_SAMPLES ?? "7", 10);

if (!Number.isInteger(PERF_SAMPLES) || PERF_SAMPLES < 3) {
  throw new Error("LAB_PERF_SAMPLES must be an integer of at least 3.");
}

for (const scenario of BROWSER_SCENARIOS) {
  test(`@perf-score ${scenario.label} stays within its coarse regression budget`, async ({ page, baseURL }) => {
    test.setTimeout(240_000);
    if (!baseURL) throw new Error("The performance test needs a base URL.");
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.addInitScript(() => {
      (window as Window & { __LAB_E2E_SAVE_DELAY__?: number }).__LAB_E2E_SAVE_DELAY__ = 60_000;
    });

    await scenario.prepare(page, baseURL);
    await scenario.sample(page); // Warm the parser, editor, and rendering path.

    const samples: number[] = [];
    for (let index = 0; index < PERF_SAMPLES; index += 1) {
      samples.push(await scenario.sample(page));
    }

    const result = recordPerformanceMetric({
      id: scenario.id,
      label: scenario.label,
      samplesMs: samples,
      budgetMs: scenario.budgetMs,
    });

    if (process.env.LAB_PERF_REPORT_ONLY !== "1") {
      expect(result.valueMs, `${scenario.label} exceeded its ${scenario.budgetMs}ms median budget`)
        .toBeLessThanOrEqual(scenario.budgetMs);
    }
  });
}
