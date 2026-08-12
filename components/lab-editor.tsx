Warning: truncated output (original token count: 52436)
Total output lines: 5102

"use client";

import {
  Extension,
  getMarkRange,
  InputRule,
  type Editor,
  type JSONContent,
  type MarkdownParseHelpers,
  type MarkdownToken,
} from "@tiptap/core";
import Placeholder from "@tiptap/extension-placeholder";
import { TableKit } from "@tiptap/extension-table";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { BlockMath, InlineMath } from "@tiptap/extension-mathematics";
import Image, { type ImageOptions } from "@tiptap/extension-image";
import { Markdown } from "@tiptap/markdown";
import { closeHistory } from "@tiptap/pm/history";
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection, type Transaction } from "@tiptap/pm/state";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { BorderBeam } from "border-beam";
import katex from "katex";
import { LayoutGroup, motion, type Transition } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  ImageMetadataDialog,
  LinkEditorPanel,
  ShortcutsPanel,
  StatsPanel,
  trapTabWithin,
  useModalFocusTrap,
} from "@/components/editor-feature-panels";
import {
  createEditorPersistenceController,
  type EditorPersistenceController,
} from "@/lib/editor-persistence";
import {
  DEFAULT_DOCUMENT_ID,
  inspectLocalStorage,
  isLocalDocumentDeleted,
  listLocalRecoveryDrafts,
  readVerifiedLocalDocument,
  requestPersistentStorage,
  setLocalDocumentScope,
  type LocalRecoveryDraft,
  type StorageHealth,
} from "@/lib/local-vault";
import { formatStorageEstimate } from "@/lib/storage-estimate";
import {
  VAULT_BACKUP_FILENAME,
  MAX_VAULT_BACKUP_BYTES,
  exportLocalVault,
  isValidLocalImageDataUrl,
  parseVaultBackup,
  restoreLocalVault,
  serializeVaultBackup,
} from "@/lib/vault-backup";
import {
  transactionContainsDollar,
  transactionTouchesHeading,
} from "@/lib/editor-transactions";
import {
  commandAvailability,
  rankCommands,
  type CommandContext,
} from "@/lib/command-availability";
import { SessionTouchBarrier } from "@/lib/session-touch-barrier";
import {
  activeDocumentIdFromLocation,
  archiveDocumentSession,
  clearInvalidDocumentSessionHash,
  createDocumentSession,
  documentSessionHash,
  getDocumentSession,
  listDocumentSessions,
  pinDocumentSession,
  parseActiveDocumentLocation,
  purgeDocumentSession,
  renameDocumentSession,
  touchDocumentSession,
  unarchiveDocumentSession,
  unpinDocumentSession,
  updateAutomaticSessionTitle,
  type DocumentSession,
} from "@/lib/document-sessions";
import { automaticTitleFromMarkdown } from "@/lib/automatic-title";
import { calculateDocumentStats, type DocumentStats } from "@/lib/document-stats";
import { EditorBlockExtensions } from "@/lib/editor-blocks";
import { markdownExportFilename } from "@/lib/export-filename";
import {
  normalizeSearchQuery,
  searchMatchRanges,
  searchableMarkdown,
  searchLocalDocuments,
  type LocalSearchDocument,
  type LocalSearchResult,
} from "@/lib/local-search";
import {
  documentIdFromLocalHref,
  findBacklinks,
  localSessionHref,
  type Backlink,
  type BacklinkDocument,
} from "@/lib/note-links";
import { classifyClipboardPaste } from "@/lib/paste-normalization";
import {
  activeOutlineIndex,
  areOutlineItemsEqual,
  buildOutline,
  type HeadingLevel,
  type OutlineItem,
} from "@/lib/outline";
import {
  clearVersions,
  listVersions,
  recordVersion,
  type VersionHistoryEntry,
} from "@/lib/version-history";
import {
  createEditorNoticeController,
  type EditorNotice,
  type EditorNoticeController,
  type EditorNoticeKind,
} from "@/lib/editor-notice";
import {
  THEMES,
  THEME_STORAGE_KEY,
  themeFromDocument,
  type ThemeId,
} from "@/lib/theme";

type SlashRange = { from: number; to: number };
type PaletteMode =
  | "commands"
  | "status"
  | "confirm-clear"
  | "confirm-delete"
  | "confirm-import"
  | "name"
  | "sessions"
  | "archives"
  | "link-session"
  | "search"
  | "stats"
  | "shortcuts"
  | "language"
  | "theme"
  | "backlinks"
  | "history"
  | "link-editor";
type PaletteAnchor = { left: number; top: number; bottom: number };
type PaletteState = {
  query: string;
  range: SlashRange;
  left: number;
  top: number;
  mode: PaletteMode;
  anchor: PaletteAnchor;
};

type PendingMarkdownImport = {
  markdown: string;
  fileName: string;
  revision: number;
  currentMarkdown: string;
};

type Command = {
  id: string;
  label: string;
  detail: string;
  terms: string;
};

type MathKind = "inline" | "block";
type MathEditorState = {
  kind: MathKind;
  pos: number;
  latex: string;
  initialLatex: string;
  isNew: boolean;
  left: number;
  top: number;
};

type ImageCropTarget = {
  pos: number;
  src: string;
  alt: string;
};

type ImageMetadataTarget = {
  pos: number;
  alt: string;
  title: string;
};

type LinkEditorState = {
  from: number;
  to: number;
  label: string;
  href: string;
};

type ShortcutDescription = {
  keys: string;
  action: string;
};

type CropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type CropPoint = { x: number; y: number };
type CropHandle = "top-left" | "top" | "top-right" | "right" | "bottom-right" | "bottom" | "bottom-left" | "left";
type CropInteraction = {
  mode: "draw" | "move" | "resize";
  pointerId: number;
  start: CropPoint;
  initial: CropRect;
  handle?: CropHandle;
};

const CROP_HANDLES: CropHandle[] = [
  "top-left",
  "top",
  "top-right",
  "right",
  "bottom-right",
  "bottom",
  "bottom-left",
  "left",
];

const SLASH_PALETTE_INITIAL = {
  opacity: 0,
  transform: "translateY(0px) scale(0.93)",
};
const SLASH_PALETTE_TRANSITION: Transition = {
  type: "spring",
  stiffness: 560,
  damping: 34,
  mass: 0.62,
};
const SLASH_SELECTION_TRANSITION: Transition = {
  type: "spring",
  stiffness: 480,
  damping: 35,
  mass: 0.58,
};

const CODE_LANGUAGES = [
  { id: "", label: "Plain text" },
  { id: "typescript", label: "TypeScript" },
  { id: "javascript", label: "JavaScript" },
  { id: "tsx", label: "TSX" },
  { id: "jsx", label: "JSX" },
  { id: "python", label: "Python" },
  { id: "bash", label: "Shell" },
  { id: "json", label: "JSON" },
  { id: "html", label: "HTML" },
  { id: "css", label: "CSS" },
  { id: "sql", label: "SQL" },
  { id: "rust", label: "Rust" },
  { id: "go", label: "Go" },
  { id: "java", label: "Java" },
  { id: "c", label: "C" },
  { id: "cpp", label: "C++" },
  { id: "yaml", label: "YAML" },
  { id: "markdown", label: "Markdown" },
] as const;

const KEYBOARD_SHORTCUTS: ShortcutDescription[] = [
  { keys: "⌘/Ctrl K", action: "Open sessions" },
  { keys: "⌘/Ctrl ⇧ F", action: "Search every note" },
  { keys: "⌘/Ctrl ⇧ O", action: "Toggle outline" },
  { keys: "⌘/Ctrl ⇧ S", action: "Show document stats" },
  { keys: "⌘/Ctrl ⌥ H", action: "Open version history" },
  { keys: "⌘/Ctrl ⌥ L", action: "Choose code-block language" },
  { keys: "⌘/Ctrl ⇧ K", action: "Edit the current link" },
  { keys: "⌘/Ctrl ⇧ N", action: "Create a new session" },
  { keys: "⌘/Ctrl ⇧ E", action: "Insert an equation" },
  { keys: "⌘/Ctrl S", action: "Export the current note" },
  { keys: "⌘/Ctrl /", action: "Show shortcuts" },
];

const COMMANDS: Command[] = [
  { id: "text", label: "Text", detail: "Plain paragraph", terms: "paragraph normal" },
  { id: "h1", label: "Heading 1", detail: "Large section title", terms: "title h1" },
  { id: "h2", label: "Heading 2", detail: "Medium section title", terms: "subtitle h2" },
  { id: "h3", label: "Heading 3", detail: "Small section title", terms: "subtitle h3" },
  { id: "outline", label: "Outline", detail: "Toggle document headings", terms: "toc table of contents navigation sidebar" },
  { id: "bullet", label: "Bulleted list", detail: "Create an unordered list", terms: "ul list bullets" },
  { id: "number", label: "Numbered list", detail: "Create an ordered list", terms: "ol list numbers" },
  { id: "todo", label: "To-do list", detail: "Create a checklist", terms: "task check checkbox" },
  { id: "quote", label: "Quote", detail: "Create a block quote", terms: "blockquote citation" },
  { id: "code", label: "Code block", detail: "Write preformatted code", terms: "pre snippet" },
  { id: "divider", label: "Divider", detail: "Separate sections", terms: "rule hr line" },
  { id: "table", label: "Table", detail: "Insert a 3 × 3 Markdown table", terms: "grid rows columns" },
  { id: "table-row-before", label: "Table row above", detail: "Add a row before the current row", terms: "table insert row above" },
  { id: "table-row-after", label: "Table row below", detail: "Add a row after the current row", terms: "table insert row below" },
  { id: "table-delete-row", label: "Delete table row", detail: "Remove the current row", terms: "table remove row" },
  { id: "table-column-before", label: "Table column left", detail: "Add a column before the current one", terms: "table insert column left" },
  { id: "table-column-after", label: "Table column right", detail: "Add a column after the current one", terms: "table insert column right" },
  { id: "table-delete-column", label: "Delete table column", detail: "Remove the current column", terms: "table remove column" },
  { id: "table-toggle-header", label: "Toggle table header", detail: "Toggle the current row as a header", terms: "table heading header row" },
  { id: "table-delete", label: "Delete table", detail: "Remove the current table", terms: "table remove grid" },
  { id: "language", label: "Code language", detail: "Set the current code block language", terms: "code block syntax language fence" },
  { id: "callout-note", label: "Note callout", detail: "Insert a note callout", terms: "alert info block" },
  { id: "callout-tip", label: "Tip callout", detail: "Insert a tip callout", terms: "alert advice block" },
  { id: "callout-warning", label: "Warning callout", detail: "Insert a warning callout", terms: "alert caution block" },
  { id: "callout-important", label: "Important callout", detail: "Insert an important callout", terms: "alert critical block" },
  { id: "details", label: "Collapsible section", detail: "Insert a summary with collapsible content", terms: "details disclosure toggle fold" },
  { id: "inline-math", label: "Inline equation", detail: "Write LaTeX within a line", terms: "math latex formula inline equation" },
  { id: "math", label: "Block equation", detail: "Write a centered LaTeX equation", terms: "math latex formula display equation" },
  { id: "link", label: "Link", detail: "Type a URL, then close with )", terms: "url href markdown" },
  { id: "link-note", label: "Link to session", detail: "Insert a link to another local note", terms: "internal wiki note relation" },
  { id: "backlinks", label: "Backlinks", detail: "Show sessions linking here", terms: "incoming internal links references" },
  { id: "edit-link", label: "Edit link", detail: "Edit the selected link label and URL", terms: "url href rename unlink" },
  { id: "image", label: "Image", detail: "Insert a local image", terms: "photo picture upload paste" },
  { id: "image-metadata", label: "Image metadata", detail: "Edit alt text and title", terms: "photo accessibility caption alt title" },
  { id: "undo", label: "Undo", detail: "Undo the last change", terms: "back history" },
  { id: "redo", label: "Redo", detail: "Redo the last change", terms: "forward history" },
  { id: "import", label: "Import Markdown", detail: "Open a local .md file", terms: "open file load" },
  { id: "export", label: "Export Markdown", detail: "Save a local .md copy", terms: "download file save" },
  { id: "backup", label: "Export vault backup", detail: "Save every session and local image", terms: "vault backup export all archive" },
  { id: "restore", label: "Restore vault backup", detail: "Merge a validated local backup", terms: "vault backup restore import merge" },
  { id: "recover", label: "Export recovery drafts", detail: "Download conflicting local drafts", terms: "conflict restore backup" },
  { id: "new", label: "New session", detail: "Start a separate document", terms: "document note create" },
  { id: "name", label: "Name session", detail: "Rename this document", terms: "document note title rename" },
  { id: "pin", label: "Pin session", detail: "Keep this session at the top", terms: "favorite important document" },
  { id: "unpin", label: "Unpin session", detail: "Return this session to date ordering", terms: "favorite document" },
  { id: "archive", label: "Archive session", detail: "Hide this session from active lists", terms: "hide store document" },
  { id: "unarchive", label: "Unarchive session", detail: "Return this session to active lists", terms: "restore show document" },
  { id: "sessions", label: "Sessions", detail: "Resume another document", terms: "documents notes switch open resume" },
  { id: "archives", label: "Archived sessions", detail: "Browse locally archived notes", terms: "documents hidden stored" },
  { id: "search", label: "Search notes", detail: "Find across local sessions", terms: "find search notes text content sessions" },
  { id: "stats", label: "Document stats", detail: "Words, characters, blocks, and reading time", terms: "count reading time metrics" },
  { id: "history", label: "Version history", detail: "Restore an earlier local version", terms: "revisions snapshots time machine" },
  { id: "shortcuts", label: "Keyboard shortcuts", detail: "Show every app shortcut", terms: "keys hotkeys help" },
  { id: "theme", label: "Theme", detail: "Choose the app colors", terms: "appearance light dark dracula nord solarized catppuccin" },
  { id: "delete", label: "Delete session", detail: "Remove this document permanently", terms: "remove destroy discard session document" },
  { id: "status", label: "Storage status", detail: "Inspect local redundancy", terms: "local-only copies offline" },
  { id: "clear", label: "Clear note", detail: "Requires a second Enter", terms: "delete erase reset" },
];

