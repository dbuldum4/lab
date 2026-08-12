import assert from "node:assert/strict";
import test from "node:test";
import {
  commandAvailability,
  rankCommands,
  type CommandContext,
} from "./command-availability.ts";

const plainContext: CommandContext = {
  inTable: false,
  inCodeBlock: false,
  inLink: false,
  selectedImage: false,
};

test("marks context-specific commands unavailable with an actionable reason", () => {
  for (const commandId of [
    "table-row-after",
    "table-delete-column",
    "table-toggle-header",
  ]) {
    const result = commandAvailability(commandId, plainContext);
    assert.equal(result.available, false, commandId);
    assert.equal(result.reason, "Place the caret inside a table first.");
  }

  assert.deepEqual(commandAvailability("language", plainContext), {
    available: false,
    reason: "Place the caret inside a code block first.",
  });
  assert.deepEqual(commandAvailability("edit-link", plainContext), {
    available: false,
    reason: "Place the caret inside a link first.",
  });
  assert.deepEqual(commandAvailability("image-metadata", plainContext), {
    available: false,
    reason: "Select an image first.",
  });
  assert.deepEqual(commandAvailability("table", plainContext), { available: true });
});

test("makes each contextual command available in its matching editor context", () => {
  assert.equal(commandAvailability("table-row-before", { ...plainContext, inTable: true }).available, true);
  assert.equal(commandAvailability("language", { ...plainContext, inCodeBlock: true }).available, true);
  assert.equal(commandAvailability("edit-link", { ...plainContext, inLink: true }).available, true);
  assert.equal(commandAvailability("image-metadata", { ...plainContext, selectedImage: true }).available, true);
});

test("ranks available commands before matching unavailable commands", () => {
  const commands = [
    { id: "table-row-after", label: "Table row below", detail: "", terms: "table row" },
    { id: "table", label: "Table", detail: "", terms: "grid rows columns" },
    { id: "language", label: "Code language", detail: "", terms: "code block" },
    { id: "text", label: "Text", detail: "", terms: "paragraph" },
  ];

  const ranked = rankCommands(commands, "", plainContext);
  assert.deepEqual(ranked.map(({ command }) => command.id), [
    "table",
    "text",
    "table-row-after",
    "language",
  ]);
  assert.deepEqual(
    ranked.filter(({ availability }) => availability.available).map(({ command }) => command.id),
    ["table", "text"],
  );
});

test("filters before ranking and preserves useful exact matches", () => {
  const commands = [
    { id: "table-row-after", label: "Table row below", detail: "", terms: "table row" },
    { id: "table", label: "Table", detail: "", terms: "grid rows columns" },
    { id: "text", label: "Text", detail: "", terms: "paragraph" },
  ];

  const ranked = rankCommands(commands, "table-row-after", plainContext);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]?.command.id, "table-row-after");
  assert.equal(ranked[0]?.availability.available, false);
});
