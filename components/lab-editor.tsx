"use client";

import { Extension, InputRule, type Editor } from "@tiptap/core";
import Placeholder from "@tiptap/extension-placeholder";
import { TableKit } from "@tiptap/extension-table";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  inspectLocalStorage,
  loadLocalDocument,
  requestPersistentStorage,
  saveLocalDocument,
  type StorageHealth,
} from "@/lib/local-vault";

type SlashRange = { from: number; to: number };
type PaletteMode = "commands" | "status" | "confirm-clear";
type PaletteState = {
  query: string;
  range: SlashRange;
  left: number;
  top: number;
  mode: PaletteMode;
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
  { id: "status", label: "Storage status", detail: "Inspect local redundancy", terms: "private security copies offline" },
  { id: "clear", label: "Clear note", detail: "Requires a second Enter", terms: "delete erase reset" },
];

const MarkdownLinkInput = Extension.create({
  name: "markdownLinkInput",
  addInputRules() {
    return [
      new InputRule({
        find: /\[([^\]]+)]\((https?:\/\/[^\s)]+)\)$/,
        handler: ({ state, range, match }) => {
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

const EMPTY_HEALTH: StorageHealth = { copies: 0, labels: [], persistent: false };

export function LabEditor() {
  const shellRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLDivElement>(null);
  const caretStrokeRef = useRef<HTMLSpanElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const loadedRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestMarkdownRef = useRef("");
  const paletteRef = useRef<PaletteState | null>(null);
  const selectedRef = useRef(0);
  const [palette, setPaletteState] = useState<PaletteState | null>(null);
  const [selected, setSelectedState] = useState(0);
  const [health, setHealth] = useState<StorageHealth>(EMPTY_HEALTH);

  const setPalette = useCallback((value: PaletteState | null) => {
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
    if (!instance.state.selection.empty || !$from.parent.isTextblock) return null;
    const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
    const match = before.match(/(?:^|\s)\/([a-z0-9-]*)$/i);
    if (!match) return null;
    const token = `/${match[1]}`;
    const from = instance.state.selection.from - token.length;
    const point = instance.view.coordsAtPos(instance.state.selection.from);
    const shellBox = shellRef.current?.getBoundingClientRect();
    if (!shellBox) return null;
    const width = Math.min(384, shellBox.width - 24);
    const left = Math.max(0, Math.min(point.left - shellBox.left, shellBox.width - width));
    const roomBelow = window.innerHeight - point.bottom;
    const top = roomBelow > 340 ? point.bottom - shellBox.top + 10 : point.top - shellBox.top - 326;
    return { query: match[1], range: { from, to: instance.state.selection.from }, left, top, mode: "commands" };
  }, []);

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

  const scheduleSave = useCallback((markdown: string) => {
    latestMarkdownRef.current = markdown;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void saveLocalDocument(latestMarkdownRef.current).then(setHealth);
    }, 180);
  }, []);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: {
          openOnClick: true,
          linkOnPaste: true,
          autolink: true,
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
    ],
    content: "",
    contentType: "markdown",
    autofocus: "start",
    editorProps: {
      attributes: {
        class: "lab-document",
        "aria-label": "lab private Markdown note",
        autocapitalize: "sentences",
        autocomplete: "off",
        spellcheck: "true",
      },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []);
        return files.length > 0;
      },
    },
    onUpdate: ({ editor: instance }) => {
      syncInterface(instance);
      if (!loadedRef.current) return;
      scheduleSave(instance.getMarkdown());
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

  const runCommand = useCallback(
    (command: Command) => {
      if (!editor || !paletteRef.current) return;
      const current = paletteRef.current;
      const anchor = { ...current };
      editor.chain().focus().deleteRange(current.range).run();
      setPalette(null);

      if (command.id === "status") {
        void inspectLocalStorage().then((result) => {
          setHealth(result);
          setPalette({ ...anchor, query: "", range: { from: editor.state.selection.from, to: editor.state.selection.from }, mode: "status" });
        });
        return;
      }
      if (command.id === "clear") {
        setPalette({ ...anchor, query: "", range: { from: editor.state.selection.from, to: editor.state.selection.from }, mode: "confirm-clear" });
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
        case "undo": chain.undo().run(); break;
        case "redo": chain.redo().run(); break;
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
      await requestPersistentStorage();
      const markdown = await loadLocalDocument();
      if (!active) return;
      editor.commands.setContent(markdown, { contentType: "markdown", emitUpdate: false });
      latestMarkdownRef.current = markdown;
      loadedRef.current = true;
      setHealth(await inspectLocalStorage());
      editor.commands.focus("end");
      syncInterface(editor);
    })();
    return () => {
      active = false;
    };
  }, [editor, syncInterface]);

  useEffect(() => {
    if (!editor) return;
    const onResize = () => positionCaret(editor);
    window.addEventListener("resize", onResize, { passive: true });
    window.addEventListener("scroll", onResize, { passive: true });
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize);
    };
  }, [editor, positionCaret]);

  useEffect(() => {
    const flush = () => {
      if (!loadedRef.current) return;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      void saveLocalDocument(latestMarkdownRef.current);
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flush);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      flush();
    };
  }, []);

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
    void file.text().then((markdown) => {
      editor.commands.setContent(markdown, { contentType: "markdown" });
      editor.commands.focus("start");
    });
    event.target.value = "";
  };

  return (
    <div className="lab-shell" ref={shellRef} onKeyDownCapture={onKeyDownCapture}>
      <EditorContent editor={editor} />
      <div ref={caretRef} className="lab-caret" aria-hidden="true">
        <span ref={caretStrokeRef} className="lab-caret-stroke" data-blinking="true" />
      </div>
      <input ref={fileInputRef} hidden type="file" accept=".md,.markdown,text/markdown,text/plain" tabIndex={-1} aria-hidden="true" onChange={onImport} />

      {palette ? (
        <div className="command-palette" style={{ left: palette.left, top: palette.top }} role={palette.mode === "commands" ? "listbox" : "status"} aria-label="Slash commands">
          {palette.mode === "commands" ? (
            filtered.length > 0 ? (
              <div className="command-list">
                {filtered.map((command, index) => (
                  <div
                    className="command-item"
                    data-selected={index === selected}
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
            <div className="palette-message storage-message">
              <span>{health.copies} local {health.copies === 1 ? "copy" : "copies"}</span>
              <small>{health.labels.join(" · ") || "Storage is unavailable"}</small>
              <small>{health.persistent ? "Persistent storage granted" : "Browser-managed persistence"} · no network access</small>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
