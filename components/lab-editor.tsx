"use client";

import { Extension, InputRule, type Editor } from "@tiptap/core";
import Placeholder from "@tiptap/extension-placeholder";
import { TableKit } from "@tiptap/extension-table";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { BlockMath, InlineMath } from "@tiptap/extension-mathematics";
import { Markdown } from "@tiptap/markdown";
import { closeHistory } from "@tiptap/pm/history";
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection } from "@tiptap/pm/state";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import katex from "katex";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  createEditorPersistenceController,
  type EditorPersistenceController,
} from "@/lib/editor-persistence";
import {
  DEFAULT_DOCUMENT_ID,
  inspectLocalStorage,
  isLocalDocumentDeleted,
  listLocalRecoveryDrafts,
  requestPersistentStorage,
  setLocalDocumentScope,
  type LocalRecoveryDraft,
  type StorageHealth,
} from "@/lib/local-vault";
import {
  activeDocumentIdFromLocation,
  clearInvalidDocumentSessionHash,
  createDocumentSession,
  documentSessionHash,
  getDocumentSession,
  listDocumentSessions,
  parseActiveDocumentLocation,
  purgeDocumentSession,
  renameDocumentSession,
  touchDocumentSession,
  type DocumentSession,
} from "@/lib/document-sessions";
import { classifyClipboardPaste } from "@/lib/paste-normalization";

type SlashRange = { from: number; to: number };
type PaletteMode = "commands" | "status" | "stats" | "confirm-clear" | "confirm-delete" | "name" | "sessions";
type PaletteAnchor = { left: number; top: number; bottom: number };
type PaletteState = {
  query: string;
  range: SlashRange;
  left: number;
  top: number;
  mode: PaletteMode;
  anchor: PaletteAnchor;
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

const COMMANDS: Command[] = [
  { id: "text", label: "Text", detail: "Plain paragraph", terms: "paragraph normal" },
  { id: "h1", label: "Heading 1", detail: "Large section title", terms: "title h1" },
  { id: "h2", label: "Heading 2", detail: "Medium section title", terms: "subtitle h2" },
  { id: "h3", label: "Heading 3", detail: "Small section title", terms: "subtitle h3" },
  { id: "bullet", label: "Bulleted list", detail: "Create an unordered list", terms: "ul list bullets" },
  { id: "number", label: "Numbered list", detail: "Create an ordered list", terms: "ol list numbers" },
  { id: "todo", label: "To-do list", detail: "Create a checklist", terms: "task check checkbox" },
  { id: "quote", label: "Quote", detail: "Create a block quote", terms: "blockquote citation" },
  { id: "code", label: "Code block", detail: "Write preformatted code", terms: "pre snippet" },
  { id: "divider", label: "Divider", detail: "Separate sections", terms: "rule hr line" },
  { id: "table", label: "Table", detail: "Insert a 3 × 3 Markdown table", terms: "grid rows columns" },
  { id: "inline-math", label: "Inline equation", detail: "Write LaTeX within a line", terms: "math latex formula inline equation" },
  { id: "math", label: "Block equation", detail: "Write a centered LaTeX equation", terms: "math latex formula display equation" },
  { id: "link", label: "Link", detail: "Type a URL, then close with )", terms: "url href markdown" },
  { id: "undo", label: "Undo", detail: "Undo the last change", terms: "back history" },
  { id: "redo", label: "Redo", detail: "Redo the last change", terms: "forward history" },
  { id: "import", label: "Import Markdown", detail: "Open a local .md file", terms: "open file load" },
  { id: "export", label: "Export Markdown", detail: "Save a local .md copy", terms: "download file save" },
  { id: "recover", label: "Export recovery drafts", detail: "Download conflicting local drafts", terms: "conflict restore backup" },
  { id: "new", label: "New session", detail: "Start a separate document", terms: "document note create" },
  { id: "name", label: "Name session", detail: "Rename this document", terms: "document note title rename" },
  { id: "sessions", label: "Sessions", detail: "Resume another document", terms: "documents notes switch open resume" },
  { id: "delete", label: "Delete session", detail: "Remove this document permanently", terms: "remove destroy discard session document" },
  { id: "stats", label: "Note stats", detail: "Count words, characters, and reading time", terms: "words characters reading count metrics" },
  { id: "status", label: "Storage status", detail: "Inspect local redundancy", terms: "local-only copies offline" },
  { id: "clear", label: "Clear note", detail: "Requires a second Enter", terms: "delete erase reset" },
];

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
});

const EMPTY_HEALTH: StorageHealth = { copies: 0, labels: [], persistent: false, errors: [], conflicts: 0 };
const PALETTE_ID = "slash-command-palette";
const MATH_EDITOR_ID = "math-editor-popover";
const MARKDOWN_LINK_PATTERN = /\[([^\]]+)]\((https?:\/\/[^\s)]+)\)$/;
const INLINE_MATH_PATTERN = /^\$\$((?:\\\$|[^$\n])+?)\$\$$/;
const BLOCK_MATH_PATTERN = /^\$\$\n([\s\S]*?)\n\$\$(?:\n)?$/;

function isCodeBlock(parent: { type: { name: string } }) {
  return parent.type.name === "codeBlock";
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

function downloadMarkdown(filename: string, markdown: string) {
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  globalThis.setTimeout(() => URL.revokeObjectURL(anchor.href), 0);
}

function recoveryBundle(drafts: readonly LocalRecoveryDraft[]) {
  if (drafts.length === 1) return drafts[0].markdown;
  return drafts.map((draft, index) => {
    const date = new Date(draft.updatedAt);
    const stagedAt = Number.isNaN(date.getTime()) ? String(draft.updatedAt) : date.toISOString();
    return `<!-- lab recovery draft ${index + 1}; staged ${stagedAt} -->\n\n${draft.markdown}`;
  }).join("\n\n---\n\n");
}

const PlainUrlInput = Extension.create({
  name: "plainUrlInput",
  addInputRules() {
    return [
      new InputRule({
        find: (text) => {
          const match = text.match(/https?:\/\/[^\s)]+$/);
          if (!match || match.index === undefined || text.slice(0, match.index).endsWith("](")) return null;
          const href = match[0].replace(/[.,!?;:]+$/, "");
          return href ? { index: match.index, text: href } : null;
        },
        handler: ({ state, range, match }) => {
          if (isCodeBlock(state.selection.$from.parent)) return;
          const href = match[0];
          const linkMark = state.schema.marks.link;
          if (!linkMark) return;
          state.tr.replaceWith(
            range.from,
            range.to,
            state.schema.text(href, [linkMark.create({ href })]),
          );
        },
      }),
    ];
  },
});

