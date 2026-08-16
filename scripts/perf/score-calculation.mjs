export function scoreMeetsFloor(score, floor) {
  if (!Number.isFinite(score) || !Number.isFinite(floor)) {
    throw new Error("A score floor comparison requires finite numbers.");
  }
  return score >= floor;
}

export function latencyRatio(valueMs, baselineMs) {
  if (!Number.isFinite(valueMs) || valueMs < 0) throw new Error("A score value must be finite and non-negative.");
  if (!Number.isFinite(baselineMs) || baselineMs <= 0) throw new Error("A score baseline must be positive.");
  return valueMs / baselineMs;
}

export function calculatePerformanceScore(metrics, latest) {
  const weightTotal = metrics.reduce((total, metric) => total + metric.weight, 0);
  if (weightTotal !== 100) throw new Error(`Performance score weights total ${weightTotal}, not 100.`);
  const missing = metrics.filter((metric) => !latest.has(metric.id));
  if (missing.length > 0) {
    throw new Error(`Missing score metrics: ${missing.map((item) => item.id).join(", ")}`);
  }
  const configuredIds = new Set(metrics.map((metric) => metric.id));
  const unexpected = [...latest.keys()].filter((id) => !configuredIds.has(id));
  if (unexpected.length > 0) {
    throw new Error(`Unweighted score metrics: ${unexpected.join(", ")}`);
  }
  const diagnostics = metrics.map((metric) => {
    const record = latest.get(metric.id);
    return {
      id: metric.id,
      label: metric.label,
      weight: metric.weight,
      valueMs: record.valueMs,
      baselineMs: metric.baselineMs,
      changePercent: ((record.valueMs / metric.baselineMs) - 1) * 100,
      weightedLatencyRatio: latencyRatio(record.valueMs, metric.baselineMs) * metric.weight / 100,
    };
  });
  const weightedLatencyRatio = diagnostics.reduce((total, item) => total + item.weightedLatencyRatio, 0);
  const score = Math.max(1, Math.min(100, 100 - 50 * weightedLatencyRatio));
  return { score, diagnostics };
}
