import { chromium, expect } from "@playwright/test";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { startStaticServer } from "./perf/static-server.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

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

async function main() {
  await run(npm, ["run", "build"], { LAB_GITHUB_PAGES_BUILD: "true" });

  const server = await startStaticServer(resolve(projectRoot, "out"), 0, "/lab");
  let browser;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({ locale: "en-US" });
    await context.addInitScript(() => {
      if (!localStorage.getItem("lab.theme.v1")) localStorage.setItem("lab.theme.v1", "light");
    });
    const page = await context.newPage();
    const brokenAssets = [];
    const failedRequests = [];
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.pathname.includes("/_next/")) {
        if (!url.pathname.startsWith("/lab/")) {
          brokenAssets.push(`asset escaped /lab basePath: ${response.url()}`);
        }
        if (response.status() >= 400) {
          brokenAssets.push(`${response.status()} ${response.url()}`);
        }
      }
    });
    page.on("requestfailed", (request) => {
      failedRequests.push(`${request.failure()?.errorText ?? "request failed"} ${request.url()}`);
    });

    const baseUrl = `${server.url}/lab`;
    const rootResponse = await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
    if (!rootResponse || rootResponse.status() >= 400) {
      throw new Error(`The static root did not load: ${rootResponse?.status() ?? "no response"}`);
    }

    const editor = page.getByRole("textbox", { name: "lab local-only Markdown note" });
    await expect(editor).toBeVisible({ timeout: 15_000 });
    await expect(editor).toHaveAttribute("contenteditable", "true");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    await editor.fill("Static export smoke");
    await expect(editor).toContainText("Static export smoke");
    await expect.poll(
      () => page.evaluate(() => localStorage.getItem("lab.document.v1") ?? ""),
      { timeout: 15_000, intervals: [100, 250, 500] },
    ).toContain("Static export smoke");

    await editor.fill("");
    await editor.pressSequentially("/theme");
    await page.keyboard.press("Enter");
    const themeList = page.getByTestId("theme-list");
    await expect(themeList).toBeVisible();
    await themeList.getByRole("option", { name: "Dark Original lab theme", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("lab.theme.v1"))).toBe("dark");

    await page.reload({ waitUntil: "networkidle" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(editor).toBeVisible();

    const noticeResponse = await page.goto(`${baseUrl}/third-party-notices/`, { waitUntil: "networkidle" });
    if (!noticeResponse || noticeResponse.status() !== 200) {
      throw new Error(`The static third-party notices route did not load: ${noticeResponse?.status() ?? "no response"}`);
    }
    await expect(page.getByRole("heading", { name: "Third-party theme notices" })).toBeVisible();
    await expect(page.getByText("Copyright (c) 2023 Steph Ango", { exact: false })).toBeVisible();

    const assetHrefs = await page.locator('link[rel="stylesheet"], script[src]').evaluateAll((elements) => (
      elements
        .map((element) => element instanceof HTMLLinkElement ? element.href : element.src)
        .filter(Boolean)
    ));
    if (assetHrefs.length === 0) throw new Error("The third-party notices page did not expose any built assets.");
    const assetStatuses = await page.evaluate(async (hrefs) => Promise.all(hrefs.map(async (href) => {
      const response = await fetch(href, { cache: "no-store" });
      return { href, status: response.status };
    })), assetHrefs);
    const unresolvedAssets = assetStatuses.filter(({ status }) => status !== 200);
    if (unresolvedAssets.length > 0) {
      throw new Error(`Built notice-page assets did not resolve: ${JSON.stringify(unresolvedAssets)}`);
    }
    if (brokenAssets.length > 0 || failedRequests.length > 0) {
      throw new Error(`Static export requests failed:\n${[...brokenAssets, ...failedRequests].join("\n")}`);
    }
  } finally {
    await browser?.close();
    await server.close();
  }
}

await main();
console.log("Static GitHub Pages export smoke test passed.");
