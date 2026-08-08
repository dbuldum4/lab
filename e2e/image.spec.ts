import { expect, test } from "@playwright/test";
import { openEditor, waitForAuthority } from "./helpers";

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
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });

  const img = editor.locator("img.lab-image");
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute("alt", "dropped");
  await expect(img).toHaveAttribute("src", /data:image\/png;base64,/);

  await waitForAuthority(page, /!\[dropped\]\(data:image\/png;base64,/);
});

test("dropping an image inserts at the pointer, not the caret", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.click();
  await page.keyboard.type("AAAA");
  await page.keyboard.press("Enter");
  await page.keyboard.type("BBBB");
  // Caret remains at the end of BBBB. Drop onto the first paragraph instead.
  const firstBox = await editor.locator("p").first().boundingBox();
  if (!firstBox) throw new Error("First paragraph bounding box not available");

  await editor.evaluate((node, coords) => {
    const buffer = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const file = new File([buffer], "drop-pos.png", { type: "image/png" });
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
  }, { x: firstBox.x + Math.min(24, firstBox.width / 2), y: firstBox.y + firstBox.height / 2 });

  await expect(editor.locator("img.lab-image")).toBeVisible();
  // Image must appear before the BBBB paragraph (drop target was AAAA, caret was at BBBB).
  // Without posAtCoords the image would land after BBBB.
  await expect.poll(async () => {
    return editor.evaluate((node) => {
      const blocks = Array.from(node.querySelectorAll(":scope > *")).map((el) => {
        if (el.tagName === "IMG") return "img";
        if (el.tagName === "P") {
          const text = el.textContent ?? "";
          return text.length === 0 || text === "\u200B" ? "p:empty" : `p:${text}`;
        }
        return el.tagName.toLowerCase();
      });
      return {
        imgIndex: blocks.indexOf("img"),
        bbbbIndex: blocks.findIndex((b) => b.includes("BBBB")),
        hasA: blocks.some((b) => b.includes("A")),
      };
    });
  }).toEqual(expect.objectContaining({
    hasA: true,
  }));

  const layout = await editor.evaluate((node) => {
    const blocks = Array.from(node.querySelectorAll(":scope > *")).map((el) => {
      if (el.tagName === "IMG") return "img";
      if (el.tagName === "P") {
        const text = el.textContent ?? "";
        return text.length === 0 || text === "\u200B" ? "p:empty" : `p:${text}`;
      }
      return el.tagName.toLowerCase();
    });
    return {
      imgIndex: blocks.indexOf("img"),
      bbbbIndex: blocks.findIndex((b) => b.includes("BBBB")),
    };
  });
  expect(layout.imgIndex).toBeGreaterThanOrEqual(0);
  expect(layout.bbbbIndex).toBeGreaterThanOrEqual(0);
  expect(layout.imgIndex).toBeLessThan(layout.bbbbIndex);
});

test("multiple images do not add blank paragraphs between images", async ({ page }) => {
  const editor = await openEditor(page);
  await page.locator('input[type="file"][accept*="image/*"]').setInputFiles([
    pngFile("one.png"),
    pngFile("two.png"),
  ]);

  await expect(editor.locator("img.lab-image")).toHaveCount(2);
  await expect.poll(async () => {
    return editor.evaluate((node) => Array.from(node.querySelectorAll(":scope > *")).map((element) => {
      if (element.tagName === "IMG") return "img";
      if (element.tagName === "P") {
        const text = element.textContent ?? "";
        return text.length === 0 || text === "\u200B" ? "p:empty" : `p:${text}`;
      }
      return element.tagName.toLowerCase();
    }));
  }).toEqual(["img", "img", "p:empty"]);
});

test("pasting an image mid-paragraph does not insert a blank paragraph", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.click();
  await page.keyboard.type("Hello world!");
  // Place the caret after "Hello " (6 chars from start of the textblock).
  await editor.evaluate((node) => {
    const selection = window.getSelection();
    const textNode = node.querySelector("p")?.firstChild;
    if (!selection || !textNode || textNode.nodeType !== Node.TEXT_NODE) {
      throw new Error("Expected a text node inside the editor paragraph");
    }
    const range = document.createRange();
    range.setStart(textNode, 6);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  });

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

  await expect(editor.locator("img.lab-image")).toBeVisible();
  // Expect: <p>Hello </p><img>...<p>world!</p> — no empty paragraph between image and trailing text.
  await expect.poll(async () => {
    return editor.evaluate((node) => {
      const blocks = Array.from(node.querySelectorAll(":scope > *")).map((el) => {
        if (el.tagName === "IMG") return "img";
        if (el.tagName === "P") {
          const text = el.textContent ?? "";
          return text.length === 0 || text === "\u200B" ? "p:empty" : `p:${text}`;
        }
        return el.tagName.toLowerCase();
      });
      return blocks;
    });
  }).toEqual(["p:Hello ", "img", "p:world!"]);

  await waitForAuthority(page, /Hello\s*\n\n!\[pasted\]\(data:image\/png;base64,[^)]+\)\s*\n\nworld!/);
});

test("oversized images are rejected with a notice", async ({ page }) => {
  const editor = await openEditor(page);
  // Build the oversized File in the page so size is exact and we avoid multi-MB IPC payload flakiness.
  await page.locator('input[type="file"][accept*="image/*"]').evaluate((input) => {
    const file = new File([new Uint8Array(1_500_001)], "huge.png", { type: "image/png" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const element = input as HTMLInputElement;
    element.files = transfer.files;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });

  await expect(page.locator(".editor-notice")).toContainText(/too large to store locally/i, {
    timeout: 10000,
  });
  await expect(editor.locator("img.lab-image")).toHaveCount(0);
});

test("rich HTML with a remote image URL does not insert a broken image", async ({ page }) => {
  const editor = await openEditor(page);

  await editor.evaluate((node) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/html", '<p>See <img src="https://example.com/remote.png" alt="remote"></p>');
    dataTransfer.setData("text/plain", "See ");
    node.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer,
      }),
    );
  });

  await expect(editor.locator("img")).toHaveCount(0);
  await expect(editor.locator('img[src*="example.com"]')).toHaveCount(0);
});

test("typed remote image Markdown does not create an image", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.click();
  await page.keyboard.type("![remote](https://example.com/remote.png)");

  await expect(editor.locator("img")).toHaveCount(0);
});

test("image alt with special characters is escaped in Markdown export", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.type("/image");
  await page.keyboard.press("Enter");
  await page.locator('input[type="file"][accept*="image/*"]').setInputFiles(pngFile("a]b.png"));

  const img = editor.locator("img.lab-image");
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute("alt", "a]b");

  await waitForAuthority(page, /!\[a\\\]b\]\(data:image\/png;base64,/);
});
