import { expect, test, type Page } from "@playwright/test";

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
  return page.evaluate(async () => {
    const parse = (raw: string | null) => (raw ? JSON.parse(raw) as Snapshot : null);
    const local = parse(localStorage.getItem("lab.document.v1"));
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
      // Not-found and unsupported IndexedDB are represented as null.
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
  });
}

async function waitForAuthority(page: Page, markdownPattern: RegExp) {
  await expect.poll(
    async () => (await backendState(page)).authority?.snapshot.markdown ?? "",
    { timeout: 15000, intervals: [50, 100, 250, 500] },
  ).toMatch(markdownPattern);
}

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function pngFile(name = "red.png") {
  return {
    name,
    mimeType: "image/png",
    buffer: Buffer.from(PNG_BASE64, "base64"),
  };
}

test("the /image slash command inserts a base64 image", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.type("/image");
  await expect(page.locator("#slash-command-palette")).toContainText("Image");
  await page.keyboard.press("Enter");

  await page.locator('input[type="file"][accept*="image/*"]').setInputFiles(pngFile());

  const img = editor.locator("img.lab-image");
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute("alt", "red");
  await expect(img).toHaveAttribute("src", /data:image\/png;base64,/);

  await waitForAuthority(page, /!\[red\]\(data:image\/png;base64,/);
});

test("pasting an image file inserts a base64 image", async ({ page }) => {
  const editor = await openEditor(page);

  await editor.evaluate((node) => {
    const buffer = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const file = new File([buffer], "pasted.png", { type: "image/png" });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    node.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer,
      }),
    );
  });

  const img = editor.locator("img.lab-image");
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute("alt", "pasted");
  await expect(img).toHaveAttribute("src", /data:image\/png;base64,/);

  await waitForAuthority(page, /!\[pasted\]\(data:image\/png;base64,/);
});

test("dropping an image file inserts a base64 image", async ({ page }) => {
  const editor = await openEditor(page);
  const box = await editor.boundingBox();
  if (!box) throw new Error("Editor bounding box not available");

  await editor.evaluate((node, coords) => {
    const buffer = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const file = new File([buffer], "dropped.png", { type: "image/png" });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    node.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        clientX: coords.x,
        clientY: coords.y,
        dataTransfer,
      }),
    );
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2 })

  const img = editor.locator("img.lab-image");
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute("alt", "dropped");
  await expect(img).toHaveAttribute("src", /data:image\/png;base64,/);

  await waitForAuthority(page, /!\[dropped\]\(data:image\/png;base64,/);
});
