import { expect, test } from "@playwright/test";
import { BROWSER_SCENARIOS } from "../perf/browser-workloads";
import { summarizeSamples } from "../perf/statistics";

const PERF_SAMPLES = Number.parseInt(process.env.LAB_PERF_SAMPLES ?? "7", 10);

if (!Number.isInteger(PERF_SAMPLES) || PERF_SAMPLES < 3) {
  throw new Error("LAB_PERF_SAMPLES must be an integer of at least 3.");
}

for (const scenario of BROWSER_SCENARIOS) {
  test(`@perf ${scenario.label} stays within its coarse regression budget`, async ({ page, baseURL }) => {
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

    const summary = summarizeSamples(samples);
    console.log(JSON.stringify({
      kind: "lab.performance.smoke.v1",
      scenario: scenario.id,
      label: scenario.label,
      samplesMs: samples,
      summary,
      budgetMs: scenario.budgetMs,
    }));
    console.log(
      `[perf:e2e] ${scenario.label}: median=${summary.median.toFixed(2)}ms `
      + `p95=${summary.p95.toFixed(2)}ms MAD=${summary.mad.toFixed(2)}ms`,
    );

    if (process.env.LAB_PERF_REPORT_ONLY !== "1") {
      expect(summary.median, `${scenario.label} exceeded its ${scenario.budgetMs}ms median budget`)
        .toBeLessThanOrEqual(scenario.budgetMs);
    }
  });
}
