"use client";

import { Extension, InputRule, type Editor } from "@tiptap/core";
import Placeholder from "@tiptap/extension-placeholder";
import { TableKit } from "@tiptap/extension-table";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  createEditorPersistenceController,
  type EditorPersistenceController,
} from "@/lib/editor-persistence";
import {
  inspectLocalStorage,
  requestPersistentStorage,
  type StorageHealth,
} from "@/lib/local-vault";

type SlashRange = { from: number; to: number };
type PaletteMode = "commands" | "status" | "confirm-clear";
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
  { id: "link", label: "Link", detail: "Type a URL, then close with )", terms: "url href markdown" },
  { id: "undo", label: "Undo", detail: "Undo the last change", terms: "back history" },
  { id: "redo", label: "Redo", detail: "Redo the last change", terms: "forward history" },
  { id: "import", label: "Import Markdown", detail: "Open a local .md file", terms: "open file load" },
  { id: "export", label: "Export Markdown", detail: "Save a local .md copy", terms: "download file save" },
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

const EMPTY_HEALTH: StorageHealth = { copies: 0, labels: [], persistent: false, errors: [] };
const PALETTE_ID = "slash-command-palette";
const MARKDOWN_LINK_PATTERN = /\[([^\]]+)]\((https?:\/\/[^\s)]+)\)$/;

function isCodeBlock(parent: { type: { name: string } }) {
  return parent.type.name === "codeBlock";
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
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

export function LabEditor() {
  const shellRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLDivElement>(null);
  const caretStrokeRef = useRef<HTMLSpanElement>(null);
  const paletteElementRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const paletteRef = useRef<PaletteState | null>(null);
  const paletteVersionRef = useRef(0);
  const selectedRef = useRef(0);
  const [palette, setPaletteState] = useState<PaletteState | null>(null);
  const [selected, setSelectedState] = useState(0);
  const [health, setHealth] = useState<StorageHealth>(EMPTY_HEALTH);
  const [hydrating, setHydrating] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  const [persistence] = useState<EditorPersistenceController>(() => {
    const e2eDelay = typeof window === "undefined"
      ? undefined
      : (window as Window & { __LAB_E2E_SAVE_DELAY__?: number }).__LAB_E2E_SAVE_DELAY__;
    return createEditorPersistenceController({
      delayMs: Number.isFinite(e2eDelay) ? e2eDelay : undefined,
      onHealth: setHealth,
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
        if (!text) return false;

        const { $from } = view.state.selection;
        if ($from.parent.isTextblock && !isCodeBlock($from.parent) && /^\/[a-z0-9-]*$/i.test(text)) {
          const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
          if (/(?:^|\s)\/[a-z0-9-]*$/i.test(before + text)) {
            view.dispatch(view.state.tr.insertText(text).setMeta("addToHistory", false).scrollIntoView());
            return true;
          }
        }

        const before = $from.parent.isTextblock && !isCodeBlock($from.parent)
          ? $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc")
          : "";
        const linkMatch = (before + text).match(MARKDOWN_LINK_PATTERN);
        const linkMark = view.state.schema.marks.link;
        if (linkMatch && linkMark) {
          const tokenFrom = view.state.selection.from - (linkMatch[0].length - text.length);
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
        return false;
      },
      handleKeyDown: (view, event) => {
        if (event.key === ")") {
          const { $from } = view.state.selection;
          if ($from.parent.isTextblock && !isCodeBlock($from.parent)) {
            const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
            const linkMatch = (before + event.key).match(MARKDOWN_LINK_PATTERN);
            const linkMark = view.state.schema.marks.link;
            if (linkMatch?.index !== undefined && linkMark) {
              const tokenFrom = view.state.selection.from - (linkMatch[0].length - event.key.length);
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
        if (
          paletteRef.current?.mode !== "commands"
          || (event.key !== "Backspace" && event.key !== "Delete")
        ) return false;

        const { from, to } = view.state.selection;
        let deleteFrom = from;
        let deleteTo = to;
        if (from === to) {
          const { $from } = view.state.selection;
          if (event.key === "Backspace" && $from.parentOffset > 0) {
            deleteFrom = from - 1;
          } else if (event.key === "Delete" && $from.parentOffset < $from.parent.content.size) {
            deleteTo = from + 1;
          }
        }
        if (deleteFrom === deleteTo) return false;
        view.dispatch(view.state.tr.delete(deleteFrom, deleteTo).setMeta("addToHistory", false));
        return true;
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
    onUpdate: ({ editor: instance }) => {
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
    return COMMANDS.filter((command) => `${command.label} ${command.terms}`.toLowerCase().includes(query));
  }, [palette]);

  useEffect(() => {
    if (!editor) return;
    const documentElement = editor.view.dom;
    const activeCommand = palette?.mode === "commands" ? filtered[selected] : undefined;
    if (palette?.mode === "commands") {
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
    documentElement.setAttribute("aria-expanded", "false");
    documentElement.removeAttribute("aria-controls");
    documentElement.removeAttribute("aria-activedescendant");
  }, [editor, filtered, palette, selected]);

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
        case "link": chain.insertContent("[label](https://").run(); break;
        case "import": fileInputRef.current?.click(); break;
        case "export": {
          const blob = new Blob([editor.getMarkdown()], { type: "text/markdown;charset=utf-8" });
          const anchor = document.createElement("a");
          anchor.href = URL.createObjectURL(blob);
          anchor.download = "lab.md";
          anchor.click();
          URL.revokeObjectURL(anchor.href);
          break;
        }
      }
    },
    [editor, setPalette],
  );

  useEffect(() => {
    if (!editor) return;
    let active = true;
    void (async () => {
      try {
        await requestPersistentStorage();
        const markdown = await persistence.hydrate();
        if (!active) return;
        editor.commands.setContent(markdown, { contentType: "markdown", emitUpdate: false });
        persistence.markLoaded(markdown);
        const nextHealth = await inspectLocalStorage();
        if (!active) return;
        setHealth(nextHealth);
        setNotice(nextHealth.errors.length > 0 ? "Some local storage locations are unavailable." : null);
      } catch {
        if (active) setNotice("Could not load the saved note. A new local note is ready instead.");
      } finally {
        if (!active) return;
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
  }, [editor, persistence, syncInterface]);

  useEffect(() => {
    if (!editor) return;
    const onResize = () => {
      positionCaret(editor);
      repositionPalette();
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
  }, [editor, positionCaret, repositionPalette]);

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
      setPalette(null);
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

    if (current.mode === "status") {
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

  return (
    <div className="lab-shell" ref={shellRef} onKeyDownCapture={onKeyDownCapture}>
      <EditorContent editor={editor} aria-busy={hydrating} />
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
            role={palette.mode === "commands" ? "listbox" : "status"}
            aria-label="Slash commands"
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
          ) : palette.mode === "confirm-clear" ? (
            <div className="palette-message palette-confirm">
              <span>Clear the note?</span>
              <small>Press Enter to confirm · Esc to keep it</small>
            </div>
          ) : (
            <div className="palette-message storage-message" data-testid="storage-status">
              <span>{health.copies} local {health.copies === 1 ? "copy" : "copies"}</span>
              <small>{health.labels.join(" · ") || "Storage is unavailable"}</small>
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
