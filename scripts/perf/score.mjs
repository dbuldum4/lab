import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { calculatePerformanceScore } from "./score-calculation.mjs";

const projectRoot = resolve(import.meta.dirname, "../..");
const resultsPath = resolve(projectRoot, process.argv[2] ?? ".perf-results/latest.ndjson");
const outputPath = resolve(projectRoot, process.argv[3] ?? ".perf-results/latest-score.json");
const baselinePath = resolve(projectRoot, "perf/score-baseline.json");

const [baseline, rawResults] = await Promise.all([
  readFile(baselinePath, "utf8").then(JSON.parse),
  readFile(resultsPath, "utf8"),
]);
const records = rawResults
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const duplicateIds = records
  .map((record) => record.id)
  .filter((id, index, ids) => ids.indexOf(id) !== index);
if (duplicateIds.length > 0) {
  console.error(`Cannot calculate the performance score. Duplicate score metrics: ${[...new Set(duplicateIds)].join(", ")}`);
  process.exit(1);
}
const latest = new Map(records.map((record) => [record.id, record]));
let calculated;
try {
  calculated = calculatePerformanceScore(baseline.metrics, latest);
} catch (error) {
  console.error(`Cannot calculate the performance score. ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const result = {
  kind: "lab.performance.score.v1",
  score: calculated.score,
  roundedScore: Math.round(calculated.score * 10) / 10,
  scale: {
    minimum: 1,
    anchoredBaseline: baseline.baselineScore,
    nearZeroGoal: 100,
  },
  formula: "clamp(1, 100, 100 - 50 * weightedMean(currentMs / baselineMs))",
  resultsPath,
  generatedAt: new Date().toISOString(),
  diagnostics: calculated.diagnostics,
};

console.log("\nLab performance index");
console.log(`Score: ${result.roundedScore.toFixed(1)} / 100  (committed baseline: ${baseline.baselineScore})`);
console.log("");
for (const item of calculated.diagnostics) {
  const change = `${item.changePercent >= 0 ? "+" : ""}${item.changePercent.toFixed(1)}%`;
  console.log(
    `${item.label.padEnd(36)} ${item.valueMs.toFixed(2).padStart(9)} ms  `
    + `${change.padStart(8)}  weight ${String(item.weight).padStart(2)}`,
  );
}
console.log(`\nSaved score: ${outputPath}`);
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
