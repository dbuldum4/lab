import assert from "node:assert/strict";
import test from "node:test";
import {
  calculatePerformanceScore,
  latencyRatio,
} from "../scripts/perf/score-calculation.mjs";

const metrics = [
  { id: "typing", label: "Typing", weight: 60, baselineMs: 20 },
  { id: "load", label: "Load", weight: 40, baselineMs: 1_000 },
];

test("the committed baseline is exactly 50 and near-zero latency approaches 100", () => {
  const baseline = new Map([
    ["typing", { valueMs: 20 }],
    ["load", { valueMs: 1_000 }],
  ]);
  const zero = new Map([
    ["typing", { valueMs: 0 }],
    ["load", { valueMs: 0 }],
  ]);
  assert.equal(calculatePerformanceScore(metrics, baseline).score, 50);
  assert.equal(calculatePerformanceScore(metrics, zero).score, 100);
});

test("the aggregate score is bounded and missing metrics fail closed", () => {
  assert.equal(latencyRatio(40, 20), 2);
  assert.equal(latencyRatio(0, 20), 0);
  const verySlow = new Map([
    ["typing", { valueMs: 2_000 }],
    ["load", { valueMs: 100_000 }],
  ]);
  assert.equal(calculatePerformanceScore(metrics, verySlow).score, 1);
  assert.throws(
    () => calculatePerformanceScore(metrics, new Map([["typing", { valueMs: 20 }]])),
    /Missing score metrics: load/,
  );
  assert.throws(
    () => calculatePerformanceScore(metrics, new Map([
      ["typing", { valueMs: 20 }],
      ["load", { valueMs: 1_000 }],
      ["new-metric", { valueMs: 10 }],
    ])),
    /Unweighted score metrics: new-metric/,
  );
});
