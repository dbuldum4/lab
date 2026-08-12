/** Normalize text used by the small, user-facing picker filters. */
export function normalizePickerQuery(value: string) {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Keep picker ordering stable while requiring every typed term to occur in an
 * option's readable search text. The original option objects are returned so
 * callers can keep their existing labels, ids, and click handlers unchanged.
 */
export function filterPickerOptions<T>(
  options: readonly T[],
  query: string,
  getSearchText: (option: T) => string,
) {
  const terms = normalizePickerQuery(query).split(" ").filter(Boolean);
  if (terms.length === 0) return [...options];

  return options.filter((option) => {
    const searchText = normalizePickerQuery(getSearchText(option));
    return terms.every((term) => searchText.includes(term));
  });
}
