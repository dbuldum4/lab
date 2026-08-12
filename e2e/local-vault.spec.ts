import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  LOCAL_KEY,
  PENDING_PREFIX,
  backendState,
  editorText,
  openEditor,
  pendingRecords,
  waitForAuthority,
} from "./helpers";

test("a note survives a real Chromium save and reload", async ({ page }) => {
  const editor = await openEditor(page);
  const markdown = "real browser persistence";
  await editor.fill(markdown);
  await waitForAuthority(page, markdown);
  await expect.poll(() => editorText(page), { timeout: 5000 }).toBe(markdown);

  await page.reload();
  await openEditor(page);
  await expect.poll(() => editorText(page), { timeout: 10000 }).toBe(markdown);
});

test("real replicas self-heal after localStorage deletion and OPFS corruption", async ({ page }) => {
  const editor = await openEditor(page);
  const markdown = "self healing browser note";
  await editor.fill(markdown);
  await waitForAuthority(page, markdown);
  const initial = await backendState(page);
  test.skip(!initial.opfsSupported, "Chromium in this environment does not expose OPFS");
  expect(initial.local?.markdown).toBe(markdown);
  expect(initial.authority?.snapshot.markdown).toBe(markdown);
  expect(initial.current?.markdown).toBe(markdown);
  expect(initial.opfs?.markdown).toBe(markdown);

  await page.evaluate(({ localKey }) => localStorage.removeItem(localKey), { localKey: LOCAL_KEY });
  await page.reload();
  await openEditor(page);
  await expect.poll(async () => (await backendState(page)).local?.markdown ?? null, { timeout: 10000 }).toBe(markdown);

  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle("lab.md.snapshot");
    const writable = await handle.createWritable();
    await writable.write("corrupt opfs payload");
    await writable.close();
  });
  await page.reload();
  await openEditor(page);
  await expect.poll(async () => (await backendState(page)).opfs?.markdown ?? null, { timeout: 10000 }).toBe(markdown);
  const healed = await backendState(page);
  expect(healed.local?.markdown).toBe(markdown);
  expect(healed.authority?.snapshot.markdown).toBe(markdown);
  expect(healed.current?.markdown).toBe(markdown);
  expect(healed.opfs?.markdown).toBe(markdown);
});

test("storage status reports the real redundant copies", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.fill("status note");
  await waitForAuthority(page, "status note");
  await editor.fill("");
  await editor.type("/status");
  await expect(page.locator("#slash-command-palette")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("storage-status")).toContainText("local");
  await expect(page.getByTestId("storage-status")).toContainText("IndexedDB");
});

test("a staged draft survives abrupt page termination and a new session owner", async ({ context, page }) => {
  await context.addInitScript(() => {
    (window as Window & { __LAB_E2E_SAVE_DELAY__?: number }).__LAB_E2E_SAVE_DELAY__ = 60_000;
  });
  const editor = await openEditor(page);
  const draft = "crash recovery draft";
  await editor.fill(draft);
  await expect.poll(
    () => page.evaluate((prefix) => Object.keys(localStorage).some((key) => key.startsWith(prefix)), PENDING_PREFIX),
    { timeout: 5000 },
  ).toBe(true);
  const beforeTermination = await backendState(page);
  expect(beforeTermination.authority).toBeNull();

  await page.close({ runBeforeUnload: false });
  const reopened = await context.newPage();
  await openEditor(reopened);
  await expect.poll(() => editorText(reopened), { timeout: 10000 }).toBe(draft);
  await reopened.close();
});

test("pages with a copied session owner stage independent recovery drafts", async ({ context, page }) => {
  await context.addInitScript(() => {
    sessionStorage.setItem("lab.document.pending.owner.v1", "copied-owner");
    (window as Window & { __LAB_E2E_SAVE_DELAY__?: number }).__LAB_E2E_SAVE_DELAY__ = 60_000;
  });
  const pageA = page;
  const pageB = await context.newPage();
  const [editorA, editorB] = await Promise.all([openEditor(pageA), openEditor(pageB)]);
  await Promise.all([editorA.fill("copied owner A"), editorB.fill("copied owner B")]);

  const records = await pendingRecords(pageA);
  expect(records.some((record) => record.markdown === "copied owner A")).toBe(true);
  expect(records.some((record) => record.markdown === "copied owner B")).toBe(true);
  expect(new Set(records.map((record) => record.storageKey)).size).toBeGreaterThanOrEqual(2);
});

