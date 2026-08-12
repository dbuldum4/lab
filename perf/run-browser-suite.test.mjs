import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import {
  resolvePlaywrightCommand,
  shouldUseShell,
} from "../scripts/perf/run-browser-suite.mjs";

const projectRoot = "/workspace/lab";
const binDirectory = resolve(projectRoot, "node_modules", ".bin");

test("the performance runner selects the platform's Playwright shim", () => {
  assert.equal(
    resolvePlaywrightCommand(projectRoot, "darwin"),
    resolve(binDirectory, "playwright"),
  );
  assert.equal(
    resolvePlaywrightCommand(projectRoot, "win32"),
    resolve(binDirectory, "playwright.cmd"),
  );
  assert.equal(shouldUseShell("darwin"), false);
  assert.equal(shouldUseShell("win32"), true);
});
