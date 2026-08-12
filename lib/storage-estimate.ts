const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

export type StorageEstimate = {
  /** A browser-provided estimate; either side may be unavailable. */
  usage: number | null;
  quota: number | null;
};

function finiteByteCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Normalize the untrusted shape returned by navigator.storage.estimate(). */
export function parseStorageEstimate(value: unknown): StorageEstimate | null {
  if (value === null || typeof value !== "object") return null;

  try {
    const record = value as { usage?: unknown; quota?: unknown };
    const estimate = {
      usage: finiteByteCount(record.usage),
      quota: finiteByteCount(record.quota),
    };
    return estimate.usage === null && estimate.quota === null ? null : estimate;
  } catch {
    // A hostile or privacy-restricted StorageManager can expose throwing getters.
    return null;
  }
}

/** Format a byte count without suggesting that it is an exact measurement. */
export function formatApproximateBytes(value: number | null | undefined): string | null {
  const bytes = finiteByteCount(value);
  if (bytes === null) return null;

  let amount = bytes;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }

  const decimals = unitIndex === 0 ? 0 : amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
  const fixed = amount.toFixed(decimals);
  const formatted = fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
  return `about ${formatted} ${BYTE_UNITS[unitIndex]}`;
}

/** Format whichever parts of a browser storage estimate are available. */
export function formatStorageEstimate(estimate: StorageEstimate | null | undefined): string | null {
  if (!estimate) return null;

  const usage = formatApproximateBytes(estimate.usage);
  const quota = formatApproximateBytes(estimate.quota);
  if (!usage && !quota) return null;
  if (usage && quota) return `${usage} used of ${quota} quota`;
  if (usage) return `${usage} used (quota unavailable)`;
  return `${quota} quota (usage unavailable)`;
}