const EMPTY_COMMAND_CONTEXT: CommandContext = {
  inTable: false,
  inCodeBlock: false,
  inLink: false,
  selectedImage: false,
};

function commandContextFromEditor(instance: Editor): CommandContext {
  const linkType = instance.schema.marks.link;
  const selection = instance.state.selection;
  return {
    inTable: instance.isActive("table"),
    inCodeBlock: instance.isActive("codeBlock"),
    inLink: Boolean(linkType && getMarkRange(selection.$from, linkType)),
    selectedImage: selection instanceof NodeSelection && selection.node.type.name === "image",
  };
}

const MarkdownLinkInput = Extension.create({
  name: "markdownLinkInput",
  addInputRules() {
    return [
      new InputRule({
        find: /\[([^\]]+)]\((https?:\/\/[^\s)]+)\)$/,
        handler: ({ state, range, match }) => {
          if (isCodeBlock(state.selection.$from.parent)) return;
          const [, label, href] = match;
          if (!label || !href) return;
          state.tr.replaceWith(
            range.from,
            range.to,
            state.schema.text(label, [state.schema.marks.link.create({ href })]),
          );
        },
      }),
    ];
  },
});

/**
 * Keep the persisted syntax close to Notion's keyboard syntax: inline math is
 * delimited by two dollar signs. The upstream Tiptap extension serializes
 * inline nodes with single-dollar delimiters, so its Markdown handlers are
 * intentionally narrowed here to avoid confusing `$$x$$` with a block node.
 */
const deferredMathRenders = new Map<Element, () => void>();
let deferredMathObserver: IntersectionObserver | null = null;

function createDeferredMathRenderer(element: HTMLElement, render: () => void) {
  if (typeof IntersectionObserver === "undefined") {
    render();
    return {
      renderNow: () => {},
      destroy: () => {},
    };
  }

  const stopObserver = () => {
    deferredMathObserver?.unobserve(element);
    if (deferredMathRenders.size === 0) {
      deferredMathObserver?.disconnect();
      deferredMathObserver = null;
    }
  };

  const renderOnce = () => {
    if (!deferredMathRenders.has(element)) return;
    deferredMathRenders.delete(element);
    stopObserver();
    render();
  };

  if (!deferredMathObserver) {
    deferredMathObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) deferredMathRenders.get(entry.target)?.();
      }
    }, { rootMargin: "600px 0px" });
  }

  deferredMathRenders.set(element, renderOnce);
  deferredMathObserver.observe(element);

  return {
    renderNow: renderOnce,
    destroy: () => {
      deferredMathRenders.delete(element);
      stopObserver();
    },
  };
}

const InlineMathMarkdown = InlineMath.extend({
  renderMarkdown: (node) => `$$${String(node.attrs?.latex ?? "")}$$`,
  markdownTokenizer: {
    name: "inlineMath",
    level: "inline",
    start: (source: string) => source.indexOf("$$"),
    tokenize: (source: string) => {
      const match = source.match(/^\$\$((?:\\\$|[^$\n])+?)\$\$(?!\$)/);
      if (!match) return undefined;
      return { type: "inlineMath", raw: match[0], latex: match[1].trim() };
    },
  },
  addInputRules() {
    // Delimiter conversion is handled from the transaction update below. The
    // upstream input rule assumes a synchronous DOM range and can throw when
    // an IME or browser automation reports the range before reconciliation.
    return [];
  },
  addNodeView() {
    const { katexOptions } = this.options;

    return ({ node, getPos }) => {
      const wrapper = document.createElement("span");
      wrapper.className = "tiptap-mathematics-render";

      if (this.editor.isEditable) {
        wrapper.classList.add("tiptap-mathematics-render--editable");
      }

      wrapper.dataset.type = "inline-math";
      wrapper.setAttribute("data-latex", node.attrs.latex);

      function renderMath() {
        try {
          katex.render(node.attrs.latex, wrapper, katexOptions);
          wrapper.classList.remove("inline-math-error");
        } catch {
          wrapper.textContent = node.attrs.latex;
          wrapper.classList.add("inline-math-error");
        }
      }

      const deferredRender = createDeferredMathRenderer(wrapper, renderMath);
      const handleClick = (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        deferredRender.renderNow();
        const pos = getPos();

        if (pos == null) return;
        this.options.onClick?.(node, pos);
      };

      if (this.options.onClick) wrapper.addEventListener("click", handleClick);

      return {
        dom: wrapper,
        destroy() {
          wrapper.removeEventListener("click", handleClick);
          deferredRender.destroy();
        },
      };
    };
  },
});

function findBlockMathStart(source: string) {
  let offset = 0;
  while (offset < source.length) {
    const index = source.indexOf("$$\n", offset);
    if (index < 0) return -1;
    if (index === 0 || source[index - 1] === "\n") return index;
    offset = index + 2;
  }
  return -1;
}

/** Block math is only recognized when the delimiters occupy their own lines. */
const BlockMathMarkdown = BlockMath.extend({
  markdownTokenizer: {
    name: "blockMath",
    level: "block",
    start: findBlockMathStart,
    tokenize: (source: string) => {
      const match = source.match(/^\$\$\n([\s\S]*?)\n\$\$(?:\n|$)/);
      if (!match) return undefined;
      return { type: "blockMath", raw: match[0], latex: match[1].trim() };
    },
  },
  addNodeView() {
    const { katexOptions } = this.options;

    return ({ node, getPos }) => {
      const wrapper = document.createElement("div");
      const innerWrapper = document.createElement("div");
      wrapper.className = "tiptap-mathematics-render";

      if (this.editor.isEditable) {
        wrapper.classList.add("tiptap-mathematics-render--editable");
      }

      innerWrapper.className = "block-math-inner";
      wrapper.dataset.type = "block-math";
      wrapper.setAttribute("data-latex", node.attrs.latex);
      wrapper.appendChild(innerWrapper);

      function renderMath() {
        try {
          katex.render(node.attrs.latex, innerWrapper, katexOptions);
          wrapper.classList.remove("block-math-error");
        } catch {
          wrapper.textContent = node.attrs.latex;
          wrapper.classList.add("block-math-error");
        }
      }

      const deferredRender = createDeferredMathRenderer(wrapper, renderMath);
      const handleClick = (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        deferredRender.renderNow();
        const pos = getPos();

        if (pos == null) return;
        this.options.onClick?.(node, pos);
      };

      if (this.options.onClick) wrapper.addEventListener("click", handleClick);

      return {
        dom: wrapper,
        destroy() {
          wrapper.removeEventListener("click", handleClick);
          deferredRender.destroy();
        },
      };
    };
  },
});

const EMPTY_HEALTH: StorageHealth = {
  copies: 0,
  labels: [],
  persistent: false,
  errors: [],
  conflicts: 0,
  storageEstimate: null,
};
const PALETTE_ID = "slash-command-palette";
const MATH_EDITOR_ID = "math-editor-popover";
const MARKDOWN_LINK_PATTERN = /\[([^\]]+)]\((https?:\/\/[^\s)]+)\)$/;
const INLINE_MATH_PATTERN = /^\$\$((?:\\\$|[^$\n])+?)\$\$$/;
const BLOCK_MATH_PATTERN = /^\$\$\n([\s\S]*?)\n\$\$(?:\n)?$/;

function isCodeBlock(parent: { type: { name: string } }) {
  return parent.type.name === "codeBlock";
}

function outlineFromEditor(instance: Editor): OutlineItem[] {
  const headings: Array<{ level: HeadingLevel; title: string; position: number }> = [];
  instance.state.doc.descendants((node, position) => {
    if (node.type.name !== "heading") return;
    const level = Number(node.attrs.level);
    if (level !== 1 && level !== 2 && level !== 3) return;
    headings.push({
      level,
      title: node.textContent,
      position,
    });
  });
  return buildOutline(headings);
}

/**
 * Serialize only top-level ProseMirror nodes that changed since the last call.
 * ProseMirror nodes are immutable, so an unchanged node keeps the same object
 * identity across transactions. The Markdown manager still renders every
 * changed block, which preserves the canonical Tiptap Markdown format.
 */
function createIncrementalMarkdownSerializer() {
  let cachedNodes: PMNode[] = [];
  let cachedFragments: string[] = [];
  let cachedMarkdown = "";

  return (instance: Editor) => {
    const manager = instance.markdown;
    if (!manager) return instance.getMarkdown();

    const documentNode = instance.state.doc;
    const nextNodes: PMNode[] = [];
    const nextFragments: string[] = [];
    let changed = cachedNodes.length !== documentNode.childCount;

    for (let index = 0; index < documentNode.childCount; index += 1) {
      const node = documentNode.child(index);
      nextNodes.push(node);
      const nodeChanged = cachedNodes[index] !== node;
      const previousNodeChanged = index > 0
        && cachedNodes[index - 1] !== documentNode.child(index - 1);
      changed ||= nodeChanged;
      if (!nodeChanged && !previousNodeChanged) {
        nextFragments.push(cachedFragments[index] ?? "");
        continue;
      }

      const parentContent = index > 0 ? new Array<JSONContent>(index) : undefined;
      if (parentContent) parentContent[index - 1] = documentNode.child(index - 1).toJSON() as JSONContent;
      nextFragments.push(
        manager.renderNodeToMarkdown(
          node.toJSON() as JSONContent,
          parentContent ? { type: "doc", content: parentContent } : { type: "doc" },
          index,
          0,
        ),
      );
    }

    if (!changed) return cachedMarkdown;

    cachedNodes = nextNodes;
    cachedFragments = nextFragments;
    const renderedMarkdown = nextFragments.join("\n\n");
    cachedMarkdown = renderedMarkdown.replace(/&nbsp;/g, "").replace(/\u00a0/g, "").trim() === ""
      ? ""
      : renderedMarkdown;
    return cachedMarkdown;
  };
}

/** Index just before the grapheme ending at `index`. Uses Intl.Segmenter when available so ZWJ emoji and combined marks are not split; falls back to surrogate-pair handling. */
function previousGraphemeIndex(text: string, index: number) {
  if (index <= 0) return 0;
  const Segmenter = (globalThis as unknown as { Intl?: { Segmenter?: unknown } }).Intl?.Segmenter as
    | (new (locale: string | undefined, opts: { granularity: string }) => { segment(input: string): Iterable<{ segment: string; index: number }> })
    | undefined;
  if (Segmenter) {
    try {
      const segmenter = new Segmenter(undefined, { granularity: "grapheme" });
      let prev = 0;
      for (const { segment } of segmenter.segment(text.slice(0, index))) {
        const next = prev + segment.length;
        if (next >= index) return prev;
        prev = next;
      }
      return prev;
    } catch {
      // Fall through to code-unit fallback.
    }
  }
  if (index >= 2) {
    const low = text.charCodeAt(index - 1);
    const high = text.charCodeAt(index - 2);
    if (low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff) {
      return index - 2;
    }
  }
  return index - 1;
}

function backwardWordStart(text: string) {
  let start = text.length;
  while (start > 0) {
    const prev = previousGraphemeIndex(text, start);
    if (!/\s/u.test(text.slice(prev, start))) break;
    start = prev;
  }

  if (start > 0) {
    const prev = previousGraphemeIndex(text, start);
    const unit = text.slice(prev, start);
    if (/[\p{L}\p{N}_]/u.test(unit)) {
      while (start > 0) {
        const p = previousGraphemeIndex(text, start);
        if (!/[\p{L}\p{N}_]/u.test(text.slice(p, start))) break;
        start = p;
      }
    } else {
      start = prev;
    }
  }

  return start;
}

