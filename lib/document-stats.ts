export type DocumentStats = {
  words: number;
  characters: number;
  charactersNoSpaces: number;
  paragraphs: number;
  headings: number;
  codeBlocks: number;
  readingMinutes: number;
};

const WORDS_PER_MINUTE = 225;

/** Strip Markdown syntax while retaining the words a reader would consume. */
export function readableMarkdown(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, "$1")
    .replace(/~~~[^\n]*\n?([\s\S]*?)~~~/g, "$1")
    .replace(/<details[^>]*>|<\/details>|<summary[^>]*>|<\/summary>/gi, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}>\s?(?:\[![A-Z]+\]\s*)?/gm, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+] |\d+[.)] )/gm, "")
    .replace(/\[(?: |x|X)\]\s*/g, "")
    .replace(/\$\$([\s\S]*?)\$\$/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/\\([\\`*_{}[\]()#+.!-])/g, "$1")
    .trim();
}

export function calculateDocumentStats(markdown: string): DocumentStats {
  const readable = readableMarkdown(markdown);
  const words = readable.match(/[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
  const paragraphs = markdown
    .split(/\n\s*\n/)
    .filter((block) => block.trim() && !/^\s*(?:```|~~~)/.test(block)).length;
  const headings = markdown.match(/^\s{0,3}#{1,6}\s+\S/gm)?.length ?? 0;
  const codeBlocks = markdown.match(/^\s*(?:```|~~~)/gm)?.length ?? 0;

  return {
    words,
    characters: readable.length,
    charactersNoSpaces: readable.replace(/\s/gu, "").length,
    paragraphs,
    headings,
    codeBlocks: Math.floor(codeBlocks / 2),
    readingMinutes: words === 0 ? 0 : Math.max(1, Math.ceil(words / WORDS_PER_MINUTE)),
  };
}
