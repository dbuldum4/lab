import { expect, test, type Page } from "@playwright/test";

const LOCAL_KEY = "lab.document.v1";
const PENDING_PREFIX = "lab.document.pending.v2.";

type Snapshot = {
  markdown: string;
  updatedAt: number;
  checksum: string;
  version: number;
};

type BackendState = {
  local: Snapshot | null;
  authority: { revision: number; snapshot: Snapshot } | null;
  current: Snapshot | null;
  opfs: Snapshot | null;
  opfsSupported: boolean;
};

async function openEditor(page: Page) {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "lab local-only Markdown note" });
  await expect(editor).toBeVisible();
  await expect(editor).toHaveAttribute("contenteditable", "true", { timeout: 15000 });
  return editor;
}

async function backendState(page: Page): Promise<BackendState> {
  return page.evaluate(async ({ localKey }) => {
    const parse = (raw: string | null) => raw ? JSON.parse(raw) as Snapshot : null;
    const local = parse(localStorage.getItem(localKey));
    let authority: { revision: number; snapshot: Snapshot } | null = null;
    let current: Snapshot | null = null;
    try {
      const db = await new Promise<IDBDatabase | null>((resolve) => {
        const request = indexedDB.open("lab-private-vault");
        request.onerror = () => resolve(null);
        request.onsuccess = () => resolve(request.result);
      });
      if (db) {
        const state = await new Promise<{ authority: unknown; current: unknown }>((resolve, reject) => {
          const transaction = db.transaction("documents", "readonly");
          const store = transaction.objectStore("documents");
          let authorityRaw: unknown;
          let currentRaw: unknown;
          const authorityRequest = store.get("authority");
          const currentRequest = store.get("current");
          authorityRequest.onsuccess = () => { authorityRaw = authorityRequest.result; };
          currentRequest.onsuccess = () => { currentRaw = currentRequest.result; };
          transaction.oncomplete = () => resolve({ authority: authorityRaw, current: currentRaw });
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
        });
        authority = (state.authority ?? null) as typeof authority;
        current = (state.current ?? null) as Snapshot | null;
        db.close();
      }
    } catch {
      // The test records absence as null; integration tests cover fault details.
    }

    let opfs: Snapshot | null = null;
    let opfsSupported = false;
    try {
      const root = await navigator.storage.getDirectory();
      opfsSupported = true;
      const handle = await root.getFileHandle("lab.md.snapshot");
      opfs = JSON.parse(await (await handle.getFile()).text()) as Snapshot;
    } catch {
      // Not-found and unsupported OPFS are both represented as null.
    }
    return { local, authority, current, opfs, opfsSupported };
  }, { localKey: LOCAL_KEY });
}

async function waitForAuthority(page: Page, markdown: string) {
  await expect.poll(
    async () => (await backendState(page)).authority?.snapshot.markdown ?? null,
    { timeout: 15000, intervals: [50, 100, 250, 500] },
  ).toBe(markdown);
}

async function editorText(page: Page) {
  return page.getByRole("textbox", { name: "lab local-only Markdown note" }).textContent();
}

async function pendingRecords(page: Page) {
  return page.evaluate(async ({ prefix }) => {
    const records = Object.keys(localStorage)
      .filter((key) => key.startsWith(prefix))
      .map((storageKey) => ({ storageKey, ...JSON.parse(localStorage.getItem(storageKey) ?? "null") }));
    return Promise.all(records.map(async (record) => {
      const bytes = new TextEncoder().encode(JSON.stringify(["lab.snapshot.v2", record.updatedAt, record.markdown]));
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const checksum = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      return { ...record, snapshotChecksum: checksum };
    }));
  }, { prefix: PENDING_PREFIX });
}

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

test("a staged draft survives a renderer crash and a new session owner", async ({ context, page }) => {
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
  const beforeCrash = await backendState(page);
  expect(beforeCrash.authority).toBeNull();

  await page.goto("chrome://crash").catch(() => undefined);
  const reopened = await context.newPage();
  await openEditor(reopened);
  await expect.poll(() => editorText(reopened), { timeout: 10000 }).toBe(draft);
  await reopened.close();
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

test("Chromium quota override blocks authority writes but staged content recovers after reset", async ({ context, page }) => {
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
    await expect(page.getByRole("status")).toContainText("could not be saved locally", { timeout: 15000 });
    expect((await backendState(page)).authority).toBeNull();
    await expect.poll(
      () => page.evaluate((prefix) => Object.keys(localStorage).some((key) => key.startsWith(prefix)), PENDING_PREFIX),
      { timeout: 5000 },
    ).toBe(true);

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