/** Client-only gate: false during SSR/prerender, true after hydration (no effect setState). */
function useIsClient() {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const MOBILE_OUTLINE_QUERY = "(max-width: 640px)";

function subscribeToReducedMotion(callback: () => void) {
  const mediaQuery = window.matchMedia(REDUCED_MOTION_QUERY);
  mediaQuery.addEventListener("change", callback);
  return () => mediaQuery.removeEventListener("change", callback);
}

function usePrefersReducedMotion() {
  return useSyncExternalStore(
    subscribeToReducedMotion,
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
    () => true,
  );
}

function subscribeToMobileOutline(callback: () => void) {
  const mediaQuery = window.matchMedia(MOBILE_OUTLINE_QUERY);
  mediaQuery.addEventListener("change", callback);
  return () => mediaQuery.removeEventListener("change", callback);
}

function useMobileOutline() {
  return useSyncExternalStore(
    subscribeToMobileOutline,
    () => window.matchMedia(MOBILE_OUTLINE_QUERY).matches,
    () => false,
  );
}

function migrateInlineMath(instance: Editor) {
  const matches: Array<{ from: number; to: number; latex: string }> = [];
  instance.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text?.includes("$$")) return;
    const parent = instance.state.doc.resolve(pos).parent;
    if (isCodeBlock(parent)) return;
    const pattern = /\$\$((?:\\\$|[^$\n])+?)\$\$/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(node.text)) !== null) {
      matches.push({ from: pos + match.index, to: pos + match.index + match[0].length, latex: match[1] });
    }
  });
  if (matches.length === 0) return false;

  const tr = instance.state.tr;
  for (const match of matches.reverse()) {
    tr.replaceWith(match.from, match.to, instance.schema.nodes.inlineMath.create({ latex: match.latex }));
  }
  instance.view.dispatch(tr.setMeta("addToHistory", false));
  return true;
}

function mathNodeType(kind: MathKind) {
  return kind === "inline" ? "inlineMath" : "blockMath";
}

function sameMathEditor(left: MathEditorState | null, right: MathEditorState | null) {
  return Boolean(left && right && left.kind === right.kind && left.pos === right.pos);
}

function updateMathNode(instance: Editor, current: MathEditorState, latex: string, addToHistory = true) {
  const node = instance.state.doc.nodeAt(current.pos);
  if (!node || node.type.name !== mathNodeType(current.kind)) return false;

  const transaction = instance.state.tr
    .setNodeMarkup(current.pos, node.type, { ...node.attrs, latex })
    .scrollIntoView()
    .setMeta("addToHistory", addToHistory);
  instance.view.dispatch(transaction);
  return true;
}

function deleteMathNode(instance: Editor, current: MathEditorState) {
  const node = instance.state.doc.nodeAt(current.pos);
  if (!node || node.type.name !== mathNodeType(current.kind)) return false;
  instance.view.dispatch(
    instance.state.tr
      .delete(current.pos, current.pos + node.nodeSize)
      .scrollIntoView()
      .setMeta("addToHistory", false),
  );
  return true;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function highlightSearchText(value: string, query: string): ReactNode {
  const ranges = searchMatchRanges(value, query);
  if (ranges.length === 0) return value;
  const parts: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    if (range.start > cursor) parts.push(<span key={`text-${index}`}>{value.slice(cursor, range.start)}</span>);
    parts.push(<mark key={`match-${index}`}>{value.slice(range.start, range.end)}</mark>);
    cursor = Math.max(cursor, range.end);
  });
  if (cursor < value.length) parts.push(<span key="text-tail">{value.slice(cursor)}</span>);
  return parts;
}

function downloadMarkdown(filename: string, markdown: string) {
  downloadText(filename, markdown, "text/markdown;charset=utf-8");
}

function downloadText(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  globalThis.setTimeout(() => URL.revokeObjectURL(anchor.href), 0);
}

function downloadVaultBackup(backup: Awaited<ReturnType<typeof exportLocalVault>>) {
  downloadText(VAULT_BACKUP_FILENAME, serializeVaultBackup(backup), "application/json;charset=utf-8");
}

function recoveryBundle(drafts: readonly LocalRecoveryDraft[]) {
  if (drafts.length === 1) return drafts[0].markdown;
  return drafts.map((draft, index) => {
    const date = new Date(draft.updatedAt);
    const stagedAt = Number.isNaN(date.getTime()) ? String(draft.updatedAt) : date.toISOString();
    return `<!-- lab recovery draft ${index + 1}; staged ${stagedAt} -->\n\n${draft.markdown}`;
  }).join("\n\n---\n\n");
}

/** Raw file cap before base64 (~4/3) so a single image stays under typical localStorage quotas. */
const MAX_IMAGE_BYTES = 1_500_000;

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read image file"));
    reader.readAsDataURL(file);
  });
}

/** Local-first images only: data URLs and same-origin paths. */
function isAllowedImageSrc(src: string | null | undefined): boolean {
  if (!src) return false;
  const trimmed = src.trim();
  if (trimmed.toLowerCase().startsWith("data:image/")) return isValidLocalImageDataUrl(trimmed);
  try {
    if (typeof window === "undefined") {
      return trimmed.startsWith("/") && !trimmed.startsWith("//");
    }
    const url = new URL(trimmed, window.location.href);
    if (url.protocol === "data:") return isValidLocalImageDataUrl(url.href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return url.origin === window.location.origin;
  } catch {
    return false;
  }
}

function escapeMarkdownImageAlt(alt: string): string {
  return alt.replace(/\\/g, "\\\\").replace(/]/g, "\\]").replace(/\r?\n/g, " ");
}