test("two pages converge on the deterministic authority winner and retain the loser draft", async ({ context, page }) => {
  await context.addInitScript(() => {
    const fixedNow = 1_730_000_000_000;
    Date.now = () => fixedNow;
    (window as Window & { __LAB_E2E_SAVE_DELAY__?: number }).__LAB_E2E_SAVE_DELAY__ = 60_000;
  });
  const pageA = page;
  const pageB = await context.newPage();
  const editorA = await openEditor(pageA);
  const editorB = await openEditor(pageB);
  await Promise.all([editorA.fill("tab A"), editorB.fill("tab B")]);
  const candidates = await pendingRecords(pageA);
  expect(candidates.length).toBeGreaterThanOrEqual(2);
  const winner = [...candidates].sort((left, right) => (
    right.updatedAt - left.updatedAt || right.snapshotChecksum.localeCompare(left.snapshotChecksum)
  ))[0];
  const loser = candidates.find((candidate) => candidate.storageKey !== winner.storageKey);
  expect(loser).toBeDefined();

  await Promise.all([
    pageA.evaluate(() => window.dispatchEvent(new Event("pagehide"))),
    pageB.evaluate(() => window.dispatchEvent(new Event("pagehide"))),
  ]);
  await waitForAuthority(pageA, winner.markdown);
  await Promise.all([pageA.reload(), pageB.reload()]);
  await Promise.all([openEditor(pageA), openEditor(pageB)]);
  await expect.poll(() => editorText(pageA), { timeout: 10000 }).toBe(winner.markdown);
  await expect.poll(() => editorText(pageB), { timeout: 10000 }).toBe(winner.markdown);
  const pendingAfterReload = await pendingRecords(pageA);
  expect(pendingAfterReload.some((candidate) => candidate.markdown !== winner.markdown)).toBe(true);

  const hydratedEditor = pageA.getByRole("textbox", { name: "lab local-only Markdown note" });
  await hydratedEditor.press("End");
  await hydratedEditor.press("Enter");
  await hydratedEditor.type("/recover");
  await expect(pageA.locator("#slash-command-palette")).toBeVisible();
  const downloadPromise = pageA.waitForEvent("download");
  await pageA.keyboard.press("Enter");
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("lab-recovery.md");
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  expect(await readFile(downloadPath as string, "utf8")).toBe(loser?.markdown);
});

