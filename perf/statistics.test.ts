import assert from "node:assert/strict";
import test from "node:test";
import {
  percentile,
  summarizeSamples,
} from "./statistics.ts";

test("sample summaries interpolate percentiles and report median absolute deviation", () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  const summary = summarizeSamples([1, 2, 3, 4]);
  assert.equal(summary.count, 4);
  assert.equal(summary.min, 1);
  assert.equal(summary.max, 4);
  assert.equal(summary.mean, 2.5);
  assert.equal(summary.median, 2.5);
  assert.ok(Math.abs(summary.p90 - 3.7) < Number.EPSILON * 4);
  assert.ok(Math.abs(summary.p95 - 3.85) < Number.EPSILON * 4);
  assert.equal(summary.mad, 1);
});

test("sample summaries reject missing, negative, and non-finite observations", () => {
  assert.throws(() => summarizeSamples([]), /at least one sample/);
  assert.throws(() => summarizeSamples([1, -1]), /non-negative/);
  assert.throws(() => summarizeSamples([1, Number.NaN]), /non-negative/);
});
