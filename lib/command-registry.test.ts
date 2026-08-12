import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMANDS,
  COMMAND_VARIANT_PAIRS,
  KEYBOARD_SHORTCUTS,
  isDynamicCommandVisible,
} from "./command-registry.ts";

const COMMAND_IDS_IN_ORDER = [
  "text", "h1", "h2", "h3", "outline", "bullet", "number", "todo", "quote", "code", "divider",
  "table", "table-row-before", "table-row-after", "table-delete-row", "table-column-before",
  "table-column-after", "table-delete-column", "table-toggle-header", "table-delete", "language",
  "callout-note", "callout-tip", "callout-warning", "callout-important", "details", "inline-math", "math",
  "link", "link-note", "backlinks", "edit-link", "image", "image-metadata", "undo", "redo", "import",
  "export", "backup", "restore", "recover", "new", "name", "pin", "unpin", "archive", "unarchive",
  "sessions", "archives", "search", "stats", "history", "shortcuts", "theme", "delete", "status", "clear",
];

test("command metadata has stable order, unique ids, and readable fields", () => {
  assert.deepEqual(COMMANDS.map((command) => command.id), COMMAND_IDS_IN_ORDER);
  assert.equal(new Set(COMMANDS.map((command) => command.id)).size, COMMANDS.length);

  for (const command of COMMANDS) {
    assert.notEqual(command.label.trim(), "", `${command.id} needs a label`);
    assert.notEqual(command.detail.trim(), "", `${command.id} needs detail text`);
    assert.notEqual(command.terms.trim(), "", `${command.id} needs search terms`);
    assert.match(command.executionPath, /^(editor|palette|dialog|file-input|async)\./);
  }
});

test("shortcut chords are unique and point at real commands", () => {
  assert.equal(
    new Set(KEYBOARD_SHORTCUTS.map((shortcut) => shortcut.keys)).size,
    KEYBOARD_SHORTCUTS.length,
  );
  assert.deepEqual(
    KEYBOARD_SHORTCUTS.map((shortcut) => shortcut.commandId),
    ["sessions", "search", "outline", "stats", "history", "language", "edit-link", "new", "math", "export", "shortcuts"],
  );

  const commandIds = new Set(COMMANDS.map((command) => command.id));
  for (const shortcut of KEYBOARD_SHORTCUTS) {
    assert.ok(commandIds.has(shortcut.commandId), `${shortcut.keys} references ${shortcut.commandId}`);
    assert.notEqual(shortcut.action.trim(), "", `${shortcut.keys} needs an action`);
  }
});

test("dynamic pin and archive variants stay paired and state-aware", () => {
  const commandIds = new Set(COMMANDS.map((command) => command.id));
  assert.deepEqual(
    COMMAND_VARIANT_PAIRS.map((pair) => [pair.enabled, pair.disabled]),
    [["pin", "unpin"], ["archive", "unarchive"]],
  );

  for (const pair of COMMAND_VARIANT_PAIRS) {
    assert.ok(commandIds.has(pair.enabled), `${pair.enabled} is registered`);
    assert.ok(commandIds.has(pair.disabled), `${pair.disabled} is registered`);
    const enabledState = pair.state === "pinned"
      ? { pinned: true, archived: false }
      : { pinned: false, archived: true };
    const disabledState = pair.state === "pinned"
      ? { pinned: false, archived: false }
      : { pinned: false, archived: false };
    assert.equal(isDynamicCommandVisible(pair.enabled, enabledState), false);
    assert.equal(isDynamicCommandVisible(pair.disabled, enabledState), true);
    assert.equal(isDynamicCommandVisible(pair.enabled, disabledState), true);
    assert.equal(isDynamicCommandVisible(pair.disabled, disabledState), false);
  }
});