test("new, name, and sessions keep independent documents resumable across tabs", async ({ context, page }) => {
  const editor = await openEditor(page);
  await editor.fill("original session note");
  await waitForAuthority(page, "original session note");

  await editor.press("End");
  await editor.press("Enter");
  await editor.type("/new");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#session=[a-zA-Z0-9_-]+$/);
  const sessionUrl = page.url();
  const newEditor = page.getByRole("textbox", { name: "lab local-only Markdown note" });
  await expect(newEditor).toHaveAttribute("contenteditable", "true", { timeout: 15000 });
  await expect(newEditor).toHaveText("");
  await newEditor.fill("separate session note");
  const scopedId = new URL(sessionUrl).hash.replace("#session=", "");
  await expect.poll(() => page.evaluate(({ localKey, scopedKey }) => ({
    original: JSON.parse(localStorage.getItem(localKey) ?? "null")?.markdown?.trim() ?? null,
    scoped: JSON.parse(localStorage.getItem(scopedKey) ?? "null")?.markdown?.trim() ?? null,
  }), { localKey: LOCAL_KEY, scopedKey: `lab.document.v2.${scopedId}` }), { timeout: 15000 }).toEqual({
    original: "original session note",
    scoped: "separate session note",
  });
  await expect.poll(() => page.evaluate(async ({ scopedAuthority }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("lab-private-vault");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<{ original: string | null; scoped: string | null }>((resolve, reject) => {
        const transaction = database.transaction("documents", "readonly");
        const store = transaction.objectStore("documents");
        const originalRequest = store.get("authority");
        const scopedRequest = store.get(scopedAuthority);
        transaction.oncomplete = () => resolve({
          original: originalRequest.result?.snapshot?.markdown?.trim() ?? null,
          scoped: scopedRequest.result?.snapshot?.markdown?.trim() ?? null,
        });
        transaction.onerror = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  }, { scopedAuthority: `authority:${scopedId}` }), { timeout: 15000 }).toEqual({
    original: "original session note",
    scoped: "separate session note",
  });

  await newEditor.press("End");
  await newEditor.press("Enter");
  await newEditor.type("/name");
  await page.keyboard.press("Enter");
  const nameInput = page.getByLabel("Session name");
  await expect(nameInput).toBeFocused();
  await nameInput.fill("Research");
  await nameInput.press("Enter");
  await expect(nameInput).toBeHidden();

  await newEditor.press("End");
  await newEditor.press("Enter");
  await newEditor.type("/sessions");
  await page.keyboard.press("Enter");
  const sessionList = page.getByTestId("session-list");
  await expect(sessionList).toContainText("Research");
  await expect(sessionList).toContainText("original session note");

  const originalTab = await context.newPage();
  const originalEditor = await openEditor(originalTab);
  await expect(originalTab).not.toHaveURL(/#session=/);
  await expect(originalEditor).toContainText("original session note");
  await expect(page).toHaveURL(sessionUrl);
  await expect(newEditor).toContainText("separate session note");
});

test("search finds session names and verified note excerpts, then opens the result", async ({ page }) => {
  const editor = await openEditor(page);
  const originalNote = "Q3 launch planning notes with the final checklist.";
  await editor.fill(originalNote);
  await waitForAuthority(page, originalNote);

  await editor.press("End");
  await editor.press("Enter");
  await editor.type("/name");
  await page.keyboard.press("Enter");
  const originalName = page.getByLabel("Session name");
  await originalName.fill("Planning");
  await originalName.press("Enter");
  await expect(originalName).toBeHidden();

  await editor.press("End");
  await editor.press("Enter");
  await editor.type("/new");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#session=[a-zA-Z0-9_-]+$/);
  const sessionId = new URL(page.url()).hash.replace("#session=", "");
  const secondEditor = page.getByRole("textbox", { name: "lab local-only Markdown note" });
  await expect(secondEditor).toHaveAttribute("contenteditable", "true", { timeout: 15000 });
  const secondNote = "Dinner recipe: coconut curry for Friday.";
  await secondEditor.fill(secondNote);
  await expect.poll(() => page.evaluate((key) => (
    JSON.parse(localStorage.getItem(key) ?? "null")?.markdown?.trim() ?? null
  ), `lab.document.v2.${sessionId}`), { timeout: 15000 }).toBe(secondNote);

  await secondEditor.press("End");
  await secondEditor.press("Enter");
  await secondEditor.type("/name");
  await page.keyboard.press("Enter");
  const secondName = page.getByLabel("Session name");
  await secondName.fill("Recipes");
  await secondName.press("Enter");
  await expect(secondName).toBeHidden();

  await secondEditor.press("End");
  await secondEditor.press("Enter");
  await secondEditor.type("/search");
  await page.keyboard.press("Enter");
  const searchInput = page.getByRole("combobox", { name: "Search local notes" });
  await expect(searchInput).toBeVisible();
  await expect(searchInput).toHaveAttribute("aria-expanded", "true");
  await expect(searchInput).toHaveAttribute("aria-controls", "slash-command-palette-results");
  await expect(page.locator("#slash-command-palette-results")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "lab local-only Markdown note" }))
    .not.toHaveAttribute("aria-controls", "slash-command-palette-results");

  await searchInput.fill("planning launch");
  const crossFieldResult = page.getByTestId("search-result").filter({ hasText: "Planning" });
  await expect(crossFieldResult).toContainText("final checklist");
  await expect(crossFieldResult).toContainText("Name + note text");
  await expect(searchInput).toHaveAttribute("aria-activedescendant", "slash-command-palette-search-default");

  await searchInput.fill("launch");
  const launchResult = page.getByTestId("search-result").filter({ hasText: "Planning" });
  await expect(launchResult).toContainText("final checklist");
  await expect(launchResult).toContainText("Note text");

  await searchInput.fill("recipes");
  const nameResult = page.getByTestId("search-result").filter({ hasText: "Recipes" });
  await expect(nameResult).toContainText("Session name");

  await searchInput.fill("launch");
  await searchInput.press("Enter");
  await expect(page).not.toHaveURL(/#session=/);
  await expect(page.getByRole("textbox", { name: "lab local-only Markdown note" })).toContainText(originalNote);
});

test("search ignores accents in names and note content while highlighting the originals", async ({ page }) => {
  const editor = await openEditor(page);
  const note = "Meet for crème brûlée at the café.";
  await editor.fill(note);
  await waitForAuthority(page, note);

  await editor.press("End");
  await editor.press("Enter");
  await editor.type("/name");
  await page.keyboard.press("Enter");
  const nameInput = page.getByLabel("Session name");
  await nameInput.fill("Café plans");
  await nameInput.press("Enter");
  await expect(nameInput).toBeHidden();

  await editor.press("End");
  await editor.press("Enter");
  await editor.type("/search");
  await page.keyboard.press("Enter");
  const searchInput = page.getByRole("combobox", { name: "Search local notes" });
  await searchInput.fill("  CAFE   CREME ");

  const result = page.getByTestId("search-result").filter({ hasText: "Café plans" });
  await expect(result).toContainText("crème brûlée");
  await expect(result.locator("mark")).toHaveCount(3);
  await expect(result.locator("mark").nth(0)).toHaveText("Café");
  await expect(result.locator("mark").nth(1)).toHaveText("crème");
  await expect(result.locator("mark").nth(2)).toHaveText("café");
});

test("keyboard search selection scrolls the active result into view", async ({ page }) => {
  const editor = await openEditor(page);
  await page.evaluate(async () => {
    const base = Date.now();
    for (let index = 0; index < 6; index += 1) {
      const id = `scroll-seeded-${index}`;
      const markdown = `scroll token ${index}`;
      const updatedAt = base + index;
      const bytes = new TextEncoder().encode(JSON.stringify(["lab.snapshot.v2", updatedAt, markdown]));
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const checksum = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      localStorage.setItem(`lab.session.v1.${id}`, JSON.stringify({
        id,
        name: `Scroll ${index}`,
        createdAt: updatedAt,
        updatedAt,
      }));
      localStorage.setItem(`lab.document.v2.${id}`, JSON.stringify({ markdown, updatedAt, checksum, version: 2 }));
    }
  });

  await editor.press("End");
  await editor.press("Enter");
  await editor.type("/search");
  await page.keyboard.press("Enter");
  const searchInput = page.getByRole("combobox", { name: "Search local notes" });
  await searchInput.fill("scroll token");
  const results = page.getByTestId("search-result");
  await expect(results).toHaveCount(6);

  for (let index = 0; index < 5; index += 1) await searchInput.press("ArrowDown");
  const selectedResult = page.locator('.search-result[data-selected="true"]');
  await expect(selectedResult).toHaveCount(1);
  await expect.poll(async () => page.evaluate(() => {
    const container = document.getElementById("slash-command-palette-results")?.getBoundingClientRect();
    const selected = document.querySelector('.search-result[data-selected="true"]')?.getBoundingClientRect();
    if (!container || !selected) return false;
    return selected.top >= container.top - 1 && selected.bottom <= container.bottom + 1;
  }), { timeout: 5000 }).toBe(true);
});

test("search keyboard navigation waits for IME composition to finish", async ({ page }) => {
  const editor = await openEditor(page);
  await page.evaluate(async () => {
    const base = Date.now();
    for (let index = 0; index < 2; index += 1) {
      const id = `composition-seeded-${index}`;
      const markdown = `composition token ${index}`;
      const updatedAt = base + index;
      const bytes = new TextEncoder().encode(JSON.stringify(["lab.snapshot.v2", updatedAt, markdown]));
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const checksum = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      localStorage.setItem(`lab.session.v1.${id}`, JSON.stringify({
        id,
        name: `Composition ${index}`,
        createdAt: updatedAt,
        updatedAt,
      }));
      localStorage.setItem(`lab.document.v2.${id}`, JSON.stringify({ markdown, updatedAt, checksum, version: 2 }));
    }
  });

  await editor.press("End");
  await editor.press("Enter");
  await editor.type("/search");
  await page.keyboard.press("Enter");
  const searchInput = page.getByRole("combobox", { name: "Search local notes" });
  await searchInput.fill("composition token");
  await expect(page.getByTestId("search-result")).toHaveCount(2);
  const selectedResult = page.locator('.search-result[data-selected="true"]');
  await expect(selectedResult).toContainText("Composition 1");

  await searchInput.dispatchEvent("compositionstart");
  await searchInput.press("ArrowDown");
  await searchInput.press("Enter");
  await expect(selectedResult).toContainText("Composition 1");
  await expect(searchInput).toBeVisible();
  await expect(page).not.toHaveURL(/#session=composition-seeded-/);

  await searchInput.dispatchEvent("compositionend");
  await searchInput.press("ArrowDown");
  await expect(selectedResult).toContainText("Composition 0");
  await searchInput.press("Enter");
  await expect(page).toHaveURL(/#session=composition-seeded-0$/);
});

test("delete removes an extra session and returns to the original note", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.fill("keep the original note");
  await waitForAuthority(page, "keep the original note");

  await editor.press("End");
  await editor.press("Enter");
  await editor.type("/new");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#session=[a-zA-Z0-9_-]+$/);
  const sessionUrl = page.url();
  const scopedId = new URL(sessionUrl).hash.replace("#session=", "");
  const newEditor = page.getByRole("textbox", { name: "lab local-only Markdown note" });
  await expect(newEditor).toHaveAttribute("contenteditable", "true", { timeout: 15000 });
  await newEditor.fill("doomed session note");
  await expect.poll(() => page.evaluate((scopedKey) => {
    return JSON.parse(localStorage.getItem(scopedKey) ?? "null")?.markdown?.trim() ?? null;
  }, `lab.document.v2.${scopedId}`), { timeout: 15000 }).toBe("doomed session note");

  await newEditor.press("End");
  await newEditor.press("Enter");
  await newEditor.type("/name");
  await page.keyboard.press("Enter");
  const nameInput = page.getByLabel("Session name");
  await nameInput.fill("Doomed");
  await nameInput.press("Enter");
  await expect(nameInput).toBeHidden();

  await newEditor.press("End");
  await newEditor.press("Enter");
  await newEditor.type("/delete");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("confirm-delete")).toBeVisible();
  await page.keyboard.press("Enter");

  await expect(page).not.toHaveURL(/#session=/);
  const restored = page.getByRole("textbox", { name: "lab local-only Markdown note" });
  await expect(restored).toHaveAttribute("contenteditable", "true", { timeout: 15000 });
  await expect(restored).toContainText("keep the original note");
  await expect.poll(() => page.evaluate((scopedKey) => localStorage.getItem(scopedKey), `lab.document.v2.${scopedId}`)).toBeNull();
  await expect.poll(() => page.evaluate((sessionKey) => localStorage.getItem(sessionKey), `lab.session.v1.${scopedId}`)).toBeNull();
  await expect.poll(() => page.evaluate(async ({ scopedAuthority, scopedDeleted }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("lab-private-vault");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<{ authority: unknown; deleted: unknown }>((resolve, reject) => {
        const transaction = database.transaction("documents", "readonly");
        const store = transaction.objectStore("documents");
        const authorityRequest = store.get(scopedAuthority);
        const deletedRequest = store.get(scopedDeleted);
        transaction.oncomplete = () => resolve({
          authority: authorityRequest.result ?? null,
          deleted: deletedRequest.result ?? null,
        });
        transaction.onerror = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  }, { scopedAuthority: `authority:${scopedId}`, scopedDeleted: `deleted:${scopedId}` })).toEqual({
    authority: null,
    deleted: expect.objectContaining({ recordVersion: 1 }),
  });
  await expect.poll(() => page.evaluate((tombstone) => localStorage.getItem(tombstone), `lab.document.deleted.v1.${scopedId}`)).not.toBeNull();

  await restored.press("End");
  await restored.press("Enter");
  await restored.type("/sessions");
  await page.keyboard.press("Enter");
  const sessionList = page.getByTestId("session-list");
  await expect(sessionList).toContainText("keep the original note");
  await expect(sessionList).not.toContainText("Doomed");
});

test("browser back and forward rebind the active document from the URL hash", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.fill("home note");
  await waitForAuthority(page, "home note");

  await editor.press("End");
  await editor.press("Enter");
  await editor.type("/new");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#session=[a-zA-Z0-9_-]+$/);
  const sessionUrl = page.url();
  const scopedId = new URL(sessionUrl).hash.replace("#session=", "");
  const sessionEditor = page.getByRole("textbox", { name: "lab local-only Markdown note" });
  await expect(sessionEditor).toHaveAttribute("contenteditable", "true", { timeout: 15000 });
  await sessionEditor.fill("branch note");
  await expect.poll(() => page.evaluate((scopedKey) => {
    return JSON.parse(localStorage.getItem(scopedKey) ?? "null")?.markdown?.trim() ?? null;
  }, `lab.document.v2.${scopedId}`), { timeout: 15000 }).toBe("branch note");

  await page.goBack();
  await expect(page).not.toHaveURL(/#session=/);
  const homeEditor = page.getByRole("textbox", { name: "lab local-only Markdown note" });
  await expect(homeEditor).toHaveAttribute("contenteditable", "true", { timeout: 15000 });
  await expect(homeEditor).toContainText("home note");

  await page.goForward();
  await expect(page).toHaveURL(sessionUrl);
  const again = page.getByRole("textbox", { name: "lab local-only Markdown note" });
  await expect(again).toHaveAttribute("contenteditable", "true", { timeout: 15000 });
  await expect(again).toContainText("branch note");
});

test("forward deletion next to a slash query remains undoable", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.type("/abc");
  await editor.evaluate((element) => {
    const text = element.querySelector("p")?.firstChild;
    if (!text) throw new Error("Expected an editor text node.");
    const range = document.createRange();
    range.setStart(text, 1);
    range.collapse(true);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    (element as HTMLElement).focus();
    document.dispatchEvent(new Event("selectionchange"));
  });
  await expect(page.locator("#slash-command-palette")).toBeVisible();

  await editor.press("Delete");
  await expect(editor).toHaveText("/bc");
  await editor.press("ControlOrMeta+z");
  await expect(editor).toHaveText("/abc");
});

test("modified backward deletion keeps native behavior while typing a slash command", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.type("/inline-math");
  await expect(page.locator("#slash-command-palette")).toBeVisible();

  await editor.press("Alt+Backspace");
  await expect(editor).toHaveText("/inline-");
  await expect(page.locator("#slash-command-palette")).toBeVisible();

  await editor.press("Meta+Backspace");
  await expect(editor).toHaveText("");
  await expect(page.locator("#slash-command-palette")).toBeHidden();
});

test("table cell selection overlays are anchored to their cells", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.fill("/table");
  await expect(page.locator("#slash-command-palette")).toBeVisible();
  await page.keyboard.press("Enter");

  const firstCell = editor.locator("th, td").first();
  await expect(firstCell).toBeVisible();
  expect(await firstCell.evaluate((cell) => getComputedStyle(cell).position)).toBe("relative");
});

test("equation shortcut leaves code blocks unchanged", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.fill("/code");
  await expect(page.locator("#slash-command-palette")).toBeVisible();
  await page.keyboard.press("Enter");
  await editor.type("const value = 1;");

  await editor.press("ControlOrMeta+Shift+e");

  await expect(editor.locator("pre code")).toHaveText("const value = 1;");
  await expect(editor.locator('[data-type="inline-math"]')).toHaveCount(0);
});

test("inline and block equations render, edit, and survive reload", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.click();
  await editor.type("Euler: $$e^{i\\pi}+1=0$$");
  await expect(editor.locator('[data-type="inline-math"]')).toHaveCount(1);
  await expect(editor.locator('[data-type="inline-math"]')).toHaveAttribute("data-latex", "e^{i\\pi}+1=0");

  await editor.press("End");
  await editor.press("Enter");
  await editor.type("/math");
  await expect(page.locator("#slash-command-palette")).toContainText("Block equation");
  await page.keyboard.press("Enter");
  await expect(page.locator("#math-editor-popover")).toBeVisible();
  const mathInput = page.locator("#math-editor-popover-input");
  await mathInput.fill("\\frac{a}{b}");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(editor.locator('[data-type="block-math"]')).toHaveCount(1);
  await expect(editor.locator('[data-type="block-math"]')).toHaveAttribute("data-latex", "\\frac{a}{b}");

  await expect.poll(async () => (await backendState(page)).authority?.snapshot.markdown ?? "", { timeout: 15000 }).toContain("$$");
  await page.reload();
  await openEditor(page);
  await expect(page.locator('[data-type="inline-math"]')).toHaveAttribute("data-latex", "e^{i\\pi}+1=0");
  await expect(page.locator('[data-type="block-math"]')).toHaveAttribute("data-latex", "\\frac{a}{b}");
});