const SlashCommandInput = Extension.create({
  name: "slashCommandInput",
  addInputRules() {
    return [
      new InputRule({
        find: (text) => {
          const match = text.match(/(?:^|\s)\/([a-z0-9-]*)$/i);
          if (!match || match.index === undefined) return null;
          return { index: match.index, text: match[0] };
        },
        undoable: false,
        handler: ({ state, range, match }) => {
          if (isCodeBlock(state.selection.$from.parent)) return;
          const typedLength = match[0].length - (range.to - range.from);
          if (typedLength <= 0) return;
          const typedText = match[0].slice(-typedLength);
          state.tr.insertText(typedText, range.to, range.to).setMeta("addToHistory", false);
        },
      }),
    ];
  },
});

/**
 * Gate vault scope + persistence until the client has the real URL hash.
 * Static pre-render and SSR have no hash, so mounting LabEditorSession there
 * would permanently bind the default document for deep-linked sessions.
 * useSyncExternalStore avoids setState-in-effect while still deferring to client.
 */
export function LabEditor() {
  const mounted = useIsClient();
  if (!mounted) {
    return (
      <div
        className="lab-editor"
        data-hydrating="true"
        aria-busy="true"
        aria-label="lab local-only Markdown note"
      />
    );
  }
  return <LabEditorSession />;
}

