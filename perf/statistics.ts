export type SampleSummary = {
  count: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  p90: number;
  p95: number;
  mad: number;
};

export function percentile(values: readonly number[], fraction: number) {
  if (values.length === 0) throw new Error("A percentile needs at least one sample.");
  if (fraction < 0 || fraction > 1) throw new Error("A percentile fraction must be from 0 through 1.");
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sorted[lowerIndex]!;
  const upper = sorted[upperIndex]!;
  return lower + (upper - lower) * (position - lowerIndex);
}

export function summarizeSamples(samples: readonly number[]): SampleSummary {
  if (samples.length === 0) throw new Error("A sample summary needs at least one sample.");
  if (samples.some((sample) => !Number.isFinite(sample) || sample < 0)) {
    throw new Error("Performance samples must be finite, non-negative numbers.");
  }
  const median = percentile(samples, 0.5);
  const absoluteDeviations = samples.map((sample) => Math.abs(sample - median));
  return {
    count: samples.length,
    min: Math.min(...samples),
    max: Math.max(...samples),
    mean: samples.reduce((total, sample) => total + sample, 0) / samples.length,
    median,
    p90: percentile(samples, 0.9),
    p95: percentile(samples, 0.95),
    mad: percentile(absoluteDeviations, 0.5),
  };
}