test("the inline equation slash command inserts an editable inline formula", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.type("Value: /inline");
  await expect(page.locator("#slash-command-palette")).toContainText("Inline equation");
  await page.keyboard.press("Enter");

  const input = page.locator("#math-editor-popover-input");
  await expect(input).toBeVisible();
  await input.fill("x^2");
  await input.press("Enter");

  await expect(editor.locator('[data-type="inline-math"]')).toHaveAttribute("data-latex", "x^2");
  await expect(editor).toContainText("Value:");
  await editor.type(" units");
  await expect(editor.locator('[data-type="inline-math"]')).toHaveAttribute("data-latex", "x^2");
  await expect(editor).toContainText("units");
});

test("switching equations commits the previous draft", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.click();
  await editor.type("A $$x^2$$ B $$y^2$$");

  const math = editor.locator('[data-type="inline-math"]');
  await math.nth(0).click();
  await page.locator("#math-editor-popover-input").fill("a^2");
  await math.nth(1).click();

  await expect(math.nth(0)).toHaveAttribute("data-latex", "a^2");
  await expect(page.locator("#math-editor-popover-input")).toHaveValue("y^2");
  await page.locator("#math-editor-popover-input").press("Escape");
});

test("pasted math delimiters become editable math nodes", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.click();
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", "$$x^2 + y^2$$");
    document.querySelector('[contenteditable="true"]')?.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }));
  });
  await expect(editor.locator('[data-type="inline-math"]')).toHaveAttribute("data-latex", "x^2 + y^2");
});