function escapeMarkdownImageTitle(title: string): string {
  return title.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function imageDimension(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.max(1, Math.round(number));
}

function parseImageMarkdownTitle(title: unknown) {
  const value = String(title ?? "");
  const parts = value.split(";");
  const sizeMatch = parts[0]?.match(/^lab-size:(\d+)?x(\d+)?$/);
  const align = parts.includes("align=center") ? "center" : null;
  const titlePart = parts.find((part) => part.startsWith("title="));
  if (!sizeMatch && !align) return { title: value || null, width: null, height: null, align: null };

  let imageTitle: string | null = null;
  if (titlePart) {
    try {
      imageTitle = decodeURIComponent(titlePart.slice("title=".length));
    } catch {
      imageTitle = titlePart.slice("title=".length);
    }
  }
  return {
    title: imageTitle,
    width: imageDimension(sizeMatch?.[1]),
    height: imageDimension(sizeMatch?.[2]),
    align,
  };
}

function imageMarkdownTitle(title: unknown, width: unknown, height: unknown, align: unknown) {
  const rawTitle = String(title ?? "");
  const normalizedWidth = imageDimension(width);
  const normalizedHeight = imageDimension(height);
  const normalizedAlign = align === "center" ? "center" : null;
  if (!normalizedWidth && !normalizedHeight && !normalizedAlign) return rawTitle;

  const metadata = [
    normalizedWidth || normalizedHeight ? `lab-size:${normalizedWidth ?? ""}x${normalizedHeight ?? ""}` : null,
    normalizedAlign ? "align=center" : null,
  ].filter(Boolean).join(";");
  return rawTitle ? `${metadata};title=${encodeURIComponent(rawTitle)}` : metadata;
}

type InsertImageFilesOptions = {
  onNotice?: (message: string) => void;
  /**
   * Document position to insert at (e.g. drop coords via posAtCoords).
   * When omitted, replaces the current selection.
   */
  pos?: number;
  /** Selection captured before an asynchronous file read started. */
  selection?: { from: number; to: number };
};

async function insertImageFiles(
  editor: Editor,
  files: FileList | readonly File[],
  options: InsertImageFilesOptions = {},
): Promise<void> {
  const imageFiles = Array.from(files).filter((file) => file.type.startsWith("image/"));
  if (imageFiles.length === 0 || editor.isDestroyed) return;

  const accepted: File[] = [];
  let rejectedLarge = 0;
  for (const file of imageFiles) {
    if (file.size > MAX_IMAGE_BYTES) {
      rejectedLarge += 1;
      continue;
    }
    accepted.push(file);
  }

  if (rejectedLarge > 0) {
    options.onNotice?.(
      rejectedLarge === 1
        ? "That image is too large to store locally. Use an image under 1.5MB."
        : `${rejectedLarge} images were too large to store locally. Use images under 1.5MB each.`,
    );
  }
  if (accepted.length === 0 || editor.isDestroyed) return;

  // FileReader yields to the event loop. Keep the numeric anchor only when
  // the editor state is unchanged; otherwise it may point into a different
  // document after a concurrent edit. The current selection is a safe fallback.
  const anchorState = editor.state;
  let dataUrls: { file: File; dataUrl: string }[];
  try {
    dataUrls = await Promise.all(
      accepted.map(async (file) => ({ file, dataUrl: await readFileAsDataURL(file) })),
    );
  } catch {
    options.onNotice?.("The selected image could not be inserted.");
    return;
  }
  if (editor.isDestroyed) return;

  const { schema, state } = editor;
  const anchorIsCurrent = editor.state === anchorState;
  const images = dataUrls.map(({ file, dataUrl }) => {
    const alt = file.name.replace(/\.[^/.]+$/, "");
    return schema.nodes.image.create({ src: dataUrl, alt });
  });

  // Prefer an explicit drop/insert position; otherwise replace the selection.
  // Do not use either captured value after a transaction has changed the doc.
  const insertionPos = anchorIsCurrent ? options.pos : undefined;
  const insertionSelection = anchorIsCurrent ? options.selection : undefined;
  let from: number;
  let to: number;
  let $insert = state.selection.$to;
  const clampDocPosition = (value: number) => Math.max(
    0,
    Math.min(Math.round(value), state.doc.content.size),
  );
  if (typeof insertionPos === "number" && Number.isFinite(insertionPos)) {
    const pos = clampDocPosition(insertionPos);
    from = pos;
    to = pos;
    $insert = state.doc.resolve(pos);
  } else if (insertionSelection) {
    from = clampDocPosition(insertionSelection.from);
    to = clampDocPosition(insertionSelection.to);
    if (from > to) [from, to] = [to, from];
    $insert = state.doc.resolve(to);
  } else {
    from = state.selection.from;
    to = state.selection.to;
  }

  // Only append a trailing empty paragraph when inserting at the end of a
  // textblock. Mid-paragraph inserts already leave the remaining text as the
  // block after the image; an extra empty paragraph would create a blank line.
  const atEndOfTextblock = $insert.parent.isTextblock && $insert.parentOffset === $insert.parent.content.size;
  const nodes: PMNode[] = atEndOfTextblock
    ? [...images, schema.nodes.paragraph.create()]
    : images;

  editor.commands.insertContentAt({ from, to }, Fragment.from(nodes), {
    updateSelection: true,
  });
}

/**
 * Local-first image node: base64/same-origin only, and safe Markdown alt.
 */
type ImageCropHandler = (node: PMNode, pos: number) => void;
type ImageMetadataHandler = (node: PMNode, pos: number) => void;
type LabImageOptions = ImageOptions & {
  onCrop: ImageCropHandler | null;
  onMetadata: ImageMetadataHandler | null;
};

const LabImage = Image.extend({
  addOptions() {
    return {
      ...this.parent?.(),
      onCrop: null as ImageCropHandler | null,
      onMetadata: null as ImageMetadataHandler | null,
    } as LabImageOptions;
  },
  addAttributes() {
    return {
      ...this.parent?.(),
      align: {
        default: null,
        parseHTML: (node: HTMLElement) => node.getAttribute("data-image-align") === "center" ? "center" : null,
        renderHTML: (attributes: { align?: string | null }) => attributes.align === "center"
          ? { "data-image-align": "center" }
          : {},
      },
    };
  },
  parseHTML() {
    return [
      {
        tag: "img[src]",
        getAttrs: (node: HTMLElement | string) => {
          if (typeof node === "string") return false;
          const src = node.getAttribute("src");
          if (!isAllowedImageSrc(src)) return false;
          return {
            src,
            alt: node.getAttribute("alt"),
            title: node.getAttribute("title"),
            width: imageDimension(node.getAttribute("width") ?? node.style.width.replace(/px$/, "")),
            height: imageDimension(node.getAttribute("height") ?? node.style.height.replace(/px$/, "")),
            align: node.getAttribute("data-image-align") === "center" ? "center" : null,
          };
        },
      },
    ];
  },
  parseMarkdown: (token: MarkdownToken, helpers: MarkdownParseHelpers) => {
    const src = String(token.href ?? "");
    if (!isAllowedImageSrc(src)) return [];
    const imageTitle = parseImageMarkdownTitle(token.title);
    return helpers.createNode("image", {
      src,
      title: imageTitle.title,
      alt: token.text,
      width: imageTitle.width,
      height: imageTitle.height,
      align: imageTitle.align,
    });
  },
  renderMarkdown: (node: JSONContent) => {
    const src = String(node.attrs?.src ?? "");
    const alt = escapeMarkdownImageAlt(String(node.attrs?.alt ?? ""));
    const title = imageMarkdownTitle(node.attrs?.title, node.attrs?.width, node.attrs?.height, node.attrs?.align);
    return title
      ? `![${alt}](${src} "${escapeMarkdownImageTitle(title)}")`
      : `![${alt}](${src})`;
  },
  addNodeView() {
    return (props) => {
      const image = document.createElement("img");
      image.className = String(props.HTMLAttributes.class ?? "lab-image");
      image.draggable = false;
      image.loading = "lazy";
      image.setAttribute("contenteditable", "false");
      let centerButton: HTMLButtonElement | null = null;
      let alignmentAnimationFrame: number | null = null;

      const stopAlignmentAnimation = () => {
        if (alignmentAnimationFrame !== null) {
          cancelAnimationFrame(alignmentAnimationFrame);
          alignmentAnimationFrame = null;
        }
        image.style.removeProperty("will-change");
      };

      const setImageAlignment = (align: string | null) => {
        if (align === "center") image.dataset.imageAlign = "center";
        else delete image.dataset.imageAlign;
      };

      const animateImageAlignment = (align: string | null) => {
        if (!image.isConnected) {
          setImageAlignment(align);
          return;
        }

        const startRect = image.getBoundingClientRect();
        stopAlignmentAnimation();
        image.style.removeProperty("transform");
        setImageAlignment(align);
        const targetRect = image.getBoundingClientRect();
        const startOffset = startRect.left - targetRect.left;
        if (!Number.isFinite(startOffset) || Math.abs(startOffset) < 0.5) {
          updateOverlay();
          return;
        }

        const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
        if (reduceMotion) {
          updateOverlay();
          return;
        }

        image.style.willChange = "transform";
        let position = startOffset;
        let velocity = 0;
        let previousTime = performance.now();
        const stiffness = 250;
        const damping = 2 * Math.sqrt(stiffness);

        const step = (time: number) => {
          const deltaTime = Math.min(32, Math.max(1, time - previousTime)) / 1000;
          previousTime = time;
          const acceleration = -stiffness * position - damping * velocity;
          velocity += acceleration * deltaTime;
          position += velocity * deltaTime;
          image.style.transform = `translate3d(${position}px, 0, 0)`;
          updateOverlay();

          if (Math.abs(position) < 0.25 && Math.abs(velocity) < 0.25) {
            image.style.removeProperty("transform");
            stopAlignmentAnimation();
            updateOverlay();
            return;
          }
          alignmentAnimationFrame = requestAnimationFrame(step);
        };

        image.style.transform = `translate3d(${position}px, 0, 0)`;
        updateOverlay();
        alignmentAnimationFrame = requestAnimationFrame(step);
      };

      const syncCenterButton = (node: PMNode) => {
        if (!centerButton) return;
        const action = node.attrs.align === "center" ? "Uncenter" : "Center";
        centerButton.textContent = action;
        centerButton.setAttribute("aria-label", `${action} image`);
      };

      const syncImage = (node: PMNode) => {
        const src = String(node.attrs.src ?? "");
        if (image.getAttribute("src") !== src) image.src = src;
        const alt = node.attrs.alt == null ? "" : String(node.attrs.alt);
        if (image.getAttribute("alt") !== alt) image.setAttribute("alt", alt);
        const title = node.attrs.title == null || node.attrs.title === "" ? null : String(node.attrs.title);
        if (title == null) image.removeAttribute("title");
        else if (image.getAttribute("title") !== title) image.setAttribute("title", title);

        const width = imageDimension(node.attrs.width);
        const height = imageDimension(node.attrs.height);
        if (width) image.style.width = `${width}px`;
        else image.style.removeProperty("width");
        if (width && height) {
          // Let max-width shrink both dimensions together on narrow screens.
          image.style.aspectRatio = `${width} / ${height}`;
          image.style.removeProperty("height");
        } else {
          image.style.removeProperty("aspect-ratio");
          if (height) image.style.height = `${height}px`;
          else image.style.removeProperty("height");
        }
        const nextAlign = node.attrs.align === "center" ? "center" : null;
        const currentAlign = image.dataset.imageAlign === "center" ? "center" : null;
        if (currentAlign === nextAlign) setImageAlignment(nextAlign);
        else animateImageAlignment(nextAlign);
        syncCenterButton(node);
      };
      syncImage(props.node);

      let overlay: HTMLDivElement | null = null;

      const getCurrentImage = () => {
        const pos = props.getPos();
        if (typeof pos !== "number") return null;
        const node = props.editor.state.doc.nodeAt(pos);
        return node?.type.name === "image" ? { node, pos } : null;
      };

      let selected = false;
      let resizing: {
        pointerId: number;
        direction: CropHandle;
        startX: number;
        startY: number;
        startWidth: number;
        startHeight: number;
        aspectRatio: number;
        width: number;
        height: number;
      } | null = null;

      const updateOverlay = () => {
        if (!selected || !overlay) return;
        const rect = image.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        overlay.style.left = `${rect.left}px`;
        overlay.style.top = `${rect.top}px`;
        overlay.style.width = `${rect.width}px`;
        overlay.style.height = `${rect.height}px`;
      };

      const finishResize = () => {
        if (!resizing) return;
        const current = resizing;
        resizing = null;
        document.removeEventListener("pointermove", moveResize);
        document.removeEventListener("pointerup", finishResize);
        document.removeEventListener("pointercancel", finishResize);
        const pos = props.getPos();
        if (typeof pos !== "number") return;
        props.editor.commands.setNodeSelection(pos);
        props.editor.commands.updateAttributes("image", {
          width: imageDimension(current.width),
          height: imageDimension(current.height),
        });
      };

      const moveResize = (event: PointerEvent) => {
        if (!resizing) return;
        const deltaX = event.clientX - resizing.startX;
        const deltaY = event.clientY - resizing.startY;
        const horizontalDelta = resizing.direction.includes("left") ? -deltaX : deltaX;
        const verticalDelta = resizing.direction.includes("top") ? -deltaY : deltaY;
        const startWidth = Math.max(1, resizing.startWidth);
        const startHeight = Math.max(1, resizing.startHeight);
        const horizontalScale = (startWidth + horizontalDelta) / startWidth;
        const verticalScale = (startHeight + verticalDelta) / startHeight;
        const requestedScale = resizing.direction === "top" || resizing.direction === "bottom"
          ? verticalScale
          : resizing.direction === "left" || resizing.direction === "right"
            ? horizontalScale
            : Math.max(horizontalScale, verticalScale);
        const scale = Math.max(
          48 / startWidth,
          48 / startHeight,
          requestedScale,
        );
        const maxWidth = Math.max(48, props.editor.view.dom.clientWidth || Number.POSITIVE_INFINITY);
        const width = Math.min(maxWidth, startWidth * scale);
        const height = width / resizing.aspectRatio;
        resizing.width = width;
        resizing.height = height;
        image.style.width = `${width}px`;
        image.style.height = `${height}px`;
        updateOverlay();
      };

      const startResize = (event: PointerEvent, direction: CropHandle) => {
        event.preventDefault();
        event.stopPropagation();
        const rect = image.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const pos = props.getPos();
        if (typeof pos === "number") props.editor.commands.setNodeSelection(pos);
        resizing = {
          pointerId: event.pointerId,
          direction,
          startX: event.clientX,
          startY: event.clientY,
          startWidth: rect.width,
          startHeight: rect.height,
          aspectRatio: rect.width / Math.max(1, rect.height),
          width: rect.width,
          height: rect.height,
        };
        document.addEventListener("pointermove", moveResize);
        document.addEventListener("pointerup", finishResize);
        document.addEventListener("pointercancel", finishResize);
      };

      const ensureOverlay = () => {
        if (overlay) return;

        const nextOverlay = document.createElement("div");
        nextOverlay.className = "image-selection-overlay";
        nextOverlay.setAttribute("contenteditable", "false");
        nextOverlay.setAttribute("data-image-overlay", "true");
        nextOverlay.setAttribute("aria-hidden", "true");

        const toolbar = document.createElement("div");
        toolbar.className = "image-edit-toolbar";
        toolbar.setAttribute("contenteditable", "false");
        toolbar.setAttribute("role", "toolbar");
        toolbar.setAttribute("aria-label", "Image actions");

        const makeButton = (label: string, action: () => void) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "image-edit-button";
          button.textContent = label;
          button.setAttribute("aria-label", `${label} image`);
          button.addEventListener("pointerdown", (event) => {
            event.preventDefault();
            event.stopPropagation();
            button.focus({ preventScroll: true });
          });
          button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            action();
          });
          return button;
        };

        const cropButton = makeButton("Crop", () => {
          const current = getCurrentImage();
          if (!current) return;
          props.editor.commands.setNodeSelection(current.pos);
          (this.options as LabImageOptions).onCrop?.(current.node, current.pos);
        });
        const metadataButton = makeButton("Details", () => {
          const current = getCurrentImage();
          if (!current) return;
          props.editor.commands.setNodeSelection(current.pos);
          (this.options as LabImageOptions).onMetadata?.(current.node, current.pos);
        });
        const deleteButton = makeButton("Delete", () => {
          const current = getCurrentImage();
          if (!current) return;
          props.editor.commands.setNodeSelection(current.pos);
          props.editor.commands.deleteSelection();
          props.editor.commands.focus();
        });
        centerButton = makeButton("Center", () => {
          const current = getCurrentImage();
          if (!current) return;
          props.editor.commands.setNodeSelection(current.pos);
          props.editor.commands.updateAttributes("image", {
            align: current.node.attrs.align === "center" ? null : "center",
          });
          props.editor.commands.focus();
        });
        syncCenterButton(props.node);
        toolbar.append(cropButton, metadataButton, centerButton, deleteButton);
        nextOverlay.append(toolbar);

        CROP_HANDLES.forEach((direction) => {
          const handle = document.createElement("button");
          handle.type = "button";
          handle.className = `image-resize-handle image-resize-handle-${direction}`;
          handle.setAttribute("data-image-resize-handle", direction);
          handle.setAttribute("aria-label", `Resize image ${direction}`);
          handle.tabIndex = -1;
          handle.addEventListener("pointerdown", (event) => startResize(event, direction));
          nextOverlay.append(handle);
        });

        overlay = nextOverlay;
        document.body.append(nextOverlay);
      };

      const selectNode = () => {
        ensureOverlay();
        selected = true;
        attachWindowListeners();
        image.classList.add("ProseMirror-selectednode");
        overlay?.style.setProperty("display", "block");
        overlay?.setAttribute("aria-hidden", "false");
        updateOverlay();
      };
      const deselectNode = () => {
        selected = false;
        resizing = null;
        detachWindowListeners();
        image.classList.remove("ProseMirror-selectednode");
        overlay?.style.setProperty("display", "none");
        overlay?.setAttribute("aria-hidden", "true");
      };
      const onImageClick = (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        const pos = props.getPos();
        if (typeof pos === "number") props.editor.commands.setNodeSelection(pos);
      };
      const onImageLoad = () => updateOverlay();
      const onWindowChange = () => updateOverlay();
      let windowListenersAttached = false;
      const attachWindowListeners = () => {
        if (windowListenersAttached) return;
        windowListenersAttached = true;
        window.addEventListener("resize", onWindowChange, { passive: true });
        window.addEventListener("scroll", onWindowChange, { passive: true });
      };
      const detachWindowListeners = () => {
        if (!windowListenersAttached) return;
        windowListenersAttached = false;
        window.removeEventListener("resize", onWindowChange);
        window.removeEventListener("scroll", onWindowChange);
      };

      image.addEventListener("click", onImageClick);
      image.addEventListener("load", onImageLoad);
      deselectNode();

      return {
        dom: image,
        update: (updatedNode: PMNode) => {
          if (updatedNode.type !== props.node.type) return false;
          syncImage(updatedNode);
          updateOverlay();
          return true;
        },
        selectNode,
        deselectNode,
        destroy: () => {
          stopAlignmentAnimation();
          detachWindowListeners();
          document.removeEventListener("pointermove", moveResize);
          document.removeEventListener("pointerup", finishResize);
          document.removeEventListener("pointercancel", finishResize);
          image.removeEventListener("click", onImageClick);
          image.removeEventListener("load", onImageLoad);
          overlay?.remove();
        },
      };
    };
  },
  addInputRules() {
    // The inherited rule creates an image directly from typed Markdown and
    // therefore bypasses parseHTML/parseMarkdown source validation.
    return (this.parent?.() ?? []).map((rule) => new InputRule({
      find: rule.find,
      undoable: rule.undoable,
      handler: (props) => {
        if (!isAllowedImageSrc(props.match[3])) return null;
        return rule.handler(props);
      },
    }));
  },
}).configure({
  allowBase64: true,
  resize: false,
  HTMLAttributes: { class: "lab-image" },
});

