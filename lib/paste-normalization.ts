import katex from "katex";

/**
 * Paste intent classification for the editor's clipboard pipeline.
 *
 * The module is intentionally free of browser and editor dependencies: every
 * function is a pure string classifier so the decision logic can be unit
 * tested with deterministic string inputs.
 */

export type PasteIntent =
  | { kind: "native" }
  | { kind: "plain-text"; text: string }
  | { kind: "markdown"; markdown: string }
  | { kind: "inline-math"; latex: string }
  | { kind: "block-math"; latex: string };

const BLOCK_SCORE = 3;
const INLINE_SCORE = 1;
const MARKDOWN_THRESHOLD = BLOCK_SCORE;

const WRAPPER_TAGS = new Set(["pre", "div", "span", "br", "p"]);
const DOCUMENT_CHROME_TAGS = new Set(["html", "head", "body", "meta", "title", "link"]);
const SEMANTIC_TAGS = new Set([
  "p",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td",
  "blockquote", "pre", "code", "a",
  "em", "i", "strong", "b", "s", "del",
  "hr", "img", "dl", "dt", "dd",
]);

function normalizeLineEndings(text: string) {
  return text.replace(/\r\n?/g, "\n");
}

/**
 * Ordered clipboard decision pipeline. Earlier rules take precedence:
 *
 * 1. Inside a code block the payload is always literal plain text.
 * 2. Rich HTML with meaningful semantic structure wins over plain text.
 * 3. HTML that merely wraps literal Markdown is parsed as Markdown.
 * 4. Otherwise the plain-text payload is classified on its own.
 */
export function classifyClipboardPaste(input: {
  plainText: string;
  html: string;
  insideCodeBlock: boolean;
}): PasteIntent {
  if (input.insideCodeBlock) {
    return { kind: "plain-text", text: normalizeLineEndings(input.plainText) };
  }

  const plainText = normalizeLineEndings(input.plainText);
  const html = input.html.trim();

  if (html) {
    if (htmlIsPlainMarkdownWrapper(html, plainText)) {
      return classifyPlain(plainText);
    }
    if (htmlHasSemanticStructure(html)) {
      return { kind: "native" };
    }
  }

  return classifyPlain(plainText);
}

function classifyPlain(text: string): PasteIntent {
  if (looksLikeMarkdown(text)) {
    return { kind: "markdown", markdown: normalizeMarkdownLatex(text) };
  }
  return classifyStandaloneLatex(text) ?? { kind: "plain-text", text };
}

/**
 * Small scoring classifier for Markdown signals. Block-level constructs are
 * unambiguous on their own; weak inline constructs only count when several
 * appear together. Ambiguous standalone tokens (hashtags, negative numbers,
 * currency, lone list markers, lone emphasis markers) stay plain text.
 */
