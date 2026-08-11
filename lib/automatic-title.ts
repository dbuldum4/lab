const MAX_TITLE_LENGTH = 80;

type FenceMarker = {
  marker: "`" | "~";
  length: number;
  suffix: string;
};

function parseFenceMarker(line: string): FenceMarker | null {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!match) return null;
  const marker = match[1][0] as FenceMarker["marker"];
  // CommonMark does not allow backticks in a backtick fence info string.
  if (marker === "`" && match[2].includes("`")) return null;
  return { marker, length: match[1].length, suffix: match[2] };
}

function closesFence(line: string, fence: Omit<FenceMarker, "suffix">) {
  const marker = parseFenceMarker(line);
  return Boolean(
    marker
    && marker.marker === fence.marker
    && marker.length >= fence.length
    && /^[ \t]*$/.test(marker.suffix),
  );
}

function firstOutsideFences(lines: readonly string[], readTitle: (line: string) => string | null) {
  let fence: Omit<FenceMarker, "suffix"> | null = null;
  for (const line of lines) {
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const opening = parseFenceMarker(line);
    if (opening) {
      fence = opening;
      continue;
    }
    const title = readTitle(line);
    if (title) return title;
  }
  return null;
}

function stripDetailsSummaryWrappers(value: string) {
  let result = value;
  let previous = "";
  while (result !== previous) {
    previous = result;
    result = result
      .replace(/^\s*<details\b[^>]*>\s*/i, "")
      .replace(/^\s*<summary\b[^>]*>\s*/i, "")
      .replace(/\s*<\/summary>\s*$/i, "")
      .replace(/\s*<\/details>\s*$/i, "");
  }
  return result;
}

function cleanTitle(value: string): string {
  return stripDetailsSummaryWrappers(value)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/\$\$([^$]+)\$\$/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\\([\\`*_{}[\]()#+.!-])/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TITLE_LENGTH);
}

/** Prefer the first heading, then the first readable prose line. */
export function automaticTitleFromMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const headingTitle = firstOutsideFences(lines, (line) => {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    return heading ? cleanTitle(heading[1]) : null;
  });
  if (headingTitle) return headingTitle;

  const proseTitle = firstOutsideFences(lines, (line) => {
    const prose = line
      .replace(/^\s{0,3}>\s?(?:\[![A-Z]+\]\s*)?/, "")
      .replace(/^\s*(?:[-*+] |\d+[.)] )/, "");
    return cleanTitle(prose);
  });
  return proseTitle ?? "Untitled";
}