test("deleting text can expose inline math delimiters", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.click();
  await editor.type("$a$x$$");
  await expect(editor).toHaveText("$a$x$$");

  await editor.evaluate((element) => {
    const text = element.querySelector("p")?.firstChild;
    if (!(text instanceof Text)) throw new Error("The test paragraph has no text node.");
    const selection = window.getSelection();
    if (!selection) throw new Error("The browser has no selection.");
    const range = document.createRange();
    range.setStart(text, 1);
    range.setEnd(text, 2);
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await editor.press("Backspace");

  await expect(editor.locator('[data-type="inline-math"]')).toHaveAttribute("data-latex", "x");
});

test("escaped-dollar LaTeX survives persistence and reload", async ({ page }) => {
  const editor = await openEditor(page);
  const markdown = "Price: $$\\$5$$";
  await editor.click();
  await editor.type(markdown);

  const math = editor.locator('[data-type="inline-math"]');
  await expect(math).toHaveAttribute("data-latex", "\\$5");
  await waitForAuthority(page, markdown);

  await page.reload();
  await openEditor(page);
  await expect(page.locator('[data-type="inline-math"]')).toHaveAttribute("data-latex", "\\$5");
});

test("Markdown import restores inline and block equations", async ({ page }) => {
  const editor = await openEditor(page);
  const markdown = "Price: $$\\$5$$\n\n$$\n\\int_0^1 x\\,dx\n$$";
  await page.locator('input[type="file"][accept*="markdown"]').setInputFiles({
    name: "equations.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(markdown),
  });

  await expect(editor.locator('[data-type="inline-math"]')).toHaveAttribute("data-latex", "\\$5");
  await expect(editor.locator('[data-type="block-math"]')).toHaveAttribute("data-latex", "\\int_0^1 x\\,dx");
  await expect.poll(
    async () => (await backendState(page)).authority?.snapshot.markdown ?? "",
    { timeout: 15000, intervals: [50, 100, 250, 500] },
  ).toContain(markdown);
});

test("cancelled equation drafts stay out of undo history and reopen from the keyboard", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.click();
  await editor.type("Result: $$x^2$$");
  await editor.press("End");
  await page.waitForTimeout(600);
  await editor.type("!");

  const math = editor.locator('[data-type="inline-math"]');
  await math.click();
  const input = page.locator("#math-editor-popover-input");
  await input.fill("y^2");
  await input.press("Escape");
  await expect(math).toHaveAttribute("data-latex", "x^2");

  await editor.press("Enter");
  await expect(page.locator("#math-editor-popover")).toBeVisible();
  await page.locator("#math-editor-popover-input").press("Escape");

  await editor.press("ControlOrMeta+z");
  await expect(math).toHaveAttribute("data-latex", "x^2");
  await expect(editor).not.toContainText("!");
  await expect(editor.locator('[data-type="inline-math"][data-latex="y^2"]')).toHaveCount(0);
});

