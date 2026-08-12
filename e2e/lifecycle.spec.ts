import { expect, test } from "@playwright/test";
import { openEditor, waitForAuthority } from "./helpers";

test("session navigation waits for the outgoing metadata touch", async ({ page }) => {
  await page.addInitScript(() => {
    const lockManager = navigator.locks;
    const request = lockManager?.request?.bind(lockManager);
    if (!request) return;

    let defaultMetadataRequests = 0;
    lockManager.request = ((name: string, options: LockOptions, callback: (lock: Lock | null) => unknown) => {
      const delay = name === "lab-session-metadata:default" && defaultMetadataRequests++ === 1;
      if (!delay) return request(name, options, callback);
      return request(name, options, (lock) => new Promise((resolve, reject) => {
        window.setTimeout(() => {
          Promise.resolve(callback(lock)).then(resolve, reject);
        }, 2_000);
      }));
    }) as typeof lockManager.request;
  });

  const editor = await openEditor(page);
  test.skip(
    !(await page.evaluate(() => typeof navigator.locks?.request === "function")),
    "Web Locks are unavailable in this browser",
  );

  const markdown = "metadata race note";
  await editor.fill(markdown);
  await waitForAuthority(page, markdown);

  await editor.press("End");
  await editor.press("Enter");
  await editor.type("/new");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#session=[a-zA-Z0-9_-]+$/);
  await expect(page.getByRole("textbox", { name: "lab local-only Markdown note" }))
    .toHaveAttribute("contenteditable", "true", { timeout: 15_000 });

  await expect.poll(
    () => page.evaluate(() => localStorage.getItem("lab.session.v1.default")),
    { timeout: 5_000 },
  ).not.toBeNull();
});
