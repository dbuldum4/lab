import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const projectRoot = resolve(import.meta.dirname, "../..");
const mode = process.argv[2] ?? "score";
if (mode !== "core" && mode !== "score" && mode !== "extended") {
  console.error("Usage: node scripts/perf/run-browser-suite.mjs <core|score|extended>");
  process.exit(64);
}
const resultsDirectory = resolve(projectRoot, ".perf-results");
const resultsPath = resolve(
  resultsDirectory,
  mode === "score" ? "latest.ndjson" : mode === "core" ? "latest-core.ndjson" : "latest-extended.ndjson",
);

function run(command, args, extraEnvironment = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: { ...process.env, ...extraEnvironment },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} exited with ${signal ?? code}.`));
    });
  });
}

await mkdir(resultsDirectory, { recursive: true });
await writeFile(resultsPath, "", "utf8");
if (mode === "score") {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  await run(npm, ["run", "test:perf:unit"], { LAB_PERF_RESULTS_FILE: resultsPath });
}
if (process.env.LAB_PERF_SKIP_BUILD !== "1") {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  await run(npm, ["run", "build"]);
}
const playwright = resolve(projectRoot, "node_modules/.bin/playwright");
const coreFiles = ["e2e/performance.spec.ts", "e2e/performance-interactions.spec.ts"];
const files = mode === "core"
  ? coreFiles
  : mode === "score"
    ? [...coreFiles, "e2e/performance-extended.spec.ts"]
    : ["e2e/performance-extended.spec.ts"];
await run(playwright, [
  "test",
  "--config", "playwright.perf.config.ts",
  ...files,
  "--grep", mode === "core" ? "@perf-score" : mode === "extended" ? "@perf-extended" : "@perf-",
], { LAB_PERF_RESULTS_FILE: resultsPath });

if (mode === "score") {
  await run(process.execPath, ["scripts/perf/score.mjs", resultsPath]);
} else {
  console.log(`Saved ${mode} results: ${resultsPath}`);
}