test("cancelling a new block equation does not leave an undoable placeholder", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.click();
  await editor.type("/math");
  await expect(page.locator("#slash-command-palette")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator("#math-editor-popover")).toBeVisible();

  await page.locator("#math-editor-popover-input").press("Escape");
  await expect(editor.locator('[data-type="block-math"]')).toHaveCount(0);
  await editor.press("ControlOrMeta+z");
  await expect(editor.locator('[data-type="block-math"]')).toHaveCount(0);
});

test("editing the middle of a formula keeps the caret position", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.click();
  await editor.type("Value: $$x^2$$");
  await editor.locator('[data-type="inline-math"]').click();

  const input = page.locator("#math-editor-popover-input");
  await expect(input).toBeFocused();
  await page.waitForTimeout(100);
  await input.evaluate((element) => {
    const field = element as HTMLInputElement;
    field.focus();
    field.setSelectionRange(1, 1);
  });
  await input.press("a");
  await page.waitForTimeout(100);
  await input.press("b");
  await expect(input).toHaveValue("xab^2");
  await input.press("Escape");
});

test("invalid LaTeX is exposed through the math editor live status", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.click();
  await editor.type("A $$x^2$$");
  await editor.locator('[data-type="inline-math"]').click();

  const input = page.locator("#math-editor-popover-input");
  await input.fill("\\notacommand");
  await expect(input).toHaveAttribute("aria-invalid", "true");

  const status = page.getByTestId("math-editor-status");
  await expect(status).toHaveAttribute("role", "status");
  await expect(status).toHaveAttribute("aria-live", "polite");
  await expect(status).toHaveAttribute("data-error", "true");
  await expect(status).toContainText("could not be parsed");
  await input.press("Escape");
});

