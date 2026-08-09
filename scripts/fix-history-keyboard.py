from pathlib import Path

path = Path("components/lab-editor.tsx")
text = path.read_text()

old = '  const selectedRef = useRef(0);\n  const [palette, setPaletteState] = useState<PaletteState | null>(null);'
new = '  const selectedRef = useRef(0);\n  const historySelectionRef = useRef(0);\n  const [palette, setPaletteState] = useState<PaletteState | null>(null);'
if old not in text:
    raise SystemExit("history selection ref anchor not found")
text = text.replace(old, new, 1)

old = '''          const versions = listDocumentVersions(documentId);
          setHistoryVersions(versions);
          setSelected(0);
          setPalette({ ...anchor, query: "", range: { from: editor.state.selection.from, to: editor.state.selection.from }, mode: "history" });
'''
new = '''          const versions = listDocumentVersions(documentId);
          setHistoryVersions(versions);
          historySelectionRef.current = 0;
          setSelected(0);
          setPalette({ ...anchor, query: "", range: { from: editor.state.selection.from, to: editor.state.selection.from }, mode: "history" });
'''
if old not in text:
    raise SystemExit("history open anchor not found")
text = text.replace(old, new, 1)

old = '''    if (current.mode === "history") {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        const count = Math.max(1, historyVersions.length);
        setSelected((selectedRef.current + direction + count) % count);
      } else if ((event.key === "Enter" || event.key === "Tab") && historyVersions.length > 0) {
        event.preventDefault();
        restoreHistoryVersion(historyVersions[selectedRef.current] ?? historyVersions[0]);
      }
      return;
    }
'''
new = '''    if (current.mode === "history") {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        const count = Math.max(1, historyVersions.length);
        const next = (historySelectionRef.current + direction + count) % count;
        historySelectionRef.current = next;
        setSelected(next);
      } else if ((event.key === "Enter" || event.key === "Tab") && historyVersions.length > 0) {
        event.preventDefault();
        const index = Math.min(historySelectionRef.current, historyVersions.length - 1);
        restoreHistoryVersion(historyVersions[index] ?? historyVersions[0]);
      }
      return;
    }
'''
if old not in text:
    raise SystemExit("history keyboard anchor not found")
text = text.replace(old, new, 1)

old = '                    onMouseEnter={() => setSelected(index)}\n                  >\n                    <span>{index === 0 ? "Current checkpoint"'
new = '                    onMouseEnter={() => { historySelectionRef.current = index; setSelected(index); }}\n                  >\n                    <span>{index === 0 ? "Current checkpoint"'
if old not in text:
    raise SystemExit("history mouse selection anchor not found")

path.write_text(text.replace(old, new, 1))
