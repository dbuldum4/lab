const MAX_TITLE_LENGTH = 80;

function cleanTitle(value: string): string {
  return value
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
  let inFence = false;
  let fence = "";

  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fence = fenceMatch[1][0];
      } else if (fenceMatch[1][0] === fence) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const title = cleanTitle(heading[1]);
      if (title) return title;
    }
  }

  inFence = false;
  fence = "";
  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fence = fenceMatch[1][0];
      } else if (fenceMatch[1][0] === fence) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    const prose = line
      .replace(/^\s{0,3}>\s?(?:\[![A-Z]+\]\s*)?/, "")
      .replace(/^\s*(?:[-*+] |\d+[.)] )/, "")
      .replace(/^\s*<\/?(?:details|summary)[^>]*>\s*$/i, "");
    const title = cleanTitle(prose);
    if (title) return title;
  }

  return "Untitled";
}