type ImageCropDialogProps = {
  src: string;
  alt: string;
  onCancel: () => void;
  onApply: (dataUrl: string) => void;
};

function cropPointFromEvent(event: { clientX: number; clientY: number }, stage: HTMLElement): CropPoint {
  const bounds = stage.getBoundingClientRect();
  return {
    x: clamp((event.clientX - bounds.left) / Math.max(1, bounds.width), 0, 1),
    y: clamp((event.clientY - bounds.top) / Math.max(1, bounds.height), 0, 1),
  };
}

function cropRectFromPoints(start: CropPoint, end: CropPoint): CropRect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

function resizeCropRect(initial: CropRect, handle: CropHandle, delta: CropPoint): CropRect {
  const minimum = 0.04;
  let left = initial.x;
  let top = initial.y;
  let right = initial.x + initial.width;
  let bottom = initial.y + initial.height;

  if (handle.includes("left")) left = clamp(initial.x + delta.x, 0, right - minimum);
  if (handle.includes("right")) right = clamp(initial.x + initial.width + delta.x, left + minimum, 1);
  if (handle.includes("top")) top = clamp(initial.y + delta.y, 0, bottom - minimum);
  if (handle.includes("bottom")) bottom = clamp(initial.y + initial.height + delta.y, top + minimum, 1);

  return { x: left, y: top, width: right - left, height: bottom - top };
}

