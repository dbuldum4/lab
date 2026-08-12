export type SearchSourceRange = {
  start: number;
  end: number;
};

export type NormalizedSearchText = {
  text: string;
  sourceRanges: SearchSourceRange[];
};

const MARKS = /\p{M}/gu;
const MARK = /\p{M}/u;
const WHITESPACE = /\s/gu;

function normalizeCharacter(character: string) {
  return character
    .normalize("NFKD")
    .replace(MARKS, "")
    .toLowerCase()
    .replace(MARKS, "")
    .replace(WHITESPACE, " ");
}
/** Normalize text for user-facing search without changing the displayed text. */
export function normalizeSearchText(value: string) {
  return normalizeSearchTextWithMapping(value).text;
}

/**
 * Normalize text while retaining source ranges for every normalized code unit.
 * Compatibility characters can expand and combining marks can disappear, so a
 * normalized index cannot safely be used as an index into the original value.
 */
export function normalizeSearchTextWithMapping(value: string): NormalizedSearchText {
  let text = "";
  const sourceRanges: SearchSourceRange[] = [];
  let sourceIndex = 0;
  let pendingStart: number | null = null;

  for (const character of value) {
    const sourceStart = sourceIndex;
    sourceIndex += character.length;
    const sourceEnd = sourceIndex;
    const normalizedCharacter = normalizeCharacter(character);

    if (!normalizedCharacter) {
      if (MARK.test(character)) {
        if (sourceRanges.length > 0) {
          sourceRanges[sourceRanges.length - 1].end = sourceEnd;
        } else {
          pendingStart ??= sourceStart;
        }
      }
      continue;
    }

    const rangeStart = pendingStart ?? sourceStart;
    pendingStart = null;
    for (const normalizedCodePoint of normalizedCharacter) {
      text += normalizedCodePoint;
      for (let index = 0; index < normalizedCodePoint.length; index += 1) {
        sourceRanges.push({ start: rangeStart, end: sourceEnd });
      }
    }
  }

  let compactText = "";
  const compactRanges: SearchSourceRange[] = [];
  let normalizedIndex = 0;
  while (normalizedIndex < text.length) {
    const codePoint = text.codePointAt(normalizedIndex);
    if (codePoint === undefined) break;
    const codePointText = String.fromCodePoint(codePoint);
    const codeUnitLength = codePointText.length;
    const range = sourceRanges[normalizedIndex];
    const endRange = sourceRanges[normalizedIndex + codeUnitLength - 1] ?? range;
    if (codePoint === 0x20 && compactText.endsWith(" ")) {
      const lastRange = compactRanges[compactRanges.length - 1];
      if (lastRange && endRange) lastRange.end = endRange.end;
    } else {
      compactText += codePointText;
      for (let index = 0; index < codeUnitLength; index += 1) {
        const codeUnitRange = sourceRanges[normalizedIndex + index] ?? range;
        if (codeUnitRange) compactRanges.push({ ...codeUnitRange });
      }
    }
    normalizedIndex += codeUnitLength;
  }

  let start = 0;
  while (start < compactText.length && compactText[start] === " ") start += 1;
  let end = compactText.length;
  while (end > start && compactText[end - 1] === " ") end -= 1;

  return {
    text: compactText.slice(start, end),
    sourceRanges: compactRanges.slice(start, end),
  };
}