export function markdownScore(text: string): number {
  const normalized = normalizeLineEndings(text);
  if (!normalized.trim()) return 0;
  const lines = normalized.split("\n");
  let score = 0;

  if (/^#{1,6}\s+\S+/m.test(normalized)) score += BLOCK_SCORE;
  if (/^>\s*\S/m.test(normalized)) score += BLOCK_SCORE;
  if (/^\s*(```|~~~)/m.test(normalized)) score += BLOCK_SCORE;
  if (/^\s*[-*+]\s+\[[ xX]\]/m.test(normalized)) score += BLOCK_SCORE;

  const listItemLines = lines.filter((line) => (
    /^\s*[-*+]\s+\S/.test(line) || /^\s*\d{1,3}[.)]\s+\S/.test(line)
  )).length;
  if (listItemLines >= 2) score += BLOCK_SCORE;

  const pipeLines = lines.filter((line) => /^\s*\|.*\|/.test(line)).length;
  const tableSeparator = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/m;
  if (pipeLines >= 2 && tableSeparator.test(normalized)) score += BLOCK_SCORE;

  if (/^\s*([-*_])\s*\1\s*\1(?:\s*\1)*\s*$/m.test(normalized)) score += BLOCK_SCORE;

  if (/!?\[[^\]]+\]\([^\s)]+\)/.test(normalized)) score += INLINE_SCORE;
  if (/~~[^~\n]+~~/.test(normalized)) score += INLINE_SCORE;
  if (/\*\*[^*\n]+\*\*|__[^_\n]+__/.test(normalized)) score += INLINE_SCORE;
  if (/`[^`\n]+`/.test(normalized)) score += INLINE_SCORE;

  return score;
}

export function looksLikeMarkdown(text: string): boolean {
  return markdownScore(text) >= MARKDOWN_THRESHOLD;
}

function htmlTags(html: string): string[] {
  const tags: string[] = [];
  for (const match of html.matchAll(/<\s*\/?\s*([a-z][a-z0-9-]*)\b[^>]*>/gi)) {
    tags.push(match[1].toLowerCase());
  }
  return tags;
}

export function htmlHasSemanticStructure(html: string): boolean {
  return htmlTags(html).some((tag) => SEMANTIC_TAGS.has(tag));
}

function decodeNumericEntity(match: string, code: string, radix: number) {
  const value = Number.parseInt(code, radix);
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : match;
}

function htmlTextContent(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote|pre|table)>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (match, code) => decodeNumericEntity(match, code, 10))
    .replace(/&#x([0-9a-f]+);/gi, (match, code) => decodeNumericEntity(match, code, 16));
}

function equivalentVisibleText(left: string, right: string) {
  const collapse = (value: string) => value.replace(/\s+/g, " ").trim();
  return collapse(left) === collapse(right);
}

/**
 * True when the HTML carries no meaningful structure and its visible text is
 * exactly the plain-text payload, which itself reads as Markdown: a single
 * `<pre>` with raw Markdown, escaped Markdown inside structureless
 * `<div>`/`<span>`/`<p>` wrappers, or HTML whose text equals the Markdown
 * source in `text/plain`.
 */
export function htmlIsPlainMarkdownWrapper(html: string, plainText: string): boolean {
  if (!html.trim() || !plainText.trim()) return false;
  if (!looksLikeMarkdown(plainText)) return false;

  const tags = htmlTags(html);
  const hasCodeWithPre = tags.includes("pre") && tags.includes("code");
  const meaningful = tags.some((tag) => (
    !WRAPPER_TAGS.has(tag)
    && !DOCUMENT_CHROME_TAGS.has(tag)
    && !(tag === "code" && hasCodeWithPre)
  ));
  if (meaningful) return false;

  const text = htmlTextContent(html);
  if (!text || !equivalentVisibleText(text, plainText)) return false;
  return true;
}

function splitInlineCode(line: string): Array<{ code: boolean; text: string }> {
  const parts: Array<{ code: boolean; text: string }> = [];
  const regex = /(``[^`\n]*``|`[^`\n]*`)/g;
  let last = 0;
  for (const match of line.matchAll(regex)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ code: false, text: line.slice(last, index) });
    parts.push({ code: true, text: match[1] });
    last = index + match[1].length;
  }
  if (last < line.length) parts.push({ code: false, text: line.slice(last) });
  return parts;
}

/**
 * Strong mathematical signals for conservative single-dollar conversion.
 * Currency, prices, and ordinary prose must stay text.
 */
function strongMathSignals(content: string): boolean {
  if (/\\[a-zA-Z]+/.test(content)) return true;
  if (/[{}\\]/.test(content)) return true;
  if (/\^/.test(content)) return true;
  if (/_\w/.test(content)) return true;
  if (/\d\s*[+*/=<>]\s*\d/.test(content)) return true;
  if (/\d\s*-\s*\d/.test(content) && /[a-zA-Z]/.test(content)) return true;
  return false;
}

/** Convert `\(...\)` and conservative `$...$` delimiters inside a text line, skipping inline code spans. */
function normalizeInlineMath(line: string): string {
  return splitInlineCode(line).map((part) => {
    if (part.code) return part.text;
    return part.text
      .replace(/\\\(([\s\S]*?)\\\)/g, (_, content) => `$$${content}$$`)
      .replace(/(?<!\$)\$([^$\n]+)\$(?!\$)/g, (match, content) => (
        strongMathSignals(content) ? `$$${content}$$` : match
      ));
  }).join("");
}

/**
 * Normalize equation delimiters into the syntax the editor already parses:
 * `\(...\)` becomes inline math, `\[...\]` becomes block math, and
 * conservative single-dollar spans become inline math. Delimiters inside
 * fenced code blocks, indented code blocks, and inline code spans are kept
 * literal.
 */
export function normalizeMarkdownLatex(markdown: string): string {
  const lines = normalizeLineEndings(markdown).split("\n");
  const output: string[] = [];
  let fenceChar: string | null = null;
  let fenceLength = 0;
  let indentedCode = false;
  let bracketMath = false;

  for (const line of lines) {
    if (fenceChar) {
      output.push(line);
      const close = line.match(/^\s*(`{3,}|~{3,})/);
      if (close && close[1][0] === fenceChar && close[1].length >= fenceLength) {
        fenceChar = null;
      }
      continue;
    }

    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      fenceChar = fence[1][0];
      fenceLength = fence[1].length;
      output.push(line);
      continue;
    }

    if (/^\s*$/.test(line)) {
      indentedCode = false;
      output.push(line);
      continue;
    }

    if (/^( {4,}|\t)/.test(line)) {
      indentedCode = true;
      output.push(line);
      continue;
    }

    if (indentedCode) {
      output.push(line);
      continue;
    }

    if (bracketMath) {
      if (line.trim() === "\\]") {
        output.push(line.replace(/\\\]/, "$$$$"));
        bracketMath = false;
      } else {
        output.push(line);
      }
      continue;
    }

    const singleLineBracket = line.match(/^(\s*)\\\[([\s\S]*?)\\\]\s*$/);
    if (singleLineBracket) {
      output.push(`${singleLineBracket[1]}$$\n${singleLineBracket[2]}\n$$`);
      continue;
    }

    if (/^(\s*)\\\[/.test(line)) {
      output.push(line.replace(/^(\s*)\\\[/, "$1$$$$"));
      bracketMath = true;
      continue;
    }

    output.push(normalizeInlineMath(line));
  }

  return output.join("\n");
}

function hasStrongLatexSignal(text: string): boolean {
  if (/\\[a-zA-Z]+/.test(text)) return true;
  if (/(?:^|[^a-zA-Z0-9])[a-zA-Z0-9]+\^/.test(text)) return true;
  if (/(?:^|[^a-zA-Z0-9])[a-zA-Z0-9]_/.test(text)) return true;
  return false;
}

/** Reject payloads that look like file names with extensions, e.g. `x_1.txt`. */
function looksLikeFilename(text: string): boolean {
  return /\.[a-zA-Z0-9]{2,}$/.test(text.trim());
}

function katexValidates(latex: string, displayMode: boolean): boolean {
  try {
    katex.renderToString(latex, {
      displayMode,
      throwOnError: true,
      strict: "warn",
      trust: false,
      output: "htmlAndMathml",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * True when a single-line payload is compact enough to be a math expression:
 * at least half of its words must carry a strong LaTeX signal. This keeps
 * ordinary prose containing a stray `^`, `_`, or command from becoming math.
 */
function signalDensityOk(text: string): boolean {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  const signalTokens = tokens.filter((token) => hasStrongLatexSignal(token)).length;
  return signalTokens * 2 >= tokens.length;
}

/**
 * Classify an entire plain-text payload as standalone LaTeX. Requires a
 * strong signal in the first token (prose with a late math fragment stays
 * text), compact shape for single-line input, and a successful KaTeX parse.
 */
export function classifyStandaloneLatex(text: string): PasteIntent | null {
  const trimmed = normalizeLineEndings(text).trim();
  if (!trimmed) return null;

  let payload = trimmed;
  let display = false;

  if (/^\$\$\n[\s\S]*\n\$\$$/.test(payload)) {
    display = true;
    payload = payload.replace(/^\$\$\n?/, "").replace(/\n?\$\$$/, "").trim();
  } else if (/^\\\[[\s\S]*\\\]$/.test(payload)) {
    display = true;
    payload = payload.replace(/^\\\[/, "").replace(/\\\]$/, "").trim();
  } else if (/^\$\$[\s\S]*\$\$$/.test(payload)) {
    payload = payload.replace(/^\$\$/, "").replace(/\$\$$/, "").trim();
  } else if (/^\\\([\s\S]*\\\)$/.test(payload)) {
    payload = payload.replace(/^\\\(/, "").replace(/\\\)$/, "").trim();
  } else if (/^\$([^$\n]+)\$$/.test(payload) && strongMathSignals(payload.slice(1, -1))) {
    payload = payload.slice(1, -1).trim();
  }

  if (!payload || !hasStrongLatexSignal(payload)) return null;
  if (!hasStrongLatexSignal(payload.split(/\s+/)[0] ?? payload)) return null;
  if (looksLikeFilename(payload)) return null;

  const multiline = payload.includes("\n");
  const environment = /\\begin\{/.test(payload);
  if (!multiline && !environment && !display && !signalDensityOk(payload)) return null;

  const isBlock = multiline || environment || display;
  if (!katexValidates(payload, isBlock)) {
    if (!isBlock) return null;
    if (!katexValidates(payload, false)) return null;
  }

  return isBlock
    ? { kind: "block-math", latex: payload }
    : { kind: "inline-math", latex: payload };
}