function ImageCropDialog({ src, alt, onCancel, onApply }: ImageCropDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const interactionRef = useRef<CropInteraction | null>(null);
  const rectRef = useRef<CropRect>({ x: 0, y: 0, width: 1, height: 1 });
  const [rect, setRect] = useState<CropRect>({ x: 0, y: 0, width: 1, height: 1 });
  const [imageReady, setImageReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useModalFocusTrap(dialogRef, closeButtonRef, onCancel);

  const updateRect = useCallback((next: CropRect) => {
    rectRef.current = next;
    setRect(next);
  }, []);

  const finishPointer = useCallback((pointerId: number) => {
    const stage = stageRef.current;
    if (stage?.hasPointerCapture(pointerId)) stage.releasePointerCapture(pointerId);
    interactionRef.current = null;
    const current = rectRef.current;
    if (current.width < 0.04 || current.height < 0.04) {
      updateRect({ x: 0, y: 0, width: 1, height: 1 });
    }
  }, [updateRect]);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (busy || !stageRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const point = cropPointFromEvent(event, stageRef.current);
    const target = event.target instanceof HTMLElement ? event.target : null;
    const handleValue = target?.closest<HTMLElement>("[data-crop-handle]")?.dataset.cropHandle;
    const handle = CROP_HANDLES.includes(handleValue as CropHandle)
      ? handleValue as CropHandle
      : undefined;
    const selection = rectRef.current;
    const insideSelection = Boolean(target?.closest("[data-crop-selection]"));
    const selectionIsFull = selection.x <= 0 && selection.y <= 0 && selection.width >= 0.999 && selection.height >= 0.999;
    const mode: CropInteraction["mode"] = handle
      ? "resize"
      : insideSelection && !selectionIsFull
        ? "move"
        : "draw";
    interactionRef.current = {
      mode,
      pointerId: event.pointerId,
      start: point,
      initial: mode === "draw" ? { x: point.x, y: point.y, width: 0, height: 0 } : selection,
      handle,
    };
    try {
      stageRef.current.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic events and a few older browsers do not expose an active pointer.
      // The stage listeners still receive the interaction without capture.
    }
  }, [busy]);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const interaction = interactionRef.current;
    const stage = stageRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId || !stage) return;
    event.preventDefault();
    const point = cropPointFromEvent(event, stage);
    const delta = { x: point.x - interaction.start.x, y: point.y - interaction.start.y };
    let next: CropRect;
    if (interaction.mode === "draw") {
      next = cropRectFromPoints(interaction.start, point);
    } else if (interaction.mode === "move") {
      next = {
        ...interaction.initial,
        x: clamp(interaction.init…22436 tokens truncated…ds.redo();
        return;
      }
      const chain = editor.chain().focus();
      switch (command.id) {
        case "text": chain.setParagraph().run(); break;
        case "h1": chain.toggleHeading({ level: 1 }).run(); break;
        case "h2": chain.toggleHeading({ level: 2 }).run(); break;
        case "h3": chain.toggleHeading({ level: 3 }).run(); break;
        case "bullet": chain.toggleBulletList().run(); break;
        case "number": chain.toggleOrderedList().run(); break;
        case "todo": chain.toggleTaskList().run(); break;
        case "quote": chain.toggleBlockquote().run(); break;
        case "code": chain.toggleCodeBlock().run(); break;
        case "divider": chain.setHorizontalRule().run(); break;
        case "table": chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); break;
        case "table-row-before": if (!chain.addRowBefore().run()) setNotice("Place the caret inside a table first."); break;
        case "table-row-after": if (!chain.addRowAfter().run()) setNotice("Place the caret inside a table first."); break;
        case "table-delete-row": if (!chain.deleteRow().run()) setNotice("Place the caret inside a table first."); break;
        case "table-column-before": if (!chain.addColumnBefore().run()) setNotice("Place the caret inside a table first."); break;
        case "table-column-after": if (!chain.addColumnAfter().run()) setNotice("Place the caret inside a table first."); break;
        case "table-delete-column": if (!chain.deleteColumn().run()) setNotice("Place the caret inside a table first."); break;
        case "table-toggle-header": if (!chain.toggleHeaderRow().run()) setNotice("Place the caret inside a table first."); break;
        case "table-delete": if (!chain.deleteTable().run()) setNotice("Place the caret inside a table first."); break;
        case "callout-note": chain.insertCallout({ type: "note" }).run(); break;
        case "callout-tip": chain.insertCallout({ type: "tip" }).run(); break;
        case "callout-warning": chain.insertCallout({ type: "warning" }).run(); break;
        case "callout-important": chain.insertCallout({ type: "important" }).run(); break;
        case "details": chain.insertCollapsibleSection({ summary: "Summary", open: true }).run(); break;
        case "inline-math": {
          const pos = editor.state.selection.from;
          const node = editor.schema.nodes.inlineMath.create({ latex: "" });
          editor.view.dispatch(editor.state.tr.replaceSelectionWith(node).scrollIntoView());
          const inserted = editor.state.doc.nodeAt(pos);
          if (inserted?.type.name === "inlineMath") {
            openMathEditor("inline", inserted, pos, true);
          }
          break;
        }
        case "math": {
          const preferred = editor.state.selection.from;
          const node = editor.schema.nodes.blockMath.create({ latex: "" });
          editor.view.dispatch(editor.state.tr.replaceSelectionWith(node).scrollIntoView());
          let blockPos: number | null = null;
          let closestDistance = Number.POSITIVE_INFINITY;
          editor.state.doc.descendants((candidate, pos) => {
            if (candidate.type.name !== "blockMath" || String(candidate.attrs.latex ?? "") !== "") return;
            const distance = Math.abs(pos - preferred);
            if (distance < closestDistance) {
              closestDistance = distance;
              blockPos = pos;
            }
          });
          if (blockPos !== null) {
            const inserted = editor.state.doc.nodeAt(blockPos);
            if (inserted) openMathEditor("block", inserted, blockPos, true);
          }
          break;
        }
        case "link": chain.insertContent("[label](https://").run(); break;
        case "image": imageInputRef.current?.click(); break;
        case "import": fileInputRef.current?.click(); break;
        case "export": {
          downloadMarkdown(markdownExportFilename(savedSessionName), serializeMarkdown(editor));
          break;
        }
      }
    },
    [activeTheme, documentId, editor, flushBeforeSessionSwitch, freezePersistenceForNavigation, navigateToSession, openCurrentLinkEditor, openImageMetadata, openMathEditor, persistence, refreshBacklinks, refreshSearchIndex, savedSessionName, serializeMarkdown, sessionTouchBarrier, setNotice, setPalette, setSelected, toggleOutline],
  );

  const navigateToOutlineHeading = useCallback((itemId: string) => {
    const instance = editorRef.current;
    if (!instance || instance.isDestroyed) return;
    const item = outlineItemsRef.current.find((candidate) => candidate.id === itemId);
    if (!item) return;
    const node = instance.state.doc.nodeAt(item.position);
    if (!node || node.type.name !== "heading") {
      syncOutlineItems(instance);
      return;
    }

    const targetPosition = Math.min(item.position + 1, instance.state.doc.content.size);
    const chain = instance.chain();
    if (!mobileOutline) chain.focus();
    chain.setTextSelection(targetPosition).scrollIntoView().run();
    setActiveOutlineIdState(item.id);

    if (mobileOutline) {
      closeOutline();
    }
  }, [closeOutline, mobileOutline, syncOutlineItems]);

  // Bind vault scope synchronously once the client hash is known. Layout effects
  // run before the passive hydration effect, so the persistence controller's
  // first hydrate() sees the correct namespace. setLocalDocumentScope is
  // idempotent (guards on activeDocumentId) and StrictMode-safe.
  useLayoutEffect(() => {
    setLocalDocumentScope(documentId);
  }, [documentId]);

  // Rewrite a bad `#session=…` so the address bar matches default storage binding.
  useLayoutEffect(() => {
    if (openedWithInvalidSessionHash) {
      clearInvalidDocumentSessionHash();
    }
  }, [openedWithInvalidSessionHash]);

  // Hash-only history (Back/Forward) updates the URL without remounting React.
  // documentId and vault scope are fixed at mount, so force a full reload when
  // the location's session id diverges from the bound document.
  useEffect(() => {
    let rebinding = false;
    const rebindIfSessionChanged = () => {
      // Invalid hashes must not keep a misleading `#session=…` while bound to default.
      if (clearInvalidDocumentSessionHash()) {
        setNotice("That session link was invalid. Opened the original note.");
        if (documentId === DEFAULT_DOCUMENT_ID) return;
      }
      const nextId = activeDocumentIdFromLocation();
      if (nextId === documentId || rebinding) return;
      rebinding = true;
      // Best-effort durable flush before unload — same intent as /new and /sessions,
      // without a confirm dialog on the history path (always rebind to the URL).
      void (async () => {
        editor?.setEditable(false, false);
        try {
          await persistence.flush();
        } catch {
          // Staged recovery drafts remain available via /recover after reload.
        }
        window.location.reload();
      })();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      // bfcache restore can resurrect a page whose URL was changed via history.
      if (event.persisted || activeDocumentIdFromLocation() !== documentId) {
        rebindIfSessionChanged();
      }
    };
    window.addEventListener("popstate", rebindIfSessionChanged);
    window.addEventListener("hashchange", rebindIfSessionChanged);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("popstate", rebindIfSessionChanged);
      window.removeEventListener("hashchange", rebindIfSessionChanged);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [documentId, editor, persistence, setNotice]);

  useEffect(() => {
    if (!editor) return;
    let active = true;
    const refreshHealth = async () => {
      try {
        const nextHealth = await inspectLocalStorage();
        if (!active) return;
        setHealth(nextHealth);
        const loadNotice = nextHealth.errors.length > 0
          ? "Some local storage locations are unavailable."
          : nextHealth.conflicts > 0
            ? `${nextHealth.conflicts} conflicting local ${nextHealth.conflicts === 1 ? "draft is" : "drafts are"} available. Use /recover to export.`
            : openedWithInvalidSessionHash
              ? "That session link was invalid. Opened the original note."
              : null;
        setNotice(loadNotice);
      } catch {
        if (active) setNotice("Could not load the saved note. A new local note is ready instead.");
      }
    };
    void (async () => {
      // `return` inside try still runs finally — gate so redirect paths never enable the editor.
      let finishHydration = true;
      const redirectToOriginalAfterDelete = () => {
        finishHydration = false;
        setNotice("This session was deleted. Returning to the original note…");
        window.history.replaceState(
          { labDocumentId: DEFAULT_DOCUMENT_ID },
          "",
          `${window.location.pathname}${window.location.search}`,
        );
        window.location.reload();
      };
      try {
        await requestPersistentStorage();
        if (isLocalDocumentDeleted(documentId) && documentId !== DEFAULT_DOCUMENT_ID) {
          if (!active) return;
          redirectToOriginalAfterDelete();
          return;
        }
        let activeSession: DocumentSession | null = null;
        try {
          // Do not ensure/create metadata for arbitrary hashes — only load existing
          // names. First durable save (touchDocumentSession) creates the entry.
          activeSession = await getDocumentSession(documentId);
          if (active && activeSession) {
            setSessionName(activeSession.name);
            setSavedSessionName(activeSession.name);
            setSessionPinned(activeSession.pinned);
            setSessionArchived(activeSession.archived);
            setSessionTitleSource(activeSession.titleSource);
          }
        } catch {
          if (active) setNotice("Session names are unavailable, but this note can still be loaded.");
        }
        const markdown = await persistence.hydrate();
        // loadLocalDocument can discover an IndexedDB-only tombstone and write the
        // local marker during hydrate; re-check so we take the same recovery path.
        if (isLocalDocumentDeleted(documentId) && documentId !== DEFAULT_DOCUMENT_ID) {
          if (!active) return;
          redirectToOriginalAfterDelete();
          return;
        }
        if (!active) return;
        // A full migration scan is only needed when the loaded Markdown can
        // contain legacy inline-math delimiters. New edits still trigger the
        // narrow transaction scan below when they contain a dollar sign.
        inlineMathMigrationPendingRef.current = markdown.includes("$$");
        editor.commands.setContent(markdown, { contentType: "markdown", emitUpdate: false });
        latestMarkdown.set(markdown);
        recordVersion(documentId, markdown);
        persistence.markLoaded(markdown);
        // Legacy automatic sessions can still be named "Untitled" even when
        // their saved Markdown already has a readable heading. Refresh only
        // automatic metadata; updateAutomaticSessionTitle re-checks the stored
        // title source while locked, so a concurrent manual rename wins.
        if (activeSession?.titleSource === "automatic") {
          try {
            const titled = await updateAutomaticSessionTitle(
              documentId,
              automaticTitleFromMarkdown(markdown),
            );
            if (active) {
              setSessionName(titled.name);
              setSavedSessionName(titled.name);
              setSessionTitleSource(titled.titleSource);
            }
          } catch {
            // A metadata failure must not prevent the note from loading.
          }
        }
      } catch {
        if (active) setNotice("Could not load the saved note. A new local note is ready instead.");
      } finally {
        if (!active || !finishHydration) return;
        if (!persistence.getState().loaded) persistence.markLoaded(serializeMarkdown(editor));
        editor.setEditable(true, false);
        setHydrating(false);
        editor.commands.focus("end");
        syncInterface(editor);
        void refreshHealth();
      }
    })();
    return () => {
      active = false;
    };
  }, [documentId, editor, latestMarkdown, openedWithInvalidSessionHash, persistence, serializeMarkdown, setNotice, syncInterface]);

  useEffect(() => {
    if (!editor) return;
    const onResize = () => {
      positionCaret(editor);
      repositionPalette();
      repositionMathEditor();
    };
    window.addEventListener("resize", onResize, { passive: true });
    window.addEventListener("scroll", onResize, { passive: true });
    window.visualViewport?.addEventListener("resize", onResize, { passive: true });
    window.visualViewport?.addEventListener("scroll", onResize, { passive: true });
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("scroll", onResize);
    };
  }, [editor, positionCaret, repositionMathEditor, repositionPalette]);

  useLayoutEffect(() => {
    repositionPalette();
  }, [backlinks.length, filtered.length, filteredThemes.length, palette, rankedCommands.length, repositionPalette, sessions.length, versions.length]);

  useEffect(() => {
    const flush = () => {
      void persistence.flush();
    };
    const onPageHide = () => flush();
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      flush();
    };
  }, [persistence]);

  const onKeyDownCapture = (event: React.KeyboardEvent) => {
    if (imageCropTarget || imageMetadataTarget) return;
    const current = paletteRef.current;
    if (!current) {
      if (outlineOpenRef.current && event.key === "Escape") {
        event.preventDefault();
        closeOutline();
        return;
      }
      if (!editor || !(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      let commandId: string | null = null;
      if (key === "k" && !event.shiftKey && !event.altKey) commandId = "sessions";
      else if (key === "f" && event.shiftKey) commandId = "search";
      else if (key === "s" && event.shiftKey) commandId = "stats";
      else if (key === "h" && event.altKey) commandId = "history";
      else if (key === "l" && event.altKey) commandId = "language";
      else if (key === "k" && event.shiftKey) commandId = "edit-link";
      else if (key === "n" && event.shiftKey) commandId = "new";
      else if (key === "s" && !event.shiftKey && !event.altKey) commandId = "export";
      else if (key === "/") commandId = "shortcuts";
      if (commandId) {
        event.preventDefault();
        const command = COMMANDS.find((candidate) => candidate.id === commandId);
        if (!command) return;
        setPalette(paletteAtSelection(editor, "commands"));
        runCommand(command);
      }
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      if (current.mode === "name") setSessionName(savedSessionName);
      if (current.mode === "link-editor") setLinkEditorState(null);
      if (current.mode === "confirm-import") {
        cancelMarkdownImport();
        return;
      }
      setPalette(null);
      editor?.commands.focus();
      return;
    }

    if (current.mode === "name" || current.mode === "link-editor") return;

    if (current.mode === "search") {
      const isComposing = searchComposingRef.current || event.nativeEvent.isComposing;
      if (isComposing && (
        event.key === "ArrowDown"
        || event.key === "ArrowUp"
        || event.key === "Enter"
        || event.key === "Tab"
      )) return;

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        const count = Math.max(1, searchResults.length);
        setSelected((selectedRef.current + direction + count) % count);
      } else if ((event.key === "Enter" || event.key === "Tab") && searchResults.length > 0) {
        event.preventDefault();
        openSearchResult(searchResults[selectedRef.current] ?? searchResults[0]);
      } else if (event.key === "Enter") {
        event.preventDefault();
      }
      return;
    }

    if (current.mode === "sessions" || current.mode === "archives" || current.mode === "link-session") {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        const count = Math.max(1, sessions.length);
        setSelected((selectedRef.current + direction + count) % count);
      } else if ((event.key === "Enter" || event.key === "Tab") && sessions.length > 0) {
        event.preventDefault();
        const session = sessions[selectedRef.current] ?? sessions[0];
        if (current.mode === "link-session") {
          insertSessionLink(session);
        } else if (session.id === documentId) {
          setPalette(null);
          editor?.commands.focus();
        } else {
          void resumeSession(session);
        }
      }
      return;
    }

    if (current.mode === "language") {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setSelected((selectedRef.current + direction + CODE_LANGUAGES.length) % CODE_LANGUAGES.length);
      } else if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        chooseCodeLanguage(CODE_LANGUAGES[selectedRef.current]?.id ?? "");
      }
      return;
    }

    if (current.mode === "theme") {
      if (event.target instanceof HTMLAnchorElement) return;

      const isComposing = themeComposingRef.current || event.nativeEvent.isComposing;
      if (isComposing && (
        event.key === "ArrowDown"
        || event.key === "ArrowUp"
        || event.key === "Enter"
        || event.key === "Tab"
      )) return;

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        const count = Math.max(1, filteredThemes.length);
        setSelected((selectedRef.current + direction + count) % count);
      } else if (event.key === "Enter" && filteredThemes.length > 0) {
        event.preventDefault();
        chooseTheme(filteredThemes[selectedRef.current]?.id ?? filteredThemes[0].id);
      } else if (event.key === "Enter") {
        event.preventDefault();
      }
      return;
    }

    if (current.mode === "backlinks") {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        const count = Math.max(1, backlinks.length);
        setSelected((selectedRef.current + direction + count) % count);
      } else if ((event.key === "Enter" || event.key === "Tab") && backlinks.length > 0) {
        event.preventDefault();
        openBacklink(backlinks[selectedRef.current] ?? backlinks[0]);
      }
      return;
    }

    if (current.mode === "history") {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        const count = Math.max(1, versions.length);
        setSelected((selectedRef.current + direction + count) % count);
      } else if ((event.key === "Enter" || event.key === "Tab") && versions.length > 0) {
        event.preventDefault();
        restoreHistoryVersion(versions[selectedRef.current] ?? versions[0]);
      }
      return;
    }

    if (current.mode === "confirm-import") {
      if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) {
        event.preventDefault();
        void confirmMarkdownImport();
      }
      return;
    }

    if (current.mode === "confirm-clear") {
      if (event.key === "Enter") {
        event.preventDefault();
        if (editor) recordVersion(documentId, serializeMarkdown(editor));
        editor?.commands.clearContent(true);
        setPalette(null);
        editor?.commands.focus("start");
      } else if (event.key.length === 1) {
        setPalette(null);
      }
      return;
    }

    if (current.mode === "confirm-delete") {
      if (event.key === "Enter") {
        event.preventDefault();
        setPalette(null);
        void deleteActiveSession();
      } else if (event.key.length === 1) {
        setPalette(null);
      }
      return;
    }

    if (current.mode === "status" || current.mode === "stats" || current.mode === "shortcuts") {
      if (event.key === "Enter") event.preventDefault();
      if (event.key.length === 1 || event.key === "Enter") setPalette(null);
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const count = Math.max(1, filtered.length);
      setSelected((selectedRef.current + direction + count) % count);
      return;
    }

    if (event.key === "Enter" || event.key === "Tab") {
      if (rankedCommands.length > 0) event.preventDefault();
      if (filtered.length > 0) {
        runCommand(filtered[selectedRef.current] ?? filtered[0]);
      }
    }
  };

  const onImport = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !editor) return;
    if (pendingMarkdownImportRef.current) {
      pendingMarkdownImportRef.current = null;
      setPendingMarkdownImport(null);
      importConfirmingRef.current = false;
      setImportConfirming(false);
      if (paletteRef.current?.mode === "confirm-import") setPalette(null);
    }
    const requestId = importRequestRef.current + 1;
    importRequestRef.current = requestId;
    const revisionAtSelection = persistence.getState().editRevision;
    const currentMarkdown = serializeMarkdown(editor);
    void file.text()
      .then((markdown) => {
        if (requestId !== importRequestRef.current) return;
        if (
          revisionAtSelection !== persistence.getState().editRevision
          || serializeMarkdown(editor) !== currentMarkdown
        ) {
          setNotice("The note changed while the file was loading. Import was cancelled.");
          return;
        }
        if (!currentMarkdown.trim()) {
          applyMarkdownImport(markdown, file.name);
          return;
        }
        const pending = {
          markdown,
          fileName: file.name,
          revision: revisionAtSelection,
          currentMarkdown,
        };
        pendingMarkdownImportRef.current = pending;
        setPendingMarkdownImport(pending);
        importConfirmingRef.current = false;
        setImportConfirming(false);
        setNotice(null);
        setPalette(paletteAtSelection(editor, "confirm-import"));
      })
      .catch(() => {
        if (requestId === importRequestRef.current) {
          setNotice("The selected file could not be read as Markdown.");
        }
      });
  };

  const onVaultRestore = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !editor) return;
    if (file.size > MAX_VAULT_BACKUP_BYTES) {
      setNotice("The selected vault backup is too large.");
      event.target.value = "";
      return;
    }
    const revisionAtRequest = persistence.getState().editRevision;
    void file.text()
      .then(async (text) => {
        let backup: ReturnType<typeof parseVaultBackup>;
        try {
          backup = parseVaultBackup(text);
        } catch (error) {
          setNotice(error instanceof Error ? error.message : "The selected vault backup is invalid.");
          return;
        }
        if (revisionAtRequest !== persistence.getState().editRevision) {
          setNotice("The note changed while the vault backup was loading. Restore was cancelled.");
          return;
        }
        if (!(await persistence.flush())) {
          setNotice("The vault could not be restored because this note was not fully saved.");
          return;
        }
        if (!(await sessionTouchBarrier.wait())) {
          setNotice("The vault could not be restored because session metadata was not fully saved.");
          return;
        }
        if (revisionAtRequest !== persistence.getState().editRevision) {
          setNotice("The note changed while the vault backup was loading. Restore was cancelled.");
          return;
        }
        const confirmed = window.confirm(
          `Restore ${backup.sessions.length} ${backup.sessions.length === 1 ? "session" : "sessions"} from this backup? Existing sessions will never be replaced; conflicts will be restored as new sessions.`,
        );
        if (!confirmed) {
          setNotice("Vault restore cancelled.");
          return;
        }
        try {
          const result = await restoreLocalVault(backup, { activeDocumentId: documentId });
          if (result.activeDocumentUpdated) {
            window.location.reload();
            return;
          }
          const imported = `${result.imported} ${result.imported === 1 ? "session" : "sessions"}`;
          const skipped = `${result.skipped} existing ${result.skipped === 1 ? "session was" : "sessions were"} already present`;
          const conflict = result.renamed > 0
            ? ` ${result.renamed} conflict${result.renamed === 1 ? " was" : "s were"} restored under a new id.`
            : "";
          setNotice(`Restored ${imported}; ${skipped}.${conflict}`);
        } catch (error) {
          setNotice(error instanceof Error ? error.message : "The vault backup could not be restored.");
        }
      })
      .catch(() => setNotice("The selected vault backup could not be read."));
    event.target.value = "";
  };

  const onImageImport = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || !editor || files.length === 0) return;
    void insertImageFiles(editor, files, {
      onNotice: (message) => setNotice(message),
      selection: {
        from: editor.state.selection.from,
        to: editor.state.selection.to,
      },
    });
    event.target.value = "";
  };

  const applyImageCrop = useCallback((dataUrl: string) => {
    const target = imageCropTarget;
    const instance = editorRef.current;
    if (!target || !instance) return;
    const node = instance.state.doc.nodeAt(target.pos);
    if (!node || node.type.name !== "image") {
      setImageCropTarget(null);
      return;
    }
    instance.commands.setNodeSelection(target.pos);
    instance.commands.updateAttributes("image", { src: dataUrl, width: null, height: null });
    setImageCropTarget(null);
  }, [imageCropTarget]);

  const cancelImageCrop = useCallback(() => {
    setImageCropTarget(null);
  }, []);

  const applyImageMetadata = useCallback((metadata: { alt: string; title: string }) => {
    const target = imageMetadataTarget;
    const instance = editorRef.current;
    if (!target || !instance) return;
    const node = instance.state.doc.nodeAt(target.pos);
    if (!node || node.type.name !== "image") {
      setImageMetadataTarget(null);
      return;
    }
    instance.commands.setNodeSelection(target.pos);
    instance.commands.updateAttributes("image", {
      alt: metadata.alt.trim(),
      title: metadata.title.trim() || null,
    });
    setImageMetadataTarget(null);
    setNotice("Updated image alt text and title.");
  }, [imageMetadataTarget, setNotice]);

  const cancelImageMetadata = useCallback(() => {
    setImageMetadataTarget(null);
  }, []);

  const onMathEditorKeyDown = (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelMathEditor();
      return;
    }
    if (event.key === "Tab" || (event.key === "Enter" && (mathEditorState?.kind === "inline" || event.metaKey || event.ctrlKey))) {
      event.preventDefault();
      commitMathEditor();
    }
  };

  const onMathEditorBlur = () => {
    const stateAtBlur = mathEditorRef.current;
    window.setTimeout(() => {
      if (
        stateAtBlur
        && sameMathEditor(mathEditorRef.current, stateAtBlur)
        && !mathEditorElementRef.current?.contains(document.activeElement)
      ) {
        commitMathEditor();
      }
    }, 0);
  };

  return (
    <div className="lab-shell" ref={shellRef} onKeyDownCapture={onKeyDownCapture}>
      <EditorContent editor={editor} aria-busy={hydrating} />
      {outlineOpen ? (
        <>
          <div
            className="outline-backdrop"
            aria-hidden="true"
            onClick={() => closeOutline()}
          />
          <aside
            ref={outlinePanelRef}
            className="outline-panel"
            data-testid="document-outline"
            role={mobileOutline ? "dialog" : undefined}
            aria-modal={mobileOutline ? "true" : undefined}
            aria-labelledby="document-outline-title"
            tabIndex={mobileOutline ? -1 : undefined}
            onKeyDown={(event) => {
              if (!mobileOutline || event.key !== "Tab") return;

              const panel = outlinePanelRef.current;
              if (!panel) return;
              const focusable = Array.from(
                panel.querySelectorAll<HTMLElement>(
                  "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]",
                ),
              ).filter((element) => element !== panel && element.tabIndex >= 0 && !element.hasAttribute("aria-hidden"));
              if (focusable.length === 0) {
                event.preventDefault();
                panel.focus();
                return;
              }

              const first = focusable[0];
              const last = focusable[focusable.length - 1];
              const active = document.activeElement;
              if (
                active === panel
                || !panel.contains(active)
                || (event.shiftKey && active === first)
                || (!event.shiftKey && active === last)
              ) {
                event.preventDefault();
                (event.shiftKey ? last : first).focus();
              }
            }}
          >
            <div className="outline-header">
              <div>
                <h2 id="document-outline-title">Outline</h2>
                <p>{outlineItems.length === 0 ? "No sections yet" : `${outlineItems.length} ${outlineItems.length === 1 ? "section" : "sections"}`}</p>
              </div>
              <button
                type="button"
                className="outline-close"
                aria-label="Close outline"
                onClick={() => closeOutline()}
              >
                ×
              </button>
            </div>
            {outlineItems.length > 0 ? (
              <nav className="outline-navigation" aria-label="Document headings">
                <ol className="outline-list">
                  {outlineItems.map((item) => {
                    const active = item.id === activeOutlineId;
                    return (
                      <li key={item.id} data-depth={item.depth}>
                        <button
                          type="button"
                          className="outline-item"
                          data-active={active}
                          data-level={item.level}
                          aria-current={active ? "location" : undefined}
                          title={item.title}
                          onClick={() => navigateToOutlineHeading(item.id)}
                        >
                          <span className="outline-item-marker" aria-hidden="true" />
                          <span className="outline-item-label">{item.title}</span>
                        </button>
                      </li>
                    );
                  })}
                </ol>
              </nav>
            ) : (
              <p className="outline-empty">Type a heading with <code>#</code> to build your outline.</p>
            )}
          </aside>
        </>
      ) : null}
      {imageCropTarget ? (
        <ImageCropDialog
          src={imageCropTarget.src}
          alt={imageCropTarget.alt}
          onCancel={cancelImageCrop}
          onApply={applyImageCrop}
        />
      ) : null}
      {imageMetadataTarget ? (
        <ImageMetadataDialog
          target={{ alt: imageMetadataTarget.alt, title: imageMetadataTarget.title }}
          onSave={applyImageMetadata}
          onCancel={cancelImageMetadata}
        />
      ) : null}
      {mathEditorState ? (
        <div
          ref={mathEditorElementRef}
          id={MATH_EDITOR_ID}
          className="math-editor-popover"
          data-kind={mathEditorState.kind}
          role="dialog"
          aria-label={mathEditorState.kind === "block" ? "Edit block equation" : "Edit inline equation"}
          style={{ left: Math.round(mathEditorState.left), top: Math.round(mathEditorState.top) }}
          onBlur={onMathEditorBlur}
        >
          <label htmlFor={`${MATH_EDITOR_ID}-input`}>
            {mathEditorState.kind === "block" ? "Block equation" : "Inline equation"}
          </label>
          {mathEditorState.kind === "block" ? (
            <textarea
              ref={(element) => { mathInputRef.current = element; }}
              id={`${MATH_EDITOR_ID}-input`}
              value={mathEditorState.latex}
              rows={3}
              spellCheck={false}
              aria-describedby={`${MATH_EDITOR_ID}-hint`}
              aria-invalid={Boolean(mathError && mathEditorState.latex.trim())}
              onChange={(event) => updateMathLatex(event.target.value)}
              onKeyDown={onMathEditorKeyDown}
            />
          ) : (
            <input
              ref={(element) => { mathInputRef.current = element; }}
              id={`${MATH_EDITOR_ID}-input`}
              value={mathEditorState.latex}
              spellCheck={false}
              aria-describedby={`${MATH_EDITOR_ID}-hint`}
              aria-invalid={Boolean(mathError && mathEditorState.latex.trim())}
              onChange={(event) => updateMathLatex(event.target.value)}
              onKeyDown={onMathEditorKeyDown}
            />
          )}
          {mathPreview ? (
            <div
              className="math-editor-preview"
              aria-hidden="true"
              // KaTeX owns this generated markup; trust:false above prevents
              // user LaTeX from turning it into links or raw HTML.
              dangerouslySetInnerHTML={{ __html: mathPreview }}
            />
          ) : null}
          <div
            id={`${MATH_EDITOR_ID}-hint`}
            className="math-editor-hint"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            data-testid="math-editor-status"
            data-error={mathError ? "true" : "false"}
          >
            {mathError ?? (mathEditorState.kind === "block" ? "Cmd/Ctrl + Enter to finish" : "Enter to finish")}
          </div>
        </div>
      ) : null}
      <div ref={caretRef} className="lab-caret" aria-hidden="true">
        <span ref={caretStrokeRef} className="lab-caret-stroke" data-blinking="true" />
      </div>
      <input ref={fileInputRef} hidden type="file" accept=".md,.markdown,text/markdown,text/plain" tabIndex={-1} aria-hidden="true" onChange={onImport} />
      <input ref={vaultBackupInputRef} hidden type="file" accept=".json,.lab-vault,application/json" tabIndex={-1} aria-hidden="true" onChange={onVaultRestore} />
      <input ref={imageInputRef} hidden type="file" accept="image/*" multiple tabIndex={-1} aria-hidden="true" onChange={onImageImport} />

      {palette ? (
        <div
          ref={paletteElementRef}
          className="command-palette-positioner"
          style={{ left: Math.round(palette.left), top: Math.round(palette.top) }}
        >
          <motion.div
            className="command-palette-motion"
            initial={prefersReducedMotion ? { opacity: 0, transform: "none" } : SLASH_PALETTE_INITIAL}
            animate={{ opacity: 1, transform: "translateY(0px) scale(1)" }}
            transition={prefersReducedMotion ? { duration: 0.08, ease: [0.23, 1, 0.32, 1] } : SLASH_PALETTE_TRANSITION}
          >
          <BorderBeam
            className="command-palette-frame"
            size="line"
            colorVariant="mono"
            theme={THEMES.find((theme) => theme.id === activeTheme)?.colorScheme ?? "dark"}
            staticColors
            duration={3.2}
            active={(palette.mode === "commands" || palette.mode === "search") && !prefersReducedMotion}
            strength={0.42}
            brightness={1.05}
            saturation={0}
            borderRadius={13}
          >
          <div
            id={PALETTE_ID}
            className="command-palette"
            role={palette.mode === "commands" || palette.mode === "sessions" || palette.mode === "archives" || palette.mode === "link-session" || palette.mode === "language" || palette.mode === "backlinks" || palette.mode === "history" ? "listbox" : palette.mode === "name" || palette.mode === "search" || palette.mode === "theme" || palette.mode === "link-editor" || palette.mode === "confirm-import" ? "dialog" : "status"}
            aria-label={palette.mode === "sessions" ? "Document sessions" : palette.mode === "archives" ? "Archived sessions" : palette.mode === "link-session" ? "Choose a session to link" : palette.mode === "search" ? "Search local notes" : palette.mode === "language" ? "Code block language" : palette.mode === "theme" ? "Choose a theme" : palette.mode === "backlinks" ? "Backlinks" : palette.mode === "history" ? "Version history" : palette.mode === "link-editor" ? "Edit link" : palette.mode === "confirm-import" ? "Confirm Markdown import" : "Slash commands"}
          >
          {palette.mode === "commands" ? (
            rankedCommands.length > 0 ? (
              <LayoutGroup id="slash-command-selection">
                <div className="command-list">
                  {rankedCommands.map(({ command, availability }) => {
                    const selectableIndex = availability.available
                      ? filtered.findIndex((candidate) => candidate.id === command.id)
                      : -1;
                    const isSelected = selectableIndex >= 0 && selectableIndex === selected;
                    const reasonId = `${PALETTE_ID}-${command.id}-reason`;
                    return (
                      <div
                        className="command-item"
                        data-motion-selection={isSelected}
                        data-selected={isSelected}
                        data-disabled={!availability.available}
                        id={`${PALETTE_ID}-${command.id}`}
                        key={command.id}
                        role="option"
                        aria-selected={isSelected}
                        aria-disabled={!availability.available}
                        aria-describedby={reasonId}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          if (availability.available) runCommand(command);
                        }}
                        onMouseEnter={() => {
                          if (selectableIndex >= 0) setSelected(selectableIndex);
                        }}
                      >
                        {isSelected ? (
                          <motion.div
                            className="command-selection-motion"
                            layoutId="slash-command-selection"
                            transition={prefersReducedMotion ? { duration: 0 } : SLASH_SELECTION_TRANSITION}
                            aria-hidden="true"
                          />
                        ) : null}
                        <span>{command.label}</span>
                        <small id={reasonId}>{availability.reason ?? command.detail}</small>
                      </div>
                    );
                  })}
                </div>
              </LayoutGroup>
            ) : (
              <div className="palette-message">No command</div>
            )
          ) : palette.mode === "search" ? (
            <div className="search-panel" data-testid="search-panel">
              <div className="search-field">
                <span className="search-field-prefix" aria-hidden="true">/</span>
                <input
                  ref={searchInputRef}
                  type="search"
                  role="combobox"
                  aria-label="Search local notes"
                  aria-expanded="true"
                  aria-controls={`${PALETTE_ID}-results`}
                  aria-activedescendant={!searchLoading && searchResults[selected]
                    ? `${PALETTE_ID}-search-${searchResults[selected].documentId}`
                    : undefined}
                  aria-autocomplete="list"
                  aria-haspopup="listbox"
                  autoComplete="off"
                  placeholder="Search sessions and note text"
                  value={palette.query}
                  onChange={(event) => updateSearchQuery(event.target.value)}
                  onCompositionStart={() => { searchComposingRef.current = true; }}
                  onCompositionEnd={() => { searchComposingRef.current = false; }}
                />
                <kbd>Esc</kbd>
              </div>
              <div className="search-summary" role="status" aria-live="polite">
                {searchLoading
                  ? "Indexing local notes…"
                  : palette.query.trim()
                    ? `${searchResults.length} ${searchResults.length === 1 ? "match" : "matches"}`
                    : `${sessions.length} local ${sessions.length === 1 ? "session" : "sessions"}`}
              </div>
              <div id={`${PALETTE_ID}-results`} className="search-results" role="listbox" aria-label="Search results">
                {searchLoading ? (
                  <div className="search-empty">Reading verified local copies…</div>
                ) : palette.query.trim() && searchResults.length > 0 ? (
                  searchResults.map((result, index) => (
                    <div
                      ref={(element) => {
                        if (element) searchResultRefs.current.set(result.documentId, element);
                        else searchResultRefs.current.delete(result.documentId);
                      }}
                      className="search-result"
                      data-testid="search-result"
                      data-selected={index === selected}
                      data-current={result.documentId === documentId}
                      id={`${PALETTE_ID}-search-${result.documentId}`}
                      key={result.documentId}
                      role="option"
                      aria-selected={index === selected}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        openSearchResult(result);
                      }}
                      onMouseEnter={() => setSelected(index)}
                    >
                      <div className="search-result-heading">
                        <span>{highlightSearchText(result.name, palette.query)}</span>
                        <small>
                          {result.documentId === documentId ? "Current session · " : ""}
                          {result.match === "name"
                            ? "Session name"
                            : result.match === "content"
                              ? "Note text"
                              : "Name + note text"}
                        </small>
                      </div>
                      <div className="search-result-excerpt">
                        {highlightSearchText(result.excerpt || "Session name match", palette.query)}
                      </div>
                    </div>
                  ))
                ) : palette.query.trim() ? (
                  <div className="search-empty">No local notes match “{palette.query.trim()}”.</div>
                ) : (
                  <div className="search-empty">Search session names and the text of every local note.</div>
                )}
              </div>
              <div className="search-footer">↑↓ move · Enter open · Esc close · local only</div>
            </div>
          ) : palette.mode === "name" ? (
            <div className="session-name-panel">
              <label htmlFor="session-name-input">Session name</label>
              <input
                ref={sessionNameInputRef}
                id="session-name-input"
                value={sessionName}
                maxLength={80}
                autoComplete="off"
                onChange={(event) => setSessionName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    submitSessionName();
                  }
                }}
              />
              <small>Enter to save · Esc to cancel</small>
            </div>
          ) : palette.mode === "sessions" || palette.mode === "archives" || palette.mode === "link-session" ? (
            <div className="command-list session-list" data-testid="session-list">
              {sessions.length > 0 ? sessions.map((session, index) => (
                <div
                  className="command-item"
                  data-selected={index === selected}
                  data-current={session.id === documentId}
                  id={`${PALETTE_ID}-session-${session.id}`}
                  key={session.id}
                  role="option"
                  aria-selected={index === selected}
                  aria-current={session.id === documentId ? "true" : undefined}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    if (palette.mode === "link-session") {
                      insertSessionLink(session);
                    } else if (session.id === documentId) {
                      setPalette(null);
                      editor?.commands.focus();
                    } else {
                      void resumeSession(session);
                    }
                  }}
                  onMouseEnter={() => setSelected(index)}
                >
                  <span>{session.pinned ? "◆ " : ""}{session.name}</span>
                  <small>
                    {palette.mode === "link-session"
                      ? session.archived ? "Archived · insert local link" : "Insert local link"
                      : session.id === documentId
                        ? "Current session"
                        : session.updatedAt > 0 ? new Date(session.updatedAt).toLocaleString() : "Original session"}
                  </small>
                </div>
              )) : (
                <div className="palette-message">
                  <span>{palette.mode === "archives" ? "No archived sessions" : palette.mode === "link-session" ? "No other sessions to link" : "No sessions"}</span>
                  <small>Esc to return to the editor</small>
                </div>
              )}
            </div>
          ) : palette.mode === "stats" ? (
            <StatsPanel stats={stats} />
          ) : palette.mode === "shortcuts" ? (
            <ShortcutsPanel shortcuts={KEYBOARD_SHORTCUTS} />
          ) : palette.mode === "language" ? (
            <div className="command-list language-list" data-testid="language-list">
              {CODE_LANGUAGES.map((language, index) => (
                <div
                  className="command-item"
                  data-selected={index === selected}
                  id={`${PALETTE_ID}-language-${language.id || "plain"}`}
                  key={language.id || "plain"}
                  role="option"
                  aria-selected={index === selected}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    chooseCodeLanguage(language.id);
                  }}
                  onMouseEnter={() => setSelected(index)}
                >
                  <span>{language.label}</span>
                  <small>{language.id ? `\`\`\`${language.id}` : "No fence identifier"}</small>
                </div>
              ))}
            </div>
          ) : palette.mode === "theme" ? (
            <div className="theme-panel" data-testid="theme-panel">
              <div className="search-field">
                <span className="search-field-prefix" aria-hidden="true">◐</span>
                <input
                  ref={themeSearchInputRef}
                  type="search"
                  role="combobox"
                  aria-label="Search themes"
                  aria-expanded="true"
                  aria-controls={`${PALETTE_ID}-theme-results`}
                  aria-activedescendant={filteredThemes[selected]
                    ? `${PALETTE_ID}-theme-${filteredThemes[selected].id}`
                    : undefined}
                  aria-autocomplete="list"
                  aria-haspopup="listbox"
                  autoComplete="off"
                  placeholder="Search themes"
                  value={palette.query}
                  onCompositionStart={() => { themeComposingRef.current = true; }}
                  onCompositionEnd={() => { themeComposingRef.current = false; }}
                  onChange={(event) => {
                    setSelected(0);
                    setPalette({ ...palette, query: event.target.value });
                  }}
                />
                <kbd>Esc</kbd>
              </div>
              <div
                id={`${PALETTE_ID}-theme-results`}
                className="command-list theme-list"
                data-testid="theme-list"
                role="listbox"
                aria-label="Theme results"
                tabIndex={-1}
              >
                {filteredThemes.length > 0 ? filteredThemes.map((theme, index) => (
                  <div
                    className="command-item theme-item"
                    data-selected={index === selected}
                    data-current={theme.id === activeTheme}
                    id={`${PALETTE_ID}-theme-${theme.id}`}
                    key={theme.id}
                    role="option"
                    aria-selected={index === selected}
                    aria-current={theme.id === activeTheme ? "true" : undefined}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      chooseTheme(theme.id);
                    }}
                    onMouseEnter={() => setSelected(index)}
                  >
                    <span className="theme-label">
                      <span className="theme-swatches" aria-hidden="true">
                        {theme.swatches.map((color) => (
                          <span key={color} style={{ backgroundColor: color }} />
                        ))}
                      </span>
                      {theme.label}
                    </span>
                    <small>{theme.id === activeTheme ? "Current" : theme.detail}</small>
                  </div>
                )) : (
                  <div className="search-empty">No themes match “{palette.query.trim()}”.</div>
                )}
              </div>
              <div className="search-footer theme-footer">
                <span>{filteredThemes.length} {filteredThemes.length === 1 ? "theme" : "themes"} · ↑↓ move · Enter select</span>
                <a href="./third-party-notices/" target="_blank" rel="noreferrer">Licenses</a>
              </div>
            </div>
          ) : palette.mode === "backlinks" ? (
            <div className="feature-list-panel" data-testid="backlinks-panel">
              <div className="feature-list-header">
                <span>Backlinks</span>
                <small>{backlinksLoading ? "Reading local notes…" : `${backlinks.length} incoming ${backlinks.length === 1 ? "link" : "links"}`}</small>
              </div>
              <div className="command-list feature-result-list">
                {backlinksLoading ? (
                  <div className="palette-message"><span>Finding links…</span><small>Verified local copies only</small></div>
                ) : backlinks.length > 0 ? backlinks.map((backlink, index) => (
                  <div
                    className="command-item feature-result-item"
                    data-selected={index === selected}
                    id={`${PALETTE_ID}-backlink-${backlink.documentId}`}
                    key={backlink.documentId}
                    role="option"
                    aria-selected={index === selected}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      openBacklink(backlink);
                    }}
                    onMouseEnter={() => setSelected(index)}
                  >
                    <span>{backlink.name}</span>
                    <small>{backlink.excerpt}</small>
                  </div>
                )) : (
                  <div className="palette-message"><span>No backlinks yet</span><small>Use /link-note in another session to create one</small></div>
                )}
              </div>
            </div>
          ) : palette.mode === "history" ? (
            <div className="feature-list-panel" data-testid="version-history-panel">
              <div className="feature-list-header">
                <span>Version history</span>
                <small>{versions.length} local {versions.length === 1 ? "version" : "versions"}</small>
              </div>
              <div className="command-list feature-result-list">
                {versions.length > 0 ? versions.map((version, index) => {
                  const versionStats = calculateDocumentStats(version.markdown);
                  return (
                    <div
                      className="command-item feature-result-item"
                      data-selected={index === selected}
                      id={`${PALETTE_ID}-version-${version.id}`}
                      key={version.id}
                      role="option"
                      aria-selected={index === selected}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        restoreHistoryVersion(version);
                      }}
                      onMouseEnter={() => setSelected(index)}
                    >
                      <span>{new Date(version.createdAt).toLocaleString()}</span>
                      <small>{versionStats.words} {versionStats.words === 1 ? "word" : "words"} · Enter to restore</small>
                    </div>
                  );
                }) : (
                  <div className="palette-message"><span>No saved versions yet</span><small>Versions appear after durable local saves</small></div>
                )}
              </div>
            </div>
          ) : palette.mode === "link-editor" && linkEditorState ? (
            <LinkEditorPanel
              label={linkEditorState.label}
              href={linkEditorState.href}
              onLabelChange={(label) => setLinkEditorState((current) => current ? { ...current, label } : current)}
              onHrefChange={(href) => setLinkEditorState((current) => current ? { ...current, href } : current)}
              onSave={() => saveEditedLink(linkEditorState.label, linkEditorState.href)}
              onRemove={removeEditedLink}
              onCancel={() => {
                setLinkEditorState(null);
                setPalette(null);
                editor?.commands.focus();
              }}
              saveDisabled={!linkEditorState.label.trim() || !linkEditorState.href.trim()}
            />
          ) : palette.mode === "confirm-import" ? (
            <div className="palette-message palette-confirm" data-testid="confirm-import">
              <span>Replace this note with “{pendingMarkdownImport?.fileName || "the selected Markdown file"}”?</span>
              <small>The current note will be kept in version history.</small>
              <div className="feature-form-actions">
                <button
                  ref={importConfirmButtonRef}
                  type="button"
                  className="feature-button feature-button-primary"
                  disabled={importConfirming}
                  onClick={() => { void confirmMarkdownImport(); }}
                >
                  Import file
                </button>
                <button
                  type="button"
                  className="feature-button"
                  disabled={importConfirming}
                  onClick={() => cancelMarkdownImport()}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : palette.mode === "confirm-clear" ? (
            <div className="palette-message palette-confirm">
              <span>Clear the note?</span>
              <small>Press Enter to confirm · Esc to keep it</small>
            </div>
          ) : palette.mode === "confirm-delete" ? (
            <div className="palette-message palette-confirm" data-testid="confirm-delete">
              <span>Delete this session permanently?</span>
              <small>Press Enter to confirm · Esc to keep it</small>
            </div>
          ) : (
            <div className="palette-message storage-message" data-testid="storage-status">
              <span>{health.copies} local {health.copies === 1 ? "copy" : "copies"}</span>
              <small>{health.labels.join(" · ") || "Storage is unavailable"}</small>
              {health.conflicts > 0 ? <small>{health.conflicts} recoverable {health.conflicts === 1 ? "draft" : "drafts"} · /recover to export</small> : null}
              {formattedStorageEstimate ? <small>Approximate browser storage: {formattedStorageEstimate}</small> : null}
              <small>{health.persistent ? "Persistent storage granted" : "Browser-managed persistence"} · no network access</small>
            </div>
          )}
          </div>
          </BorderBeam>
          </motion.div>
        </div>
      ) : null}
      {notice ? (
        <div
          className="editor-notice"
          data-kind={notice.kind}
          data-testid="editor-notice"
          role={notice.kind === "info" ? "status" : "alert"}
          aria-live={notice.kind === "info" ? "polite" : "assertive"}
          aria-atomic="true"
        >
          <span className="editor-notice-message">{notice.message}</span>
          <button
            className="feature-button editor-notice-dismiss"
            type="button"
            aria-label="Dismiss notification"
            onClick={() => { noticeController.dismiss(notice.id); }}
          >
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  );
}
