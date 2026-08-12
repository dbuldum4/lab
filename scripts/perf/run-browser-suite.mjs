import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(import.meta.dirname, "../..");

export function resolvePlaywrightCommand(rootDirectory, platform = process.platform) {
  const executable = platform === "win32" ? "playwright.cmd" : "playwright";
  return resolve(rootDirectory, "node_modules", ".bin", executable);
}

export function shouldUseShell(platform = process.platform) {
  return platform === "win32";
}

function run(command, args, extraEnvironment = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: { ...process.env, ...extraEnvironment },
      stdio: "inherit",
      // npm exposes Playwright as a .cmd shim on Windows; cmd.exe is required
      // to execute that file through child_process.spawn.
      shell: shouldUseShell(),
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} exited with ${signal ?? code}.`));
    });
  });
}

async function main() {
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
  const playwright = resolvePlaywrightCommand(projectRoot);
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
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
