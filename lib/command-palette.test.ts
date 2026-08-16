import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMANDS,
  filterCommands,
  filterThemes,
  paletteLabel,
  paletteRole,
  type PaletteState,
} from "./command-palette.ts";

function palette(mode: PaletteState["mode"], query = ""): PaletteState {
  return {
    mode,
    query,
    range: { from: 1, to: 1 },
    left: 0,
    top: 0,
    anchor: { left: 0, top: 0, bottom: 0 },
  };
}

test("command filtering keeps the current session actions mutually exclusive", () => {
  const visible = filterCommands(palette("commands"), true, false).map((command) => command.id);

  assert.ok(visible.includes("unpin"));
  assert.ok(!visible.includes("pin"));
  assert.ok(visible.includes("archive"));
  assert.ok(!visible.includes("unarchive"));
});

test("command filtering ranks exact ids before label prefixes and terms", () => {
  const commands = filterCommands(palette("commands", "history"), false, false);
  assert.equal(commands[0]?.id, "history");

  const list = filterCommands(palette("commands", "table row"), false, false, {
    inTable: true,
    inCodeBlock: false,
    inLink: false,
    selectedImage: false,
  });
  assert.deepEqual(list.slice(0, 2).map((command) => command.id), [
    "table-row-before",
    "table-row-after",
  ]);
  assert.equal(COMMANDS.some((command) => command.id === "table-row-before"), true);
});

test("theme filtering is accent-insensitive and ignores non-theme palettes", () => {
  const allThemes = filterThemes(palette("theme"));
  const rose = filterThemes(palette("theme", "rose pine"));
  const accentInsensitive = filterThemes(palette("theme", "Rosé"));

  assert.ok(allThemes.length > 10);
  assert.deepEqual(rose.map((theme) => theme.id), ["rose-pine-dawn"]);
  assert.deepEqual(accentInsensitive.map((theme) => theme.id), ["rose-pine-dawn"]);
  assert.deepEqual(filterThemes(palette("commands")), []);
});

test("palette accessibility contracts cover every mode family", () => {
  assert.equal(paletteRole("commands"), "listbox");
  assert.equal(paletteRole("language"), "listbox");
  assert.equal(paletteRole("history"), "dialog");
  assert.equal(paletteRole("sessions"), "dialog");
  assert.equal(paletteRole("search"), "dialog");
  assert.equal(paletteRole("status"), "status");
  assert.equal(paletteLabel("link-session"), "Choose a session to link");
  assert.equal(paletteLabel("theme"), "Choose a theme");
  assert.equal(paletteRole("confirm"), "alertdialog");
  assert.equal(paletteRole("confirm-import"), "alertdialog");
  assert.equal(paletteLabel("confirm"), "Confirm action");
});
