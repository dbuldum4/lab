from pathlib import Path

path = Path("components/lab-editor.tsx")
text = path.read_text()

old = '        recordDocumentVersion(documentId, markdown, { force: true });\n        editor.commands.setContent(markdown, { contentType: "markdown", emitUpdate: false });'
new = '        editor.commands.setContent(markdown, { contentType: "markdown", emitUpdate: false });'
if old not in text:
    raise SystemExit("hydrate history anchor not found")
text = text.replace(old, new, 1)

old = '          const versions = listDocumentVersions(documentId);\n          setHistoryVersions(versions);'
new = '          const versions = listDocumentVersions(documentId).filter((version) => version.markdown !== currentMarkdown);\n          setHistoryVersions(versions);'
if old not in text:
    raise SystemExit("history filtering anchor not found")
text = text.replace(old, new, 1)

old = '<span>{index === 0 ? "Current checkpoint" : new Date(version.createdAt).toLocaleString()}</span>'
new = '<span>{new Date(version.createdAt).toLocaleString()}</span>'
if old not in text:
    raise SystemExit("history label anchor not found")
text = text.replace(old, new, 1)

old = '<div className="palette-message">No local checkpoints yet</div>'
new = '<div className="palette-message">No earlier checkpoints yet</div>'
if old not in text:
    raise SystemExit("history empty state anchor not found")

path.write_text(text.replace(old, new, 1))
