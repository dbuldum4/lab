import { expect, type Page } from "@playwright/test";

export const LOCAL_KEY = "lab.document.v1";
export const PENDING_PREFIX = "lab.document.pending.v2.";

export type Snapshot = {
  markdown: string;
  updatedAt: number;
  checksum: string;
  version: number;
};

export type BackendState = {
  local: Snapshot | null;
  authority: { revision: number; snapshot: Snapshot } | null;
  current: Snapshot | null;
  opfs: Snapshot | null;
  opfsSupported: boolean;
};

export async function openEditor(page: Page) {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "lab local-only Markdown note" });
  await expect(editor).toBeVisible();
  await expect(editor).toHaveAttribute("contenteditable", "true", { timeout: 15000 });
  return editor;
}

/** Accessible name comes from the confirmation title, which includes the filename. */
export function markdownImportDialog(page: Page) {
  return page.getByRole("alertdialog", { name: /Replace this note with/ });
}

/** Confirm a destructive Markdown replacement in happy-path import helpers. */
export async function confirmMarkdownImport(page: Page) {
  const dialog = markdownImportDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Import file" }).click();
  await expect(dialog).toBeHidden();
}

export async function backendState(page: Page): Promise<BackendState> {
  return page.evaluate(async ({ localKey }) => {
    const parse = (raw: string | null) => (raw ? JSON.parse(raw) as Snapshot : null);
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

export async function waitForAuthority(page: Page, markdown: string | RegExp) {
  if (typeof markdown === "string") {
    await expect.poll(
      async () => (await backendState(page)).authority?.snapshot.markdown ?? null,
      { timeout: 15000, intervals: [50, 100, 250, 500] },
    ).toBe(markdown);
    return;
  }

  await expect.poll(
    async () => (await backendState(page)).authority?.snapshot.markdown ?? "",
    { timeout: 15000, intervals: [50, 100, 250, 500] },
  ).toMatch(markdown);
}

export async function editorText(page: Page) {
  return page.getByRole("textbox", { name: "lab local-only Markdown note" }).textContent();
}

export async function pendingRecords(page: Page) {
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
