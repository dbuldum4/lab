from pathlib import Path

path = Path("components/lab-editor.tsx")
text = path.read_text()

effect = '''
  useEffect(() => {
    if (palette?.mode !== "commands") return;
    setSelected(0);
  }, [palette?.mode, palette?.query, setSelected]);
'''
if effect not in text:
    raise SystemExit("selection-reset effect not found")
text = text.replace(effect, "", 1)

old = '''    if ((event.key === "Enter" || event.key === "Tab") && filtered.length > 0) {
      event.preventDefault();
      runCommand(filtered[selectedRef.current] ?? filtered[0]);
    }
'''
new = '''    if ((event.key === "Enter" || event.key === "Tab") && filtered.length > 0) {
      event.preventDefault();
      const exact = filtered.find((command) => command.id === current.query.trim().toLowerCase());
      runCommand(exact ?? filtered[selectedRef.current] ?? filtered[0]);
    }
'''
if old not in text:
    raise SystemExit("command execution anchor not found")
path.write_text(text.replace(old, new, 1))
