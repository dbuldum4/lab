export type HeadingLevel = 1 | 2 | 3;

export type OutlineHeadingInput = {
  level: HeadingLevel;
  title: string;
  position: number;
};

export type OutlineItem = OutlineHeadingInput & {
  depth: number;
  id: string;
};

export function normalizeOutlineTitle(title: string) {
  const normalized = title.replace(/\s+/gu, " ").trim();
  return normalized || "Untitled section";
}

/**
 * Keep the document's heading levels intact so an h3 remains visibly nested
 * below an h2 even when the document skips a level. The position is the
 * ProseMirror node position used to place the cursor when a row is selected.
 */
export function buildOutline(headings: readonly OutlineHeadingInput[]): OutlineItem[] {
  return headings.map((heading, index) => ({
    ...heading,
    depth: heading.level - 1,
    id: `heading-${index}`,
    title: normalizeOutlineTitle(heading.title),
  }));
}

export function areOutlineItemsEqual(left: readonly OutlineItem[], right: readonly OutlineItem[]) {
  if (left.length !== right.length) return false;
  return left.every((item, index) => {
    const other = right[index];
    return item.id === other.id
      && item.level === other.level
      && item.title === other.title
      && item.position === other.position
      && item.depth === other.depth;
  });
}

export function activeOutlineIndex(items: readonly OutlineItem[], position: number) {
  let active = -1;
  for (let index = 0; index < items.length; index += 1) {
    if (items[index].position > position) break;
    active = index;
  }
  return active;
}
