const DEFAULT_MARKDOWN_EXPORT_FILENAME = "untitled.md";
const MAX_EXPORT_FILENAME_STEM_LENGTH = 80;
const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Build a portable Markdown filename from a local session name.
 *
 * The stem is deliberately a small Unicode slug: letters and numbers are
 * preserved, separators become hyphens, and the only appended extension is
 * `.md`. This keeps the browser download local while avoiding path separators,
 * control characters, repeated whitespace/dots, and Windows device names.
 */
export function markdownExportFilename(sessionName: string | null | undefined): string {
  const normalized = typeof sessionName === "string" ? sessionName.normalize("NFKC").trim() : "";
  const withoutMarkdownExtension = normalized.replace(/(?:\s*\.md)+$/iu, "").trim();

  if (!withoutMarkdownExtension || /^untitled$/iu.test(withoutMarkdownExtension)) {
    return DEFAULT_MARKDOWN_EXPORT_FILENAME;
  }

  const slug = withoutMarkdownExtension
    .toLowerCase()
    // Remove controls before the broader separator replacement so they can
    // never end up as an invisible character in a downloaded filename.
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "");

  const stem = Array.from(slug)
    .slice(0, MAX_EXPORT_FILENAME_STEM_LENGTH)
    .join("")
    .replace(/^-+|-+$/gu, "");

  if (!stem) return DEFAULT_MARKDOWN_EXPORT_FILENAME;

  const safeStem = WINDOWS_RESERVED_BASENAME.test(stem) ? `note-${stem}` : stem;
  return `${safeStem}.md`;
}
