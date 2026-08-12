import assert from "node:assert/strict";
import test from "node:test";
import { filterPickerOptions, normalizePickerQuery } from "./picker-filter.ts";

test("normalizes case, accents, and repeated whitespace for picker queries", () => {
  assert.equal(normalizePickerQuery("  Rosé\t  Pine  "), "rose pine");
  assert.equal(normalizePickerQuery("Crème brûlée"), "creme brulee");
});

test("matches every query term without changing option order", () => {
  const options = [
    { id: "rose", label: "Rosé Pine" },
    { id: "dark", label: "Dark" },
    { id: "notes", label: "Rose notes" },
  ];

  assert.deepEqual(
    filterPickerOptions(options, "  ROSE   pine ", (option) => option.label),
    [options[0]],
  );
  assert.deepEqual(
    filterPickerOptions(options, "rose", (option) => option.label).map((option) => option.id),
    ["rose", "notes"],
  );
  assert.deepEqual(filterPickerOptions(options, "   ", (option) => option.label), options);
});