function LabEditorSession() {
  const shellRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLDivElement>(null);
  const caretStrokeRef = useRef<HTMLSpanElement>(null);
  const paletteElementRef = useRef<HTMLDivElement>(null);
  const mathEditorElementRef = useRef<HTMLDivElement>(null);
  const mathInputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const sessionNameInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const paletteRef = useRef<PaletteState | null>(null);
  const mathEditorRef = useRef<MathEditorState | null>(null);
  const paletteVersionRef = useRef(0);
  const selectedRef = useRef(0);
  const [palette, setPaletteState] = useState<PaletteState | null>(null);
  const [mathEditorState, setMathEditorState] = useState<MathEditorState | null>(null);
  const [selected, setSelectedState] = useState(0);
  const [health, setHealth] = useState<StorageHealth>(EMPTY_HEALTH);
  const [hydrating, setHydrating] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  // Only constructed after LabEditor mounts on the client, so the hash is real.
  // Invalid ids still map to the default document; the hash is rewritten in
  // useLayoutEffect below so React StrictMode double init stays correct.
  const [documentId] = useState(() => activeDocumentIdFromLocation());
  const [openedWithInvalidSessionHash] = useState(
    () => parseActiveDocumentLocation().hadInvalidSessionHash,
  );
  const [sessionName, setSessionName] = useState("Untitled");
  const [savedSessionName, setSavedSessionName] = useState("Untitled");
  const [sessions, setSessions] = useState<DocumentSession[]>([]);
  const [stats, setStats] = useState({ words: 0, characters: 0, minutes: 0, sessions: 1 });

  const [persistence] = useState<EditorPersistenceController>(() => {
    const e2eDelay = typeof window === "undefined"
      ? undefined
      : (window as Window & { __LAB_E2E_SAVE_DELAY__?: number }).__LAB_E2E_SAVE_DELAY__;
    return createEditorPersistenceController({
      delayMs: Number.isFinite(e2eDelay) ? e2eDelay : undefined,
      onHealth: (nextHealth) => {
        setHealth(nextHealth);
        // documentId is stable for the mount lifetime (session switches reload),
        // so capturing it here is intentional and avoids a ref.
        if (nextHealth.saved === true) void touchDocumentSession(documentId).catch(() => undefined);
      },
      onNotice: setNotice,
      onStageFailure: () => setNotice("This edit could not be staged locally. Please export a copy before closing the page."),
    });
  });

  const setPalette = useCallback((value: PaletteState | null) => {
    paletteVersionRef.current += 1;
    paletteRef.current = value;
    setPaletteState(value);
  }, []);

  const setSelected = useCallback((value: number) => {
    selectedRef.current = value;
    setSelectedState(value);
  }, []);

  const setMathEditor = useCallback((value: MathEditorState | null) => {
    mathEditorRef.current = value;
    setMathEditorState(value);
  }, []);

  const mathAnchor = useCallback((instance: Editor, pos: number, kind: MathKind) => {
    const shell = shellRef.current;
    const dom = instance.view.nodeDOM(pos);
    if (!shell || !(dom instanceof HTMLElement)) return null;

    const shellBox = shell.getBoundingClientRect();
    const nodeBox = dom.getBoundingClientRect();
    const viewport = window.visualViewport;
    const viewportLeft = viewport?.offsetLeft ?? 0;
    const viewportTop = viewport?.offsetTop ?? 0;
    const viewportWidth = viewport?.width ?? window.innerWidth;
    const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
    const width = Math.min(kind === "block" ? 480 : 420, Math.max(1, shellBox.width - 16));
    const height = kind === "block" ? 150 : 108;
    const leftViewport = clamp(
      nodeBox.left,
      viewportLeft + 8,
      viewportLeft + viewportWidth - width - 8,
    );
    const below = nodeBox.bottom + 10;
    const above = nodeBox.top - height - 10;
    const topViewport = below + height <= viewportBottom - 8 ? below : above;
    const top = clamp(topViewport, viewportTop + 8, viewportBottom - height - 8);
    return {
      left: leftViewport - shellBox.left,
      top: top - shellBox.top,
    };
  }, []);

  const repositionMathEditor = useCallback(() => {
    const current = mathEditorRef.current;
    const instance = editorRef.current;
    if (!current || !instance) return;
    const anchor = mathAnchor(instance, current.pos, current.kind);
    if (!anchor) return;
    if (Math.abs(current.left - anchor.left) < 0.5 && Math.abs(current.top - anchor.top) < 0.5) return;
    setMathEditor({ ...current, ...anchor });
  }, [mathAnchor, setMathEditor]);

  const updateMathLatex = useCallback((latex: string) => {
    const current = mathEditorRef.current;
    if (!current) return;
    // Keep the draft in React while the popover is open. The document is only
    // mutated on commit, so Escape is genuinely history- and persistence-neutral.
    setMathEditor({ ...current, latex });
  }, [setMathEditor]);

  const closeMathEditor = useCallback((
    restore: boolean,
    target: MathEditorState | null = null,
    focus = true,
  ) => {
    const current = target ?? mathEditorRef.current;
    const instance = editorRef.current;
    if (!current || !instance) {
      if (!target) setMathEditor(null);
      return 0;
    }

    const node = instance.state.doc.nodeAt(current.pos);
    let removedNodeSize = 0;
    if (restore) {
      if (current.isNew && !current.initialLatex && deleteMathNode(instance, current)) {
        removedNodeSize = node?.nodeSize ?? 0;
      }
    } else if (current.isNew && !current.latex.trim()) {
      if (deleteMathNode(instance, current)) removedNodeSize = node?.nodeSize ?? 0;
    } else if (current.latex !== current.initialLatex) {
      updateMathNode(instance, current, current.latex);
    }

    if (sameMathEditor(mathEditorRef.current, current)) {
      setMathEditor(null);
      if (focus) {
        if (!restore && current.kind === "inline" && removedNodeSize === 0) {
          const committedNode = instance.state.doc.nodeAt(current.pos);
          const after = current.pos + (committedNode?.nodeSize ?? 1);
          instance.chain().setTextSelection(after).focus().run();
        } else {
          instance.commands.focus();
        }
      }
    }
    return removedNodeSize;
  }, [setMathEditor]);

  const commitMathEditor = useCallback(() => closeMathEditor(false), [closeMathEditor]);
  const cancelMathEditor = useCallback(() => closeMathEditor(true), [closeMathEditor]);

  const openMathEditor = useCallback((kind: MathKind, node: PMNode, pos: number, isNew = false) => {
    const instance = editorRef.current;
    if (!instance) return;

    const previous = mathEditorRef.current;
    if (previous?.kind === kind && previous.pos === pos) return;

    let nextPos = pos;
    if (previous) {
      const removedNodeSize = closeMathEditor(false, previous, false);
      if (removedNodeSize > 0 && previous.pos < nextPos) nextPos -= removedNodeSize;
    }

    const nextNode = instance.state.doc.nodeAt(nextPos);
    if (!nextNode || nextNode.type.name !== mathNodeType(kind)) return;
    instance.commands.setNodeSelection(nextPos);
    const anchor = mathAnchor(instance, nextPos, kind) ?? { left: 8, top: 88 };
    const latex = String(nextNode.attrs.latex ?? node.attrs.latex ?? "");
    setMathEditor({
      kind,
      pos: nextPos,
      latex,
      initialLatex: latex,
      isNew,
      ...anchor,
    });
  }, [closeMathEditor, mathAnchor, setMathEditor]);

  // These callbacks are invoked by Tiptap's NodeViews after render. The
  // extension factory is intentionally kept outside React's render lifecycle.
  /* eslint-disable react-hooks/refs */
  const mathExtensions = useMemo(() => [
    BlockMathMarkdown.configure({
      onClick: (node, pos) => openMathEditor("block", node, pos),
      katexOptions: {
        displayMode: true,
        throwOnError: false,
        strict: "warn",
        trust: false,
        output: "htmlAndMathml",
      },
    }),
    InlineMathMarkdown.configure({
      onClick: (node, pos) => openMathEditor("inline", node, pos),
      katexOptions: {
        displayMode: false,
        throwOnError: false,
        strict: "warn",
        trust: false,
        output: "htmlAndMathml",
      },
    }),
  ], [openMathEditor]);
  /* eslint-enable react-hooks/refs */

  const stopCaretBlink = useCallback(() => {
    caretStrokeRef.current?.removeAttribute("data-blinking");
  }, []);

  const restartCaretBlink = useCallback(() => {
    const stroke = caretStrokeRef.current;
    if (!stroke) return;
    stroke.removeAttribute("data-blinking");
    void stroke.offsetWidth;
    stroke.setAttribute("data-blinking", "true");
  }, []);

  const hideCaret = useCallback(() => {
    caretRef.current?.removeAttribute("data-visible");
    stopCaretBlink();
  }, [stopCaretBlink]);

  const positionCaret = useCallback((instance: Editor) => {
    const shell = shellRef.current;
    const caret = caretRef.current;
    if (!shell || !caret || !instance.isFocused || !instance.state.selection.empty) {
      hideCaret();
      return;
    }

    try {
      const point = instance.view.coordsAtPos(instance.state.selection.from);
      const shellBox = shell.getBoundingClientRect();
      const nextTransform = `translate3d(${point.left - shellBox.left}px, ${point.top - shellBox.top}px, 0)`;
      const wasVisible = caret.hasAttribute("data-visible");
      const moved = caret.style.transform !== nextTransform;

      if (!wasVisible) caret.style.transition = "none";
      caret.style.height = `${Math.max(18, point.bottom - point.top)}px`;
      caret.style.transform = nextTransform;
      caret.setAttribute("data-visible", "true");

      if (!wasVisible) {
        void caret.offsetWidth;
        caret.style.removeProperty("transition");
      }
      if (moved || !wasVisible) restartCaretBlink();
    } catch {
      hideCaret();
    }
  }, [hideCaret, restartCaretBlink]);

  const findSlash = useCallback((instance: Editor): PaletteState | null => {
    const { $from } = instance.state.selection;
    if (!instance.state.selection.empty || !$from.parent.isTextblock || isCodeBlock($from.parent)) return null;
    const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
    const match = before.match(/(?:^|\s)\/([a-z0-9-]*)$/i);
    if (!match) return null;
    const token = `/${match[1]}`;
    const from = instance.state.selection.from - token.length;
    const point = instance.view.coordsAtPos(instance.state.selection.from);
    const shellBox = shellRef.current?.getBoundingClientRect();
    if (!shellBox) return null;
    const viewport = window.visualViewport;
    const viewportTop = viewport?.offsetTop ?? 0;
    const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
    const anchor = { left: point.left, top: point.top, bottom: point.bottom };
    const width = Math.min(384, Math.max(1, shellBox.width - 16));
    const estimatedHeight = Math.max(56, Math.min(316, viewportBottom - viewportTop - 16));
    const left = clamp(point.left - shellBox.left, 8, shellBox.width - width - 8);
    const below = point.bottom + 10;
    const above = point.top - estimatedHeight - 10;
    const topViewport = below + estimatedHeight <= viewportBottom - 8 ? below : above;
    const top = clamp(topViewport, viewportTop + 8, viewportBottom - estimatedHeight - 8) - shellBox.top;
    return { query: match[1], range: { from, to: instance.state.selection.from }, left, top, mode: "commands", anchor };
  }, []);

  const repositionPalette = useCallback(() => {
    const current = paletteRef.current;
    const paletteElement = paletteElementRef.current;
    const shell = shellRef.current;
    if (!current || !paletteElement || !shell) return;

    const shellBox = shell.getBoundingClientRect();
    const paletteBox = paletteElement.getBoundingClientRect();
    const viewport = window.visualViewport;
    const viewportLeft = viewport?.offsetLeft ?? 0;
    const viewportTop = viewport?.offsetTop ?? 0;
    const viewportWidth = viewport?.width ?? window.innerWidth;
    const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
    const gap = 8;
    const leftViewport = clamp(
      current.anchor.left,
      viewportLeft + gap,
      viewportLeft + viewportWidth - paletteBox.width - gap,
    );
    const below = current.anchor.bottom + 10;
    const above = current.anchor.top - paletteBox.height - 10;
    const topViewport = below + paletteBox.height <= viewportBottom - gap ? below : above;
    const clampedTop = clamp(
      topViewport,
      viewportTop + gap,
      viewportBottom - paletteBox.height - gap,
    );
    const left = leftViewport - shellBox.left;
    const top = clampedTop - shellBox.top;
    if (Math.abs(current.left - left) < 0.5 && Math.abs(current.top - top) < 0.5) return;
    setPalette({ ...current, left, top });
  }, [setPalette]);

  const syncInterface = useCallback(
    (instance: Editor) => {
      requestAnimationFrame(() => positionCaret(instance));
      if (paletteRef.current && paletteRef.current.mode !== "commands") return;
      const next = findSlash(instance);
      setPalette(next);
      setSelected(0);
    },
    [findSlash, positionCaret, setPalette, setSelected],
  );

  const editor = useEditor({
    immediatelyRender: false,
    // Tiptap's default style tag has no nonce. The equivalent base rules live
    // in the static global stylesheet so nonce-only CSP remains effective.
    injectCSS: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: {
          openOnClick: true,
          linkOnPaste: true,
          // The built-in autolinker runs before MarkdownLinkInput and consumes URLs
          // inside `[label](https://...)`. Plain URLs are handled by PlainUrlInput below.
          autolink: false,
          defaultProtocol: "https",
          HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" },
        },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit.configure({ table: { resizable: false } }),
      Placeholder.configure({ placeholder: "" }),
      ...mathExtensions,
      Markdown.configure({ markedOptions: { gfm: true } }),
      MarkdownLinkInput,
      PlainUrlInput,
      SlashCommandInput,
    ],
    content: "",
    contentType: "markdown",
    autofocus: false,
    editable: false,
    editorProps: {
      handlePaste: (view, event) => {
        const text = event.clipboardData?.getData("text/plain") ?? "";
        const html = event.clipboardData?.getData("text/html") ?? "";
        const { $from } = view.state.selection;
        const insideCodeBlock = isCodeBlock($from.parent);

        if (insideCodeBlock) {
          view.dispatch(view.state.tr.insertText(text).scrollIntoView());
          return true;
        }

        // 2. Slash-fragment completion first because it interacts with
        // slash-command input and undo history.
        if ($from.parent.isTextblock && /^\/[a-z0-9-]*$/i.test(text)) {
          const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
          if (/(?:^|\s)\/[a-z0-9-]*$/i.test(before + text)) {
            view.dispatch(view.state.tr.insertText(text).setMeta("addToHistory", false).scrollIntoView());
            return true;
          }
        }

        // 3. Exact math-node insertion for the app's established delimiters:
        // `$$x^2$$` inline and `$$` on their own lines as block math.
        if ($from.parent.isTextblock) {
          const inlineMatch = text.match(INLINE_MATH_PATTERN);
          if (inlineMatch) {
            view.dispatch(
              view.state.tr
                .replaceSelectionWith(view.state.schema.nodes.inlineMath.create({ latex: inlineMatch[1] }))
                .scrollIntoView(),
            );
            return true;
          }
          const blockMatch = text.match(BLOCK_MATH_PATTERN);
          if (blockMatch) {
            view.dispatch(
              view.state.tr
                .replaceSelectionWith(view.state.schema.nodes.blockMath.create({ latex: blockMatch[1] }))
                .scrollIntoView(),
            );
            return true;
          }
        }

        // 4. Partial Markdown-link completion, e.g. typing `[label](` and then
        // pasting a URL.
        const before = $from.parent.isTextblock
          ? $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc")
          : "";
        const linkMatch = (before + text).match(MARKDOWN_LINK_PATTERN);
        const linkMark = view.state.schema.marks.link;
        if (
          linkMatch?.index !== undefined
          && linkMatch.index < before.length
          && linkMatch[0].length > text.length
          && view.state.selection.empty
          && linkMark
        ) {
          const tokenFrom = Math.max(
            $from.start(),
            view.state.selection.from - (linkMatch[0].length - text.length),
          );
          view.dispatch(
            view.state.tr
              .replaceWith(
                tokenFrom,
                view.state.selection.to,
                view.state.schema.text(linkMatch[1], [linkMark.create({ href: linkMatch[2] })]),
              )
              .scrollIntoView(),
          );
          return true;
        }

        // 5. Classify and execute the clipboard intent.
        const intent = classifyClipboardPaste({ plainText: text, html });
        switch (intent.kind) {
          case "native":
            // Meaningful rich HTML: let Tiptap's schema-based parsing handle it.
            return false;
          case "plain-text":
            // Plain prose: ProseMirror's native text handling splits paragraphs
            // and normalizes line endings exactly as the editor expects. However,
            // the markdown input rules also run on native pastes (ProseMirror
            // routes plain-text pastes through `handleTextInput`), so ambiguous
            // fragments like `_identifier_` or `5 * 3` would be auto-converted
            // into emphasis marks. Insert such text literally instead.
            if (!/[`*_~]/.test(text)) return false;
            const lines = text.split(/\r\n?|\n/);
            if (lines.length === 1) {
              view.dispatch(view.state.tr.insertText(text).scrollIntoView());
            } else {
              const { paragraph } = view.state.schema.nodes;
              const marks = view.state.storedMarks ?? $from.marks();
              const blocks = lines
                .filter((line) => line.length > 0)
                .map((line) => paragraph.create(null, view.state.schema.text(line, marks)));
              view.dispatch(view.state.tr.replaceSelection(new Slice(Fragment.from(blocks), 0, 0)).scrollIntoView());
            }
            return true;
          case "markdown": {
            const editor = editorRef.current;
            if (!editor) return false;
            editor.commands.insertContentAt(
              {
                from: view.state.selection.from,
                to: view.state.selection.to,
              },
              intent.markdown,
              {
                contentType: "markdown",
                updateSelection: true,
              },
            );
            return true;
          }
          case "inline-math":
            view.dispatch(
              view.state.tr
                .replaceSelectionWith(view.state.schema.nodes.inlineMath.create({ latex: intent.latex }))
                .scrollIntoView(),
            );
            return true;
          case "block-math":
            view.dispatch(
              view.state.tr
                .replaceSelectionWith(view.state.schema.nodes.blockMath.create({ latex: intent.latex }))
                .scrollIntoView(),
            );
            return true;
        }
        return false;
      },
      handleKeyDown: (view, event) => {
        if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "e") {
          if (isCodeBlock(view.state.selection.$from.parent)) return false;
          event.preventDefault();
          const { from, to } = view.state.selection;
          const selectedText = from !== to && view.state.selection.$from.parent === view.state.selection.$to.parent
            ? view.state.doc.textBetween(from, to, "\n", " ")
            : "";
          const node = view.state.schema.nodes.inlineMath.create({ latex: selectedText });
          const tr = view.state.tr.replaceSelectionWith(node).scrollIntoView();
          view.dispatch(tr);
          const pos = Math.min(from, view.state.doc.content.size);
          const inserted = view.state.doc.nodeAt(pos);
          if (inserted?.type.name === "inlineMath") {
            openMathEditor("inline", inserted, pos, !selectedText);
          }
          return true;
        }

        if (view.state.selection instanceof NodeSelection) {
          const selectedNode = view.state.selection.node;
          const kind = selectedNode.type.name === "inlineMath"
            ? "inline"
            : selectedNode.type.name === "blockMath"
              ? "block"
              : null;
          if (kind && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            openMathEditor(kind, selectedNode, view.state.selection.from);
            return true;
          }
        }

        if (event.key === ")") {
          const { $from } = view.state.selection;
          if ($from.parent.isTextblock && !isCodeBlock($from.parent)) {
            const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
            const linkMatch = (before + event.key).match(MARKDOWN_LINK_PATTERN);
            const linkMark = view.state.schema.marks.link;
            if (
              linkMatch?.index !== undefined
              && linkMatch.index < before.length
              && linkMatch[0].length > event.key.length
              && linkMark
            ) {
              const tokenFrom = Math.max(
                $from.start(),
                view.state.selection.from - (linkMatch[0].length - event.key.length),
              );
              view.dispatch(
                view.state.tr.replaceWith(
                  tokenFrom,
                  view.state.selection.from,
                  view.state.schema.text(linkMatch[1], [linkMark.create({ href: linkMatch[2] })]),
                ).scrollIntoView(),
              );
              return true;
            }
          }
        }
        const { from, empty, $from } = view.state.selection;
        if (paletteRef.current?.mode !== "commands" || !empty) return false;
        if (event.key === "Delete" && $from.parentOffset < $from.parent.content.size) {
          // Keep forward deletion in its own history event instead of merging
          // it with the slash token's input-rule transactions.
          view.dispatch(closeHistory(view.state.tr.delete(from, from + 1)));
          return true;
        }
        if (event.key === "Backspace" && (event.metaKey || event.altKey || event.ctrlKey)) {
          // Native modified deletion differs between browsers and operating
          // systems. Keep slash-command editing deterministic while the
          // palette is open: Meta deletes to the start of the text block;
          // Alt (macOS) and Ctrl (Windows/Linux) delete the preceding word.
          event.preventDefault();
          const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
          const start = event.metaKey
            ? $from.start()
            : from - (before.length - backwardWordStart(before));
          if (start >= from) return true;
          view.dispatch(closeHistory(view.state.tr.delete(start, from)));
          return true;
        }
        if (event.key === "Backspace" && $from.parentOffset > 0) {
          view.dispatch(view.state.tr.delete(from - 1, from).setMeta("addToHistory", false));
          return true;
        }
        return false;
      },
      attributes: {
        class: "lab-document",
        "aria-label": "lab local-only Markdown note",
        role: "textbox",
        "aria-multiline": "true",
        "aria-autocomplete": "list",
        "aria-haspopup": "listbox",
        autocapitalize: "sentences",
        autocomplete: "off",
        spellcheck: "true",
      },
    },
    onCreate: ({ editor: instance }) => {
      editorRef.current = instance;
    },
    onUpdate: ({ editor: instance }) => {
      if (migrateInlineMath(instance)) return;
      syncInterface(instance);
      persistence.onEdit(instance.getMarkdown());
    },
    onSelectionUpdate: ({ editor: instance }) => syncInterface(instance),
    onFocus: ({ editor: instance }) => syncInterface(instance),
    onBlur: hideCaret,
  });

  const filtered = useMemo(() => {
    if (!palette || palette.mode !== "commands") return [];
    const query = palette.query.toLowerCase();
    return COMMANDS
      .filter((command) => `${command.id} ${command.label} ${command.terms}`.toLowerCase().includes(query))
      .sort((left, right) => {
        const score = (command: Command) => command.id === query
          ? 0
          : command.label.toLowerCase().startsWith(query)
            ? 1
            : 2;
        return score(left) - score(right);
      });
  }, [palette]);

  const mathError = useMemo(() => {
    if (!mathEditorState) return null;
    if (!mathEditorState.latex.trim()) return "Enter a LaTeX expression.";
    try {
      katex.renderToString(mathEditorState.latex, {
        displayMode: mathEditorState.kind === "block",
        throwOnError: true,
        strict: "warn",
        trust: false,
        output: "htmlAndMathml",
      });
      return null;
    } catch {
      return "This expression could not be parsed yet.";
    }
  }, [mathEditorState]);

  const mathPreview = useMemo(() => {
    if (!mathEditorState?.latex.trim() || mathError) return null;
    try {
      return katex.renderToString(mathEditorState.latex, {
        displayMode: mathEditorState.kind === "block",
        throwOnError: false,
        strict: "warn",
        trust: false,
        output: "htmlAndMathml",
      });
    } catch {
      return null;
    }
  }, [mathEditorState, mathError]);

  const mathEditorIdentity = mathEditorState
    ? `${mathEditorState.kind}:${mathEditorState.pos}`
    : null;

  useEffect(() => {
    if (!mathEditorIdentity) return;
    const frame = window.requestAnimationFrame(() => {
      const input = mathInputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [mathEditorIdentity]);

  useEffect(() => {
    if (palette?.mode !== "name") return;
    const frame = window.requestAnimationFrame(() => {
      sessionNameInputRef.current?.focus();
      sessionNameInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [palette?.mode]);

  useLayoutEffect(() => {
    repositionMathEditor();
  }, [mathEditorState, repositionMathEditor]);

  useEffect(() => {
    if (!editor) return;
    const documentElement = editor.view.dom;
    if (palette?.mode === "commands") {
      const activeCommand = filtered[selected];
      documentElement.setAttribute("aria-expanded", "true");
      documentElement.setAttribute("aria-controls", PALETTE_ID);
      if (activeCommand) {
        documentElement.setAttribute("aria-activedescendant", `${PALETTE_ID}-${activeCommand.id}`);
      } else {
        // The no-results panel is still the controlled listbox, but it has no
        // option for aria-activedescendant to reference.
        documentElement.removeAttribute("aria-activedescendant");
      }
      return;
    }
    if (palette?.mode === "sessions") {
      const activeSession = sessions[selected];
      documentElement.setAttribute("aria-expanded", "true");
      documentElement.setAttribute("aria-controls", PALETTE_ID);
      if (activeSession) {
        documentElement.setAttribute(
          "aria-activedescendant",
          `${PALETTE_ID}-session-${activeSession.id}`,
        );
      } else {
        documentElement.removeAttribute("aria-activedescendant");
      }
      return;
    }
    documentElement.setAttribute("aria-expanded", "false");
    documentElement.removeAttribute("aria-controls");
    documentElement.removeAttribute("aria-activedescendant");
  }, [editor, filtered, palette, selected, sessions]);

  /** Result of the pre-navigation flush: ok, user accepted dirty switch, or cancel. */
  const flushBeforeSessionSwitch = useCallback(async (): Promise<"ok" | "dirty" | "cancel"> => {
    try {
      if (await persistence.flush()) return "ok";
    } catch {
      // The controller normally converts save errors into a false result, but
      // session switching must remain safe if a custom persistence boundary
      // rejects unexpectedly.
    }
    // Authority conflicts and replica failures both yield false. Staged recovery
    // drafts remain available via /recover, so offer an explicit escape hatch.
    const switchAnyway = window.confirm(
      "This note could not be fully saved (another tab may have a newer copy, or storage failed). Switch sessions anyway? Local recovery drafts remain available via /recover.",
    );
    if (switchAnyway) return "dirty";
    setNotice("This note could not be saved before switching sessions.");
    return "cancel";
  }, [persistence]);

  /**
   * Stop accepting edits so the async gap before navigation cannot stage/save more text.
   * Disables the editor first, then flushes via dispose. Returns false if the user
   * declines to switch after a failed final flush (reloads to restore a live controller).
   * When `allowDirtySwitch` is true the user already confirmed a failed flush, so
   * dispose does not prompt a second time.
   */
  const freezePersistenceForNavigation = useCallback(async (allowDirtySwitch = false) => {
    editor?.setEditable(false, false);
    let flushed = true;
    try {
      flushed = await persistence.dispose();
    } catch {
      flushed = false;
    }
    if (flushed || allowDirtySwitch) return true;
    const switchAnyway = window.confirm(
      "This note could not be fully saved (another tab may have a newer copy, or storage failed). Switch sessions anyway? Local recovery drafts remain available via /recover.",
    );
    if (switchAnyway) return true;
    setNotice("This note could not be saved before switching sessions.");
    // dispose() is irreversible; reload restores a live persistence controller.
    window.location.reload();
    return false;
  }, [editor, persistence]);

  const navigateToSession = useCallback((session: DocumentSession) => {
    const hash = documentSessionHash(session.id);
    const target = `${window.location.pathname}${window.location.search}${hash}`;
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    // Same-path hash changes do not load a new document by themselves. Push a
    // real history entry, then reload so documentId and vault scope rebind.
    // Back/forward are handled by the popstate listener below (also reload).
    // Full reload is intentional: vault scope and persistence are bound at mount
    // and must rebind cleanly to the new document namespace.
    if (current === target) {
      window.location.reload();
      return;
    }
    window.history.pushState({ labDocumentId: session.id }, "", target);
    window.location.reload();
  }, []);

  const resumeSession = useCallback(async (session: DocumentSession) => {
    const flushResult = await flushBeforeSessionSwitch();
    if (flushResult === "cancel") return false;
    if (!(await freezePersistenceForNavigation(flushResult === "dirty"))) return false;
    navigateToSession(session);
    return true;
  }, [flushBeforeSessionSwitch, freezePersistenceForNavigation, navigateToSession]);

  const deleteActiveSession = useCallback(async () => {
    if (documentId === DEFAULT_DOCUMENT_ID) {
      setNotice("The original session cannot be deleted. Use /clear to empty it.");
      return false;
    }
    // Stop accepting edits so keystrokes during the async purge cannot land in
    // the DOM and be lost when the reload lands. Drop debounced writes first
    // (abandon) so a late save cannot revive the session.
    editor?.setEditable(false, false);
    await persistence.abandon();
    try {
      await purgeDocumentSession(documentId);
    } catch {
      // abandon() is irreversible; reload restores a live persistence controller.
      // Tombstones are only published after a durable delete marker succeeds, so
      // a failed purge keeps the note loadable after reload.
      setNotice("This session could not be deleted locally. Reloading…");
      window.location.reload();
      return false;
    }
    // Replace so Back does not return to the deleted session URL, then reload.
    const target = `${window.location.pathname}${window.location.search}`;
    window.history.replaceState({ labDocumentId: DEFAULT_DOCUMENT_ID }, "", target);
    window.location.reload();
    return true;
  }, [documentId, editor, persistence]);

  const submitSessionName = useCallback(() => {
    const nextName = sessionName.trim();
    if (!nextName) {
      setNotice("Enter a name for this session.");
      return;
    }
    void renameDocumentSession(documentId, nextName)
      .then((session) => {
        setSessionName(session.name);
        setSavedSessionName(session.name);
        setNotice(`Named this session “${session.name}”.`);
        setPalette(null);
        editor?.commands.focus();
      })
      .catch(() => setNotice("This session name could not be saved locally."));
  }, [documentId, editor, sessionName, setPalette]);

  const runCommand = useCallback(
    (command: Command) => {
      if (!editor || !paletteRef.current) return;
      const current = paletteRef.current;
      const anchor = { ...current };
      // Slash text is UI chrome, not an edit the user should have to undo. In particular,
      // making this transaction part of history clears the redo branch before /redo runs.
      editor.view.dispatch(
        editor.state.tr.delete(current.range.from, current.range.to).setMeta("addToHistory", false),
      );
      editor.commands.focus();
      setPalette(null);

      if (command.id === "stats") {
        const note = editor.getText().trim();
        const words = note ? (note.match(/\S+/gu)?.length ?? 0) : 0;
        const available = listDocumentSessions();
        setSessions(available);
        setStats({
          words,
          characters: note.length,
          minutes: words === 0 ? 0 : Math.max(1, Math.ceil(words / 220)),
          sessions: available.length,
        });
        setPalette({ ...anchor, query: "", range: { from: editor.state.selection.from, to: editor.state.selection.from }, mode: "stats" });
        void inspectLocalStorage().then(setHealth).catch(() => setNotice("Could not refresh storage status."));
        return;
      }
      if (command.id === "status") {
        const requestVersion = paletteVersionRef.current;
        void inspectLocalStorage()
          .then((result) => {
            // The user may have typed, escaped, or opened another palette while
            // storage was being inspected. A late result must not resurrect it.
            if (paletteVersionRef.current !== requestVersion || paletteRef.current !== null) return;
            setHealth(result);
            setNotice(result.errors.length > 0 ? "Some local storage locations are unavailable." : null);
            setPalette({ ...anchor, query: "", range: { from: editor.state.selection.from, to: editor.state.selection.from }, mode: "status" });
          })
          .catch(() => {
            if (paletteVersionRef.current === requestVersion && paletteRef.current === null) {
              setNotice("Could not inspect local storage.");
            }
          });
        return;
      }
      if (command.id === "clear") {
        setPalette({ ...anchor, query: "", range: { from: editor.state.selection.from, to: editor.state.selection.from }, mode: "confirm-clear" });
        return;
      }
      if (command.id === "delete") {
        if (documentId === DEFAULT_DOCUMENT_ID) {
          setNotice("The original session cannot be deleted. Use /clear to empty it.");
          return;
        }
        setPalette({ ...anchor, query: "", range: { from: editor.state.selection.from, to: editor.state.selection.from }, mode: "confirm-delete" });
        return;
      }
      if (command.id === "recover") {
        const revisionAtRequest = persistence.getState().editRevision;
        void listLocalRecoveryDrafts()
          .then((drafts) => {
            if (revisionAtRequest !== persistence.getState().editRevision) {
              setNotice("The note changed while recovery drafts were loading. Export was cancelled.");
              return;
            }
            if (drafts.length === 0) {
              setNotice("No conflicting local drafts are available.");
              return;
            }
            downloadMarkdown(drafts.length === 1 ? "lab-recovery.md" : "lab-recovery-bundle.md", recoveryBundle(drafts));
            setNotice(`Exported ${drafts.length} recovery ${drafts.length === 1 ? "draft" : "drafts"}.`);
          })
          .catch(() => setNotice("Could not export the local recovery drafts."));
        return;
      }
      if (command.id === "new") {
        void (async () => {
          const flushResult = await flushBeforeSessionSwitch();
          if (flushResult === "cancel") return;
          // Freeze before the async create gap so keystrokes cannot land on the
          // outgoing session after the last successful flush.
          if (!(await freezePersistenceForNavigation(flushResult === "dirty"))) return;
          try {
            const session = await createDocumentSession();
            navigateToSession(session);
          } catch {
            setNotice("A new session could not be created locally. Reloading…");
            window.location.reload();
          }
        })();
        return;
      }
      if (command.id === "name") {
        setSessionName(savedSessionName);
        setPalette({ ...anchor, query: "", range: { from: editor.state.selection.from, to: editor.state.selection.from }, mode: "name" });
        return;
      }
      if (command.id === "sessions") {
        const available = listDocumentSessions();
        setSessions(available);
        const activeIndex = available.findIndex((session) => session.id === documentId);
        setSelected(Math.max(0, activeIndex));
        setPalette({ ...anchor, query: "", range: { from: editor.state.selection.from, to: editor.state.selection.from }, mode: "sessions" });
        return;
      }
      if (command.id === "undo") {
        editor.commands.undo();
        return;
      }
      if (command.id === "redo") {
        editor.commands.redo();
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
        case "import": fileInputRef.current?.click(); break;
        case "export": {
          downloadMarkdown("lab.md", editor.getMarkdown());
          break;
        }
      }
    },
    [documentId, editor, flushBeforeSessionSwitch, freezePersistenceForNavigation, navigateToSession, openMathEditor, persistence, savedSessionName, setPalette, setSelected],
  );

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
  }, [documentId, editor, persistence]);

  useEffect(() => {
    if (!editor) return;
    let active = true;
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
        try {
          // Do not ensure/create metadata for arbitrary hashes — only load existing
          // names. First durable save (touchDocumentSession) creates the entry.
          const activeSession = await getDocumentSession(documentId);
          if (active && activeSession) {
            setSessionName(activeSession.name);
            setSavedSessionName(activeSession.name);
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
        editor.commands.setContent(markdown, { contentType: "markdown", emitUpdate: false });
        persistence.markLoaded(markdown);
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
      } finally {
        if (!active || !finishHydration) return;
        if (!persistence.getState().loaded) persistence.markLoaded(editor.getMarkdown());
        editor.setEditable(true, false);
        setHydrating(false);
        editor.commands.focus("end");
        syncInterface(editor);
      }
    })();
    return () => {
      active = false;
    };
  }, [documentId, editor, openedWithInvalidSessionHash, persistence, syncInterface]);

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
  }, [palette, filtered.length, repositionPalette]);

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
    const current = paletteRef.current;
    if (!current) return;

    if (event.key === "Escape") {
      event.preventDefault();
      if (current.mode === "name") setSessionName(savedSessionName);
      setPalette(null);
      editor?.commands.focus();
      return;
    }

    if (current.mode === "name") return;

    if (current.mode === "sessions") {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        const count = Math.max(1, sessions.length);
        setSelected((selectedRef.current + direction + count) % count);
      } else if ((event.key === "Enter" || event.key === "Tab") && sessions.length > 0) {
        event.preventDefault();
        const session = sessions[selectedRef.current] ?? sessions[0];
        if (session.id === documentId) {
          setPalette(null);
          editor?.commands.focus();
        } else {
          void resumeSession(session);
        }
      }
      return;
    }

    if (current.mode === "confirm-clear") {
      if (event.key === "Enter") {
        event.preventDefault();
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

    if (current.mode === "status" || current.mode === "stats") {
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

    if ((event.key === "Enter" || event.key === "Tab") && filtered.length > 0) {
      event.preventDefault();
      runCommand(filtered[selectedRef.current] ?? filtered[0]);
    }
  };

  const onImport = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !editor) return;
    const revisionAtSelection = persistence.getState().editRevision;
    void file.text()
      .then((markdown) => {
        if (revisionAtSelection !== persistence.getState().editRevision) {
          setNotice("The note changed while the file was loading. Import was cancelled.");
          return;
        }
        editor.commands.setContent(markdown, { contentType: "markdown" });
        editor.commands.focus("start");
        setNotice(null);
      })
      .catch(() => setNotice("The selected file could not be read as Markdown."));
    event.target.value = "";
  };

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

      {palette ? (
        <>
          <div
            ref={paletteElementRef}
            id={PALETTE_ID}
            className="command-palette"
            role={palette.mode === "commands" || palette.mode === "sessions" ? "listbox" : palette.mode === "name" ? "dialog" : "status"}
            aria-label={palette.mode === "sessions" ? "Document sessions" : "Slash commands"}
            style={{ left: Math.round(palette.left), top: Math.round(palette.top) }}
          >
          {palette.mode === "commands" ? (
            filtered.length > 0 ? (
              <div className="command-list">
                {filtered.map((command, index) => (
                  <div
                    className="command-item"
                    data-selected={index === selected}
                    id={`${PALETTE_ID}-${command.id}`}
                    key={command.id}
                    role="option"
                    aria-selected={index === selected}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      runCommand(command);
                    }}
                    onMouseEnter={() => setSelected(index)}
                  >
                    <span>{command.label}</span>
                    <small>{command.detail}</small>
                  </div>
                ))}
              </div>
            ) : (
              <div className="palette-message">No command</div>
            )
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
          ) : palette.mode === "sessions" ? (
            <div className="command-list session-list" data-testid="session-list">
              {sessions.map((session, index) => (
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
                    if (session.id === documentId) {
                      setPalette(null);
                      editor?.commands.focus();
                    } else {
                      void resumeSession(session);
                    }
                  }}
                  onMouseEnter={() => setSelected(index)}
                >
                  <span>{session.name}</span>
                  <small>{session.id === documentId ? "Current session" : session.updatedAt > 0 ? new Date(session.updatedAt).toLocaleString() : "Original session"}</small>
                </div>
              ))}
            </div>
          ) : palette.mode === "stats" ? (
            <div className="palette-message storage-message" data-testid="note-stats">
              <span>{stats.words} {stats.words === 1 ? "word" : "words"} · {stats.characters} characters</span>
              <small>Estimated reading: {stats.minutes === 0 ? "under a minute" : `~${stats.minutes} min`}</small>
              <small>{stats.sessions} local {stats.sessions === 1 ? "session" : "sessions"} · {health.copies} durable {health.copies === 1 ? "copy" : "copies"}</small>
              <small>{health.persistent ? "Persistent storage granted" : "Browser-managed persistence"}</small>
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
              <small>{health.persistent ? "Persistent storage granted" : "Browser-managed persistence"} · no network access</small>
            </div>
          )}
          </div>
        </>
      ) : null}
      {notice ? <p className="editor-notice" role="status">{notice}</p> : null}
    </div>
  );
}