test("the app remains durable when OPFS is unavailable at the browser boundary", async ({ context, page }) => {
  await context.addInitScript(() => {
    try {
      Object.defineProperty(Object.getPrototypeOf(navigator.storage), "getDirectory", {
        configurable: true,
        value: undefined,
      });
    } catch {
      // The integration matrix covers unavailable APIs when the browser object is non-configurable.
    }
  });
  const editor = await openEditor(page);
  await editor.fill("without opfs");
  await waitForAuthority(page, "without opfs");
  await page.reload();
  await openEditor(page);
  await expect.poll(() => editorText(page), { timeout: 10000 }).toBe("without opfs");
});

test("Chromium quota override fails closed or degrades safely, then self-heals after reset", async ({ context, page }) => {
  const editor = await openEditor(page);
  const origin = new URL(page.url()).origin;
  const cdp = await context.newCDPSession(page);
  try {
    await cdp.send("Storage.overrideQuotaForOrigin", { origin, quotaSize: 1 });
    const quota = await cdp.send("Storage.getUsageAndQuota", { origin });
    expect(quota.overrideActive).toBe(true);
    expect(quota.quota).toBe(1);

    const markdown = "quota recovery draft";
    await editor.fill(markdown);
    const saveNotice = page.getByTestId("editor-notice");
    await expect(saveNotice).toContainText(
      /could not be saved locally|one or more local copies could not be updated/,
      { timeout: 15000 },
    );
    await expect(saveNotice).toHaveAttribute("role", "alert");
    await expect(saveNotice).toHaveAttribute("aria-live", "assertive");

    const constrained = await backendState(page);
    if (constrained.authority) {
      // Chromium 151 can exempt IndexedDB authority from the tiny origin quota
      // while still rejecting a replica. The accepted authority must be intact.
      expect(constrained.authority.snapshot.markdown).toBe(markdown);
    } else {
      // Older Chromium revisions apply the override to authority as well. That
      // path must fail closed and retain a verified staged recovery draft.
      await expect.poll(
        () => page.evaluate((prefix) => Object.keys(localStorage).some((key) => key.startsWith(prefix)), PENDING_PREFIX),
        { timeout: 5000 },
      ).toBe(true);
    }

    await cdp.send("Storage.overrideQuotaForOrigin", { origin });
    await page.reload();
    await openEditor(page);
    await expect.poll(() => editorText(page), { timeout: 10000 }).toBe(markdown);
    const recovered = await backendState(page);
    expect(recovered.authority?.snapshot.markdown).toBe(markdown);
    expect(recovered.current?.markdown).toBe(markdown);
    expect(recovered.local?.markdown).toBe(markdown);
  } finally {
    await cdp.send("Storage.overrideQuotaForOrigin", { origin }).catch(() => undefined);
  }
});
