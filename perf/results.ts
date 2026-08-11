import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { summarizeSamples } from "./statistics.ts";

export type PerformanceMetricRecord = {
  kind: "lab.performance.metric.v2";
  source: "browser" | "unit";
  id: string;
  label: string;
  statistic: "median" | "p95";
  valueMs: number;
  samplesMs: number[];
  summary: ReturnType<typeof summarizeSamples>;
  budgetMs?: number;
  details?: Record<string, number | string | boolean>;
};

export function recordPerformanceMetric(input: {
  id: string;
  label: string;
  samplesMs: readonly number[];
  statistic?: "median" | "p95";
  source?: "browser" | "unit";
  budgetMs?: number;
  details?: Record<string, number | string | boolean>;
}): PerformanceMetricRecord {
  const samplesMs = [...input.samplesMs];
  const summary = summarizeSamples(samplesMs);
  const statistic = input.statistic ?? "median";
  const record: PerformanceMetricRecord = {
    kind: "lab.performance.metric.v2",
    source: input.source ?? "browser",
    id: input.id,
    label: input.label,
    statistic,
    valueMs: summary[statistic],
    samplesMs,
    summary,
    budgetMs: input.budgetMs,
    details: input.details,
  };
  console.log(JSON.stringify(record));
  const otherStatistic = statistic === "median"
    ? `p95=${summary.p95.toFixed(2)}ms`
    : `median=${summary.median.toFixed(2)}ms`;
  console.log(
    `[perf:${record.source}] ${input.label}: ${statistic}=${record.valueMs.toFixed(2)}ms `
    + `${otherStatistic} MAD=${summary.mad.toFixed(2)}ms`,
  );

  const output = process.env.LAB_PERF_RESULTS_FILE;
  if (output) {
    const target = resolve(output);
    mkdirSync(dirname(target), { recursive: true });
    appendFileSync(target, `${JSON.stringify(record)}\n`, "utf8");
  }
  return record;
}
